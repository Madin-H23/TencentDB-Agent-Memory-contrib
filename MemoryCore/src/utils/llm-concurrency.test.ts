// P1（2026-10-14，v2 8c00003 移植）：进程级 LLM 并发信号量。
// 关键语义：按 key（厂商 baseUrl）分桶共享、槽位同步移交（释放时等待者当场
// 起跑、active 不经异步间隙）、limit≤0 直通、fn 抛错槽位照常释放。
import { describe, it, expect } from "vitest";
import { getSharedLlmSemaphore, withSharedLlmLimit, setDefaultLlmConcurrency } from "./llm-concurrency.js";

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("SharedLlmSemaphore：分桶并发闸门", () => {
  it("limit=2 时 5 个并发任务峰值在途 ≤2 且全部完成", async () => {
    const sem = getSharedLlmSemaphore("test-a", 2);
    let inFlight = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        sem.run(async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await tick();
          inFlight -= 1;
          return "ok";
        }),
      ),
    );
    expect(results).toHaveLength(5);
    expect(peak).toBe(2);
  });

  it("同 key 恒返回同一实例（跨 runner 共享一桶）", () => {
    expect(getSharedLlmSemaphore("test-b", 3)).toBe(getSharedLlmSemaphore("test-b", 3));
    expect(getSharedLlmSemaphore("test-b", 3)).not.toBe(getSharedLlmSemaphore("test-c", 3));
  });

  it("槽位同步移交：释放与新调用同拍交错也不超限", async () => {
    const sem = getSharedLlmSemaphore("test-d", 1);
    let inFlight = 0;
    let overLimit = false;
    const task = () =>
      sem.run(async () => {
        inFlight += 1;
        if (inFlight > 1) overLimit = true;
        // 微任务级让出：同步移交的等待者必须在上一任务完全退出后才起跑
        await Promise.resolve();
        inFlight -= 1;
      });
    await Promise.all(Array.from({ length: 20 }, task));
    expect(overLimit).toBe(false);
  });

  it("limit≤0 直通不限流", async () => {
    let inFlight = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        withSharedLlmLimit("test-e", 0, async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await tick();
          inFlight -= 1;
        }),
      ),
    );
    expect(peak).toBe(6);
  });

  it("fn 抛错槽位照常释放，错误原样上抛，后续任务不受阻", async () => {
    const sem = getSharedLlmSemaphore("test-f", 1);
    await expect(sem.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(sem.run(async () => "recovered")).resolves.toBe("recovered");
  });

  it("setDefaultLlmConcurrency：默认 0（不限），设置后 withSharedLlmLimit 读取生效", async () => {
    setDefaultLlmConcurrency(0);
    let peak = 0;
    let inFlight = 0;
    const burst = async () => {
      inFlight += 1; peak = Math.max(peak, inFlight); await tick(); inFlight -= 1;
    };
    await Promise.all(Array.from({ length: 4 }, () => withSharedLlmLimit("test-g", 0, burst)));
    expect(peak).toBe(4);
    // 显式 limit>0 时仍按显式值限流（默认值只作回退）
    setDefaultLlmConcurrency(1);
    peak = 0;
    await Promise.all(Array.from({ length: 4 }, () => withSharedLlmLimit("test-h", 2, burst)));
    expect(peak).toBe(2);
    setDefaultLlmConcurrency(0);
  });
});
