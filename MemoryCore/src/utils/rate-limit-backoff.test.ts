// P1（2026-10-14，v2 859d388/87f3c9b 移植）：限流判定 + 退避 + 整调用硬期限。
// 关键语义：并发限额拒绝（concurrency reached）归类限流（幽灵请求窗口）；
// 限流错误指数退避重试至多 maxRetries；非限流立即上抛；deadline 硬顶挂死调用。
import { describe, it, expect } from "vitest";
import {
  isRateLimitError,
  computeRateLimitDelayMs,
  computeWorkerRetryDelayMs,
  runWithRateLimitRetry,
  RateLimitDeadlineError,
} from "./rate-limit-backoff.js";

describe("isRateLimitError：限流类错误判定", () => {
  it("命中 429/速率限制/访问量过大/concurrency reached 各形态", () => {
    expect(isRateLimitError("您的账户已达到速率限制，请您控制请求频率")).toBe(true);
    expect(isRateLimitError("该模型当前访问量过大，请稍后再试")).toBe(true);
    expect(isRateLimitError("HTTP 429 Too Many Requests")).toBe(true);
    expect(isRateLimitError("concurrency reached, current: 6, limit: 5")).toBe(true);
    expect(isRateLimitError("rate limit exceeded for org")).toBe(true);
  });

  it("非限流错误不误判", () => {
    expect(isRateLimitError("fetch failed: 401 Unauthorized")).toBe(false);
    expect(isRateLimitError("The operation was aborted due to timeout")).toBe(false);
    expect(isRateLimitError("no such column: content_original")).toBe(false);
  });
});

describe("延迟计算", () => {
  it("runner 层指数：20s → 40s → 80s", () => {
    expect(computeRateLimitDelayMs(0)).toBe(20_000);
    expect(computeRateLimitDelayMs(1)).toBe(40_000);
    expect(computeRateLimitDelayMs(2)).toBe(80_000);
  });

  it("worker 层：限流线性 120s×(rc+1)，其他保持既有节奏", () => {
    expect(computeWorkerRetryDelayMs(0, "429 too many")).toBe(120_000);
    expect(computeWorkerRetryDelayMs(2, "concurrency reached")).toBe(360_000);
    expect(computeWorkerRetryDelayMs(0, "boom")).toBe(5_000);
    expect(computeWorkerRetryDelayMs(2, "boom")).toBe(45_000);
  });
});

describe("runWithRateLimitRetry：限流重试与硬期限", () => {
  it("限流错误 → 退避后重试一次成功（短基数实测）", async () => {
    let attempts = 0;
    const result = await runWithRateLimitRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("429 too many requests");
        return "ok";
      },
      { maxRetries: 1, baseMs: 10, deadlineMs: 5_000 },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("非限流错误立即上抛（不烧重试）", async () => {
    let attempts = 0;
    await expect(
      runWithRateLimitRetry(
        async () => {
          attempts += 1;
          throw new Error("401 Unauthorized");
        },
        { maxRetries: 1, baseMs: 10, deadlineMs: 5_000 },
      ),
    ).rejects.toThrow("401");
    expect(attempts).toBe(1);
  });

  it("重试仍限流 → 上抛原始错误", async () => {
    let attempts = 0;
    await expect(
      runWithRateLimitRetry(
        async () => {
          attempts += 1;
          throw new Error("concurrency reached, current: 6, limit: 5");
        },
        { maxRetries: 1, baseMs: 10, deadlineMs: 5_000 },
      ),
    ).rejects.toThrow(/concurrency reached/);
    expect(attempts).toBe(2);
  });

  it("调用挂死 → deadline 硬顶必然返回（RateLimitDeadlineError）", async () => {
    await expect(
      runWithRateLimitRetry(
        () => new Promise<string>(() => {}), // 永不 resolve
        { maxRetries: 1, baseMs: 10, deadlineMs: 80 },
      ),
    ).rejects.toBeInstanceOf(RateLimitDeadlineError);
  });
});
