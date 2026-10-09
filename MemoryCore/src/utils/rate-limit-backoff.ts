/**
 * Rate-limit aware backoff helpers.
 *
 * 背景（2026-10-07 实测）：智谱免费档在自动化蒸馏负载下返回两类限流——
 *   ①"该模型当前访问量过大"（HTTP 429，高峰拥堵，重试可过）
 *   ②"您的账户已达到速率限制"（账户级，连续快速重试只会继续被拒）
 * AI SDK 内置重试（provider-utils）默认 3 连发，8 秒内打完，对限流毫无意义；
 * pipeline-worker 的 5s×3^n 退避对账户级限流也太短。
 * 本模块提供统一的「判定 + 延迟计算」纯函数，供 runner 层与 worker 层共用。
 */

/** 判定错误信息是否为限流类（429 / rate limit / 速率限制 / 访问量过大）。 */
export function isRateLimitError(msg: string): boolean {
  return /rate.?limit|429|too many requests|速率限制|访问量过大|请求频率/i.test(String(msg ?? ""));
}

/**
 * Runner 层单次限流退避：基数 20s，指数递增（20s → 40s → 80s）。
 * attempt 从 0 计（第几次重试前的等待）。
 */
export function computeRateLimitDelayMs(attempt: number, baseMs = 20_000): number {
  return baseMs * Math.pow(2, Math.max(0, attempt));
}

export interface WorkerRetryDelayOpts {
  /** 非限流错误的指数退避基数（与 pipeline-worker 既有 retryBaseDelayMs 一致，默认 5s）。 */
  baseMs?: number;
  /** 限流错误的长退避基数，线性递增（默认 120s → 240s → 360s）。 */
  rateLimitBaseMs?: number;
}

/**
 * Worker 层任务重试延迟：
 * - 限流错误 → rateLimitBaseMs × (retryCount+1)，线性拉长（2min/4min/6min）
 * - 其他错误 → baseMs × 3^retryCount（保持既有 5s/15s/45s 行为不变）
 */
export function computeWorkerRetryDelayMs(retryCount: number, errMsg: string, opts?: WorkerRetryDelayOpts): number {
  const baseMs = opts?.baseMs ?? 5_000;
  const rateLimitBaseMs = opts?.rateLimitBaseMs ?? 120_000;
  const rc = Math.max(0, retryCount);
  if (isRateLimitError(errMsg)) {
    return rateLimitBaseMs * (rc + 1);
  }
  return baseMs * Math.pow(3, rc);
}

/** 可中断的 sleep：signal abort 时立即拒绝（不吞锁丢失信号）。 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted before sleep"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted during rate-limit backoff"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RateLimitRetryOpts {
  /** 限流错误的最大额外重试次数（总尝试 = 1 + maxRetries）。默认 1。 */
  maxRetries?: number;
  /** 限流退避基数 ms，指数递增（默认 20s → 40s → …）。 */
  baseMs?: number;
  /**
   * 整个调用的硬期限 ms（默认 180s）。
   *
   * 背景（2026-10-09 生产事故）：上游（智谱免费档拥堵 / Go 端点不可用）可能让单次
   * HTTP 请求**无限期挂起**，且实测 AbortSignal.timeout 的 per-attempt 超时未能生效——
   * 任务在持锁状态下挂了 4.5 小时，后续任务全部被 worker 以锁冲突丢弃。
   * 本期限用 Promise.race 兜底：**无论上游如何挂起，函数必然在期限内返回**。
   * 竞速失败（deadline 先到）时抛 DeadlineError，由上层按普通失败走
   * l1-deferred / worker 重试——释放锁之后的重试是安全的。
   */
  deadlineMs?: number;
}

/** 硬期限命中时抛出的错误（message 带 deadline 便于日志定位）。 */
export class RateLimitDeadlineError extends Error {
  constructor(deadlineMs: number, lastErrMsg?: string) {
    super(
      `LLM call exceeded overall deadline (${deadlineMs}ms)` +
      (lastErrMsg ? `; last error: ${lastErrMsg}` : " (request hung with no response)"),
    );
    this.name = "RateLimitDeadlineError";
  }
}

/**
 * 限流感知的执行包装：
 * - 限流错误（isRateLimitError）→ 指数退避后重试，至多 maxRetries 次
 * - 非限流错误 → 立即抛出（由 worker 层的重试/退避接管）
 * - 每次尝试与退避都受 overall deadline 硬顶，到点抛 RateLimitDeadlineError
 * - signal abort（worker 锁丢失/任务取消）随时立即中止
 */
export async function runWithRateLimitRetry<T>(
  generate: () => Promise<T>,
  opts: RateLimitRetryOpts = {},
  signal?: AbortSignal,
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 1;
  const baseMs = opts.baseMs ?? 20_000;
  const deadlineMs = opts.deadlineMs ?? 180_000;
  const deadlineAt = Date.now() + deadlineMs;
  let lastErrMsg: string | undefined;

  for (let attempt = 0; ; attempt++) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      throw new RateLimitDeadlineError(deadlineMs, lastErrMsg);
    }

    let attemptResult: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      // 硬期限竞速：即使 abort 传播失效、上游永不响应，也必然在 remaining 内返回
      attemptResult = { ok: true, value: await Promise.race([
        generate(),
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new RateLimitDeadlineError(deadlineMs, lastErrMsg)), remaining);
          if (typeof (t as { unref?: () => void }).unref === "function") (t as { unref(): void }).unref();
          signal?.addEventListener("abort", () => reject(new Error("aborted during LLM call")), { once: true });
        }),
      ]) } as { ok: true; value: T };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/^LLM call exceeded overall deadline/.test(msg) || /aborted during LLM call/.test(msg)) throw err;
      lastErrMsg = msg;
      attemptResult = { ok: false, error: err };
    }

    if (attemptResult.ok) return attemptResult.value;

    const errMsg = attemptResult.error instanceof Error ? attemptResult.error.message : String(attemptResult.error);
    if (attempt < maxRetries && isRateLimitError(errMsg)) {
      const delay = computeRateLimitDelayMs(attempt, baseMs);
      await abortableSleep(Math.min(delay, deadlineAt - Date.now()), signal);
      continue;
    }
    throw attemptResult.error;
  }
}
