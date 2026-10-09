import { describe, it, expect } from "vitest";
import {
  isRateLimitError,
  computeRateLimitDelayMs,
  computeWorkerRetryDelayMs,
  runWithRateLimitRetry,
} from "./rate-limit-backoff.js";

describe("isRateLimitError", () => {
  const positives = [
    "429 Too Many Requests",
    "HTTP 429",
    "您的账户已达到速率限制，请您控制请求频率",
    "该模型当前访问量过大，请您稍后再试",
    "rate limit exceeded",
    "RateLimitError: quota",
    "Too Many Requests",
  ];
  for (const msg of positives) {
    it(`识别限流: ${msg.slice(0, 30)}`, () => {
      expect(isRateLimitError(msg)).toBe(true);
    });
  }

  const negatives = [
    "Failed after 3 attempts. Last error: Connection refused",
    "ECONNRESET",
    "timeout of 120000ms exceeded",
    "Unexpected token < in JSON",
    "401 Unauthorized: invalid api key",
    "",
  ];
  for (const msg of negatives) {
    it(`非限流不误判: ${msg.slice(0, 30)}`, () => {
      expect(isRateLimitError(msg)).toBe(false);
    });
  }
});

describe("computeRateLimitDelayMs", () => {
  it("默认基数 20s，指数递增 20/40/80", () => {
    expect(computeRateLimitDelayMs(0)).toBe(20_000);
    expect(computeRateLimitDelayMs(1)).toBe(40_000);
    expect(computeRateLimitDelayMs(2)).toBe(80_000);
  });
  it("自定义基数", () => {
    expect(computeRateLimitDelayMs(0, 5_000)).toBe(5_000);
    expect(computeRateLimitDelayMs(2, 5_000)).toBe(20_000);
  });
});

describe("computeWorkerRetryDelayMs", () => {
  it("限流错误用长基数线性递增 120/240/360", () => {
    const base = { rateLimitBaseMs: 120_000 };
    expect(computeWorkerRetryDelayMs(0, "您的账户已达到速率限制", base)).toBe(120_000);
    expect(computeWorkerRetryDelayMs(1, "429 Too Many Requests", base)).toBe(240_000);
    expect(computeWorkerRetryDelayMs(2, "rate limit", base)).toBe(360_000);
  });
  it("非限流错误保持原有 5s×3^n 指数退避", () => {
    const base = { baseMs: 5_000 };
    expect(computeWorkerRetryDelayMs(0, "ECONNRESET", base)).toBe(5_000);
    expect(computeWorkerRetryDelayMs(1, "ECONNRESET", base)).toBe(15_000);
    expect(computeWorkerRetryDelayMs(2, "ECONNRESET", base)).toBe(45_000);
  });
  it("默认参数与 worker 现行为兼容", () => {
    expect(computeWorkerRetryDelayMs(0, "ECONNRESET")).toBe(5_000);
    expect(computeWorkerRetryDelayMs(2, "ECONNRESET")).toBe(45_000);
  });
});

describe("runWithRateLimitRetry", () => {
  it("限流一次后重试成功", async () => {
    let calls = 0;
    const result = await runWithRateLimitRetry(
      () => { calls++; return calls === 1 ? Promise.reject(new Error("429 too many requests")) : Promise.resolve("ok"); },
      { maxRetries: 1, baseMs: 1, deadlineMs: 5_000 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("非限流错误立即抛出不重试", async () => {
    let calls = 0;
    await expect(
      runWithRateLimitRetry(
        () => { calls++; return Promise.reject(new Error("ECONNRESET")); },
        { maxRetries: 1, baseMs: 1, deadlineMs: 5_000 },
      ),
    ).rejects.toThrow("ECONNRESET");
    expect(calls).toBe(1);
  });

  it("重试次数耗尽抛最后限流错误", async () => {
    let calls = 0;
    await expect(
      runWithRateLimitRetry(
        () => { calls++; return Promise.reject(new Error("该模型当前访问量过大")); },
        { maxRetries: 1, baseMs: 1, deadlineMs: 5_000 },
      ),
    ).rejects.toThrow("访问量过大");
    expect(calls).toBe(2);
  });

  it("generate 永久挂起时硬期限必然返回（事故 10-09 的回归测试）", async () => {
    const hung = () => new Promise(() => { /* never settles, ignores signal */ });
    await expect(
      runWithRateLimitRetry(hung, { maxRetries: 1, baseMs: 1, deadlineMs: 60 }),
    ).rejects.toThrow(/deadline/i);
  }, 5_000);

  it("限流退避中 abort 立即中止", async () => {
    const ac = new AbortController();
    const p = runWithRateLimitRetry(
      () => Promise.reject(new Error("速率限制")),
      { maxRetries: 3, baseMs: 60_000, deadlineMs: 600_000 },
      ac.signal,
    );
    setTimeout(() => ac.abort(), 30);
    await expect(p).rejects.toThrow(/abort/i);
  }, 5_000);
});
