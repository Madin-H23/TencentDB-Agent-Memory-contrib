// 票 origin#35（R4·seed 模式只等 L1 idle 即销毁管线——L2/L3 在途被切断）：
// waitForL2L3Idle 有界等待函数直测（fake scheduler 序列注入）。
// 语义：L1 idle 后 L2/L3 兜底——轮询 l2/l3Idle+队列空+无 pending；
// maxWait 兜底到时 warn proceeding（「尽力完成」而非「必然完整」·同 waitForL1Idle 模式）。
import { describe, expect, it } from "vitest";
import { waitForL2L3Idle } from "./seed-runtime.js";

function makeLogger() {
  const lines: string[] = [];
  return {
    lines,
    debug: (m: string) => lines.push(`DEBUG ${m}`),
    info: (m: string) => lines.push(`INFO ${m}`),
    warn: (m: string) => lines.push(`WARN ${m}`),
    error: (m: string) => lines.push(`ERROR ${m}`),
  };
}

type QueueSizes = {
  l1: number; l2: number; l3: number;
  l1Pending: boolean; l2Pending: boolean; l3Pending: boolean;
  l1Idle: boolean; l2Idle: boolean; l3Idle: boolean;
};

function sizes(over: Partial<QueueSizes>): QueueSizes {
  return {
    l1: 0, l2: 0, l3: 0,
    l1Pending: false, l2Pending: false, l3Pending: false,
    l1Idle: true, l2Idle: true, l3Idle: true,
    ...over,
  };
}

describe("waitForL2L3Idle：seed 销毁前 L2/L3 兜底等待（origin#35）", () => {
  it("L2/L3 已 idle → 连续 stableRounds 轮后立即返回", async () => {
    const logger = makeLogger();
    let polls = 0;
    const scheduler = {
      getQueueSizes: () => {
        polls++;
        return sizes({});
      },
    } as never;
    await waitForL2L3Idle(scheduler, logger, { pollIntervalMs: 1, stableRounds: 3, maxWaitMs: 5_000 });
    expect(polls).toBe(3); // 恰好 stableRounds 轮
    expect(logger.lines.some((l) => l.includes("proceeding"))).toBe(false);
  });

  it("L2 在途 → 转换后返回（等待在途任务完成）", async () => {
    const logger = makeLogger();
    const seq = [
      sizes({ l2: 1, l2Pending: true, l2Idle: false }), // 第 1 轮：在途
      sizes({ l2: 0, l2Pending: true, l2Idle: false }), // 第 2 轮：排空中
      sizes({}), // 第 3 轮起 idle
      sizes({}),
      sizes({}),
    ];
    let i = 0;
    const scheduler = { getQueueSizes: () => seq[Math.min(i++, seq.length - 1)]! } as never;
    await waitForL2L3Idle(scheduler, logger, { pollIntervalMs: 1, stableRounds: 3, maxWaitMs: 5_000 });
    expect(i).toBe(5); // 前两轮等待+三轮稳定
  });

  it("L3 积压同理（l3 队列空+idle 才算）", async () => {
    const logger = makeLogger();
    const seq = [
      sizes({ l3: 2, l3Pending: true, l3Idle: false }),
      sizes({ l3: 0, l3Pending: true, l3Idle: false }),
      sizes({}),
      sizes({}),
      sizes({}),
    ];
    let i = 0;
    const scheduler = { getQueueSizes: () => seq[Math.min(i++, seq.length - 1)]! } as never;
    await waitForL2L3Idle(scheduler, logger, { pollIntervalMs: 1, stableRounds: 3, maxWaitMs: 5_000 });
    expect(i).toBe(5);
  });

  it("maxWait 兜底：永不 idle → 到时 warn proceeding 返回（不无限拖）", async () => {
    const logger = makeLogger();
    const scheduler = { getQueueSizes: () => sizes({ l2: 5, l2Pending: true, l2Idle: false }) } as never;
    const t0 = Date.now();
    await waitForL2L3Idle(scheduler, logger, { pollIntervalMs: 1, stableRounds: 3, maxWaitMs: 50 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
    expect(logger.lines.some((l) => l.includes("proceeding"))).toBe(true);
  });

  it("warn 消息带 L2/L3 排队快照（可观测·零内容回显）", async () => {
    const logger = makeLogger();
    const scheduler = { getQueueSizes: () => sizes({ l2: 3, l2Pending: true, l2Idle: false, l3: 1 }) } as never;
    await waitForL2L3Idle(scheduler, logger, { pollIntervalMs: 1, stableRounds: 3, maxWaitMs: 30 });
    const warn = logger.lines.find((l) => l.startsWith("WARN"));
    expect(warn).toBeDefined();
    expect(warn).toContain("l2=");
    expect(warn).toContain("l3=");
  });
});
