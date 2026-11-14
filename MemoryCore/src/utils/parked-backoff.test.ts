// 票 origin#27（R1·TICKETS-parked-backoff）：parked 僵尸任务退避上限。
// 缺陷实证：retryParkedScope 的 attempt 无上限（uptime 7.8h 空转 414→977 次·死信无出口）。
// 纯函数决策器 + 拒绝式配置；默认 off=现有无限重试行为逐字节不变。
import { describe, expect, it } from "vitest";
import {
  parseParkedBackoffConfig,
  parkedRetryDecision,
  PARKED_BACKOFF_DEFAULT_MAX_RETRIES,
} from "./parked-backoff.js";

describe("parseParkedBackoffConfig：拒绝式解析", () => {
  it("undefined/null/false → undefined（off=现有行为逐字节不变）", () => {
    expect(parseParkedBackoffConfig(undefined)).toBeUndefined();
    expect(parseParkedBackoffConfig(null)).toBeUndefined();
    expect(parseParkedBackoffConfig(false)).toBeUndefined();
  });

  it("true → 默认上限（安全默认）", () => {
    expect(parseParkedBackoffConfig(true)).toEqual({ maxRetries: PARKED_BACKOFF_DEFAULT_MAX_RETRIES });
  });

  it("对象透传 maxRetries；mode=off → undefined", () => {
    expect(parseParkedBackoffConfig({ maxRetries: 5 })).toEqual({ maxRetries: 5 });
    expect(parseParkedBackoffConfig({ mode: "off" })).toBeUndefined();
  });

  it("非法值 throw（不静默回落）", () => {
    expect(() => parseParkedBackoffConfig({ maxRetries: 0 })).toThrow();
    expect(() => parseParkedBackoffConfig({ maxRetries: -1 })).toThrow();
    expect(() => parseParkedBackoffConfig({ maxRetries: 1.5 })).toThrow();
    expect(() => parseParkedBackoffConfig("on")).toThrow();
    expect(() => parseParkedBackoffConfig(42)).toThrow();
  });
});

describe("parkedRetryDecision：退避决策纯函数", () => {
  const cfg = { maxRetries: 8 };

  it("attempt < maxRetries → retry（delay 由调用方既有表管理）", () => {
    expect(parkedRetryDecision({ attempt: 0, cfg })).toEqual({ action: "retry" });
    expect(parkedRetryDecision({ attempt: 7, cfg }).action).toBe("retry");
  });

  it("attempt >= maxRetries → dead-letter（含 attempt 回传）", () => {
    expect(parkedRetryDecision({ attempt: 8, cfg })).toEqual({ action: "dead-letter", attempt: 8 });
    expect(parkedRetryDecision({ attempt: 100, cfg }).action).toBe("dead-letter");
  });

  it("边界：maxRetries=1 时首次冲突即死信", () => {
    expect(parkedRetryDecision({ attempt: 0, cfg: { maxRetries: 1 } }).action).toBe("retry");
    expect(parkedRetryDecision({ attempt: 1, cfg: { maxRetries: 1 } }).action).toBe("dead-letter");
  });

  it("off（undefined cfg）→ 恒 retry（现有无限重试语义）", () => {
    expect(parkedRetryDecision({ attempt: 99999, cfg: undefined }).action).toBe("retry");
  });
});

// ── worker 集成冒烟：maxParkedRetries 达上限 → parked 任务转死信（origin#27 验收）──
import { PipelineWorker } from "../services/pipeline-worker.js";
import type { IStateBackend, TaskExecutor, TaskPayload } from "../core/state/types.js";
import type { Logger } from "../core/types.js";
import { vi } from "vitest";

describe("worker 集成：parked 重试上限 → deadLetter（默认 off 不触发）", () => {
  function makeWorkerHarness(maxParkedRetries: unknown, acquireLockResult: boolean) {
    const onDeadLetter = vi.fn(async () => {});
    const backend = {
      acquireLock: async () => acquireLockResult,
      enqueueTask: async () => {},
      releaseLock: async () => {},
      ackTask: async () => {},
    } as unknown as IStateBackend;
    const worker = new PipelineWorker(
      backend,
      {} as TaskExecutor,
      { maxParkedRetries, onDeadLetter } as never,
      { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger,
    );
    return { worker, onDeadLetter, backend };
  }

  function seedParked(worker: PipelineWorker, task: TaskPayload, attempt: number): string {
    const scope = "pipeline:test:s";
    (worker as unknown as { parkedByScope: Map<string, unknown[]> }).parkedByScope.set(scope, [
      { task, lockKey: scope, attempt, nextRetryAt: 0, ownershipLost: false },
    ]);
    (worker as unknown as { metrics: { parkedRetryAttempts: number; lockConflicts: number; tasksParked: number } }).metrics.parkedRetryAttempts = 0;
    (worker as unknown as { metrics: { parkedRetryAttempts: number; lockConflicts: number; tasksParked: number } }).metrics.lockConflicts = 0;
    (worker as unknown as { metrics: { parkedRetryAttempts: number; lockConflicts: number; tasksParked: number } }).metrics.tasksParked = 1;
    return scope;
  }

  const makeTask = (): TaskPayload => ({
    id: "L1-x",
    type: "L1",
    instanceId: "iid",
    sessionId: "s",
    priority: 1,
    data: { instanceId: "iid" },
    createdAt: Date.now(),
  });

  it("maxRetries=1·acquireLock=false·attempt 已 1 → 转 deadLetter（onDeadLetter 调用+队列清空+死信计数+1）", async () => {
    const { worker, onDeadLetter } = makeWorkerHarness({ maxRetries: 1 }, false);
    const task = makeTask();
    (task as unknown as { _msgId: string })._msgId = "m-1";
    (task as unknown as { _ownerId: string })._ownerId = "w";
    const scope = seedParked(worker, task, 1);
    await (worker as unknown as { retryParkedScope: (s: string) => Promise<void> }).retryParkedScope(scope);
    await new Promise((r) => setImmediate(r)); // moveToDeadLetter 为 void fire-and-forget·等 microtask
    expect(onDeadLetter).toHaveBeenCalledTimes(1);
    const q = (worker as unknown as { parkedByScope: Map<string, unknown[]> }).parkedByScope.get(scope);
    expect(!q || q.length === 0).toBe(true); // removeParkedHead 清空后可能整键移除
    expect((worker as unknown as { deadLetterQueue: unknown[] }).deadLetterQueue.length).toBe(1);
  });

  it("默认 off（undefined）：同场景不转死信·走既有 retry 路径（attempt++ 驻留队列）", async () => {
    const { worker, onDeadLetter } = makeWorkerHarness(undefined, false);
    const task = makeTask();
    (task as unknown as { _msgId: string })._msgId = "m-1";
    (task as unknown as { _ownerId: string })._ownerId = "w";
    const scope = seedParked(worker, task, 0);
    await (worker as unknown as { retryParkedScope: (s: string) => Promise<void> }).retryParkedScope(scope);
    expect(onDeadLetter).not.toHaveBeenCalled();
    const q = (worker as unknown as { parkedByScope: Map<string, unknown[]> }).parkedByScope.get(scope)!;
    expect(q.length).toBe(1);
    expect((worker as unknown as { deadLetterQueue: unknown[] }).deadLetterQueue.length).toBe(0);
  });
});
