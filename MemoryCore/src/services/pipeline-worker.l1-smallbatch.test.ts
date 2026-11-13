// 票 P2-A2（exp/p2-a2-l1-smallbatch-defer）：网关侧两处消费的测试。
//
// 补齐 1 第三处（子代理关键发现）：生产实走网关路径——server.ts executeL1 对
// `result.deferred` 调 armL1IdleAfterDrain（重挂 L1_idle 等下轮攒批），并在任务
// 对象打 `_l1Deferred` 标记；pipeline-worker cascadeSchedule 据该标记跳过
// conversation_count=0 重置 + l2_pending + onL1Complete——否则 deferred 轮在网关
// 模式仍推 L2 timer 并重置计数（timer_scanner 的 count=0 去重会跳过后续轮）。
import { describe, it, expect, vi } from "vitest";
import { PipelineWorker } from "./pipeline-worker.js";
import type { IStateBackend } from "../core/state/types.js";
import type { TaskExecutor, TaskPayload } from "../core/state/types.js";
import type { Logger } from "../core/types.js";

const SESSION = "sess-1";
const INSTANCE = "iid-1";

function makeTask(over: Partial<TaskPayload> = {}): TaskPayload {
  return {
    id: "L1-1",
    type: "L1",
    instanceId: INSTANCE,
    sessionId: SESSION,
    priority: 1,
    data: { instanceId: INSTANCE },
    createdAt: Date.now(),
    ...over,
  };
}

interface WorkerHarness {
  worker: PipelineWorker;
  updates: Array<{ sessionId: string; patch: Record<string, unknown> }>;
  onL1Complete: ReturnType<typeof vi.fn>;
}

function makeWorkerHarness(): WorkerHarness {
  const updates: Array<{ sessionId: string; patch: Record<string, unknown> }> = [];
  const onL1Complete = vi.fn(async () => {});
  const backend = {
    updateSessionState: async (_iid: string, sid: string, patch: Record<string, unknown>) => {
      updates.push({ sessionId: sid, patch });
    },
    enqueueTask: async () => {},
  } as unknown as IStateBackend;
  const executor = {} as TaskExecutor;
  const worker = new PipelineWorker(
    backend,
    executor,
    { onL1Complete },
    { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger,
  );
  return { worker, updates, onL1Complete };
}

const cascade = (worker: PipelineWorker, task: TaskPayload) =>
  (worker as unknown as { cascadeSchedule: (t: TaskPayload) => Promise<void> }).cascadeSchedule(task);

describe("cascadeSchedule：deferred 轮跳过 L1→L2 级联（票 P2-A2·网关侧）", () => {
  it("_l1Deferred=true → 不重置 conversation_count（updateSessionState 零调用）", async () => {
    const { worker, updates } = makeWorkerHarness();
    const task = makeTask();
    (task as unknown as { _l1Deferred: boolean })._l1Deferred = true;
    await cascade(worker, task);
    expect(updates.length).toBe(0);
  });

  it("_l1Deferred=true → 不置 l2_pending、不推 L2 timer（onL1Complete 零调用，含带 profileScopes）", async () => {
    const { worker, updates, onL1Complete } = makeWorkerHarness();
    const task = makeTask();
    (task as unknown as { _l1Deferred: boolean })._l1Deferred = true;
    (task as unknown as { _l2ProfileScopes: string[] })._l2ProfileScopes = ["profile:a", "profile:b"];
    await cascade(worker, task);
    expect(onL1Complete).not.toHaveBeenCalled();
    expect(updates.length).toBe(0);
  });

  it("flush 类型同样受 _l1Deferred 保护（flush 也走 L1 级联分支）", async () => {
    const { worker, updates, onL1Complete } = makeWorkerHarness();
    const task = makeTask({ type: "flush" });
    (task as unknown as { _l1Deferred: boolean })._l1Deferred = true;
    await cascade(worker, task);
    expect(updates.length).toBe(0);
    expect(onL1Complete).not.toHaveBeenCalled();
  });

  it("非 deferred 回归钉：conversation_count=0 重置 + l2_pending=1 + onL1Complete 每 key 一次", async () => {
    const { worker, updates, onL1Complete } = makeWorkerHarness();
    const task = makeTask();
    (task as unknown as { _l2ProfileScopes: string[] })._l2ProfileScopes = ["profile:a"];
    await cascade(worker, task);
    expect(updates).toEqual([
      { sessionId: SESSION, patch: { conversation_count: 0 } },
      { sessionId: "profile:a", patch: { l2_pending_l1_count: 1 } },
    ]);
    expect(onL1Complete).toHaveBeenCalledTimes(1);
    expect(onL1Complete).toHaveBeenCalledWith("profile:a", INSTANCE, undefined, undefined);
  });

  it("非 deferred 无 profileScopes → 回落 sessionId 单键（既有语义不变）", async () => {
    const { worker, updates, onL1Complete } = makeWorkerHarness();
    await cascade(worker, makeTask());
    expect(updates).toEqual([
      { sessionId: SESSION, patch: { conversation_count: 0 } },
      { sessionId: SESSION, patch: { l2_pending_l1_count: 1 } },
    ]);
    expect(onL1Complete).toHaveBeenCalledTimes(1);
  });
});
