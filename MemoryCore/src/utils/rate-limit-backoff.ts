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
