import { describe, it, expect } from "vitest";
import { getSharedLlmSemaphore, withSharedLlmLimit } from "./llm-concurrency.js";

// ---------------------------------------------------------------------------
// 进程级 LLM 并发信号量单元测试。
// 背景：L1 抽取池/L1 去重/L2 定时任务/L3 画像各自发厂商调用，无统一闸门时
// 慢端点挂起叠加新调用会被厂商 concurrency reached 秒拒 —— 闸门必须在
// 调用漏斗处按厂商分桶限流。核心契约：峰值并发绝不超 limit、失败释放、
// 同 key 共享/异 key 独立、limit<=0 直通。
// ---------------------------------------------------------------------------

/** 峰值计数探针：fn 内自增/自减并记录峰值。 */
function makePeakProbe() {
  let inFlight = 0;
  let peak = 0;
  return {
    async track<T>(fn: () => Promise<T>): Promise<T> {
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        return await fn();
      } finally {
        inFlight--;
      }
    },
    get peak() {
      return peak;
    },
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("getSharedLlmSemaphore", () => {
  it("同 key 返回同一实例（L1/L2/L3 跨 runner 共享闸门的前提）", () => {
    expect(getSharedLlmSemaphore("unit-shared-key", 2)).toBe(
      getSharedLlmSemaphore("unit-shared-key", 2),
    );
  });

  it("异 key 相互独立（不同厂商端点互不限流）", async () => {
    const probe = makePeakProbe();
    const a = getSharedLlmSemaphore("unit-ind-a", 1);
    const b = getSharedLlmSemaphore("unit-ind-b", 1);
    await Promise.all([
      a.run(() => probe.track(async () => tick())),
      b.run(() => probe.track(async () => tick())),
    ]);
    expect(probe.peak).toBe(2);
  });

  it("limit<1 拒绝构造（0 表示不限，走 withSharedLlmLimit 直通，不经此路径）", () => {
    expect(() => getSharedLlmSemaphore("unit-bad", 0)).toThrow();
    expect(() => getSharedLlmSemaphore("unit-bad", -3)).toThrow();
  });
});

describe("withSharedLlmLimit", () => {
  it("limit=2 时 5 个并发调用峰值 ≤2 且全部完成", async () => {
    const probe = makePeakProbe();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        withSharedLlmLimit("unit-cap", 2, () =>
          probe.track(async () => {
            await tick();
            return i;
          }),
        ),
      ),
    );
    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(probe.peak).toBeLessThanOrEqual(2);
    expect(probe.peak).toBe(2); // 确实形成了并发，而非退化串行
  });

  it("失败也释放许可：首个调用抛错后，后续调用仍能进入", async () => {
    let calls = 0;
    await expect(
      withSharedLlmLimit("unit-fail", 1, async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return "ok";
      }),
    ).rejects.toThrow("boom");
    await expect(withSharedLlmLimit("unit-fail", 1, async () => "second")).resolves.toBe(
      "second",
    );
  });

  it("limit<=0 直通不限（上游默认行为不变）", async () => {
    const probe = makePeakProbe();
    await Promise.all(
      Array.from({ length: 4 }, () =>
        withSharedLlmLimit("unit-unlimited", 0, () =>
          probe.track(async () => tick()),
        ),
      ),
    );
    expect(probe.peak).toBe(4);
  });

  it("唤醒竞态下仍不超限：释放与新调用同微任务交错，峰值恒 ≤limit", async () => {
    const probe = makePeakProbe();
    // 构造释放与排队唤醒同拍交错的时序：多个调用在不同 tick 完成
    const gates = Array.from({ length: 6 }, (_, i) =>
      withSharedLlmLimit("unit-race", 2, () =>
        probe.track(
          async () =>
            new Promise<string>((r) => setTimeout(() => r(`done-${i}`), (i % 3) + 1)),
        ),
      ),
    );
    const out = await Promise.all(gates);
    expect(out).toHaveLength(6);
    expect(probe.peak).toBeLessThanOrEqual(2);
  });
});
