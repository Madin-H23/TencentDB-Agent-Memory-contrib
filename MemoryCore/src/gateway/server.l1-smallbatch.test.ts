// 票 P2-A2（exp/p2-a2-l1-smallbatch-defer）：server.ts executeL1 的 deferred
// 接线测试（补齐 1 第三处·生产实走网关路径）。
//
// 经 (TdaiGateway.prototype as any).buildTaskExecutor.call(fakeGateway) 取得真实
// executor——executeL1 是 Gateway 私有装配方法，用最小假 gateway 驱动可测缝隙，
// 断言不实例化整个 HTTP 服务。
import { describe, it, expect, vi } from "vitest";
import { TdaiGateway } from "../gateway/server.js";
import type { TaskPayload } from "../core/state/types.js";
import type { Logger } from "../core/types.js";

const SESSION = "sess-1";
const INSTANCE = "iid-1";

function makeTask(): TaskPayload {
  return {
    id: "L1-1",
    type: "L1",
    instanceId: INSTANCE,
    sessionId: SESSION,
    priority: 1,
    data: { instanceId: INSTANCE },
    createdAt: Date.now(),
  };
}

interface FakeGateway {
  core: { setInstanceId: () => void; runL1WithStore: () => Promise<Record<string, unknown>> };
  storePool: { getStore: () => Promise<unknown> };
  statefulPipelineManager: { enqueueL1Drain: ReturnType<typeof vi.fn>; armL1IdleAfterDrain: ReturnType<typeof vi.fn> };
  quotaManager: undefined;
  stateBackend: undefined;
  reportedCreditFor: () => number;
  logger: Logger;
  config: { deployMode: string };
  sharedCosClient: undefined;
  resolveStoreBackendConfigs: () => Promise<{ vdbConfig: unknown; mongoConfig: unknown }>;
  resolveStorageForInstance: () => Promise<undefined>;
}

function makeFakeGateway(result: Record<string, unknown>): FakeGateway {
  return {
    core: { setInstanceId: () => {}, runL1WithStore: async () => result },
    storePool: { getStore: async () => ({}) },
    statefulPipelineManager: {
      enqueueL1Drain: vi.fn(async () => {}),
      armL1IdleAfterDrain: vi.fn(async () => {}),
    },
    quotaManager: undefined,
    stateBackend: undefined,
    reportedCreditFor: () => 0,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger,
    config: { deployMode: "standalone" },
    sharedCosClient: undefined,
    resolveStoreBackendConfigs: async () => ({ vdbConfig: {}, mongoConfig: undefined }),
    resolveStorageForInstance: async () => undefined,
  };
}

function buildExecutor(fake: FakeGateway) {
  const proto = TdaiGateway.prototype as unknown as {
    buildTaskExecutor: () => { executeL1: (t: TaskPayload, s?: AbortSignal) => Promise<void> };
  };
  return proto.buildTaskExecutor.call(fake);
}

describe("executeL1：deferred 结果接线（票 P2-A2·网关侧）", () => {
  it("result.deferred=true → 任务打 _l1Deferred 标记 + 重挂 L1_idle（armL1IdleAfterDrain），不入队 drain", async () => {
    const fake = makeFakeGateway({
      storedCount: 0,
      creditUsed: 0,
      hasMore: false,
      hasFullBacklog: false,
      profileScopes: [],
      deferred: true,
    });
    const executor = buildExecutor(fake);
    const task = makeTask();
    await executor.executeL1(task);
    expect((task as unknown as { _l1Deferred?: boolean })._l1Deferred).toBe(true);
    expect(fake.statefulPipelineManager.armL1IdleAfterDrain).toHaveBeenCalledTimes(1);
    expect(fake.statefulPipelineManager.armL1IdleAfterDrain).toHaveBeenCalledWith(SESSION, INSTANCE, undefined, undefined);
    // deferred 轮不得走 hasFullBacklog 直通入队（P0-3 避开热循环自旋）
    expect(fake.statefulPipelineManager.enqueueL1Drain).not.toHaveBeenCalled();
  });

  it("非 deferred 回归钉：hasFullBacklog → 入队 drain；hasMore → 挂 idle；无 _l1Deferred 标记", async () => {
    const full = makeFakeGateway({
      storedCount: 2,
      creditUsed: 0,
      hasMore: false,
      hasFullBacklog: true,
      profileScopes: ["profile:a"],
      deferred: false,
    });
    const t1 = makeTask();
    await buildExecutor(full).executeL1(t1);
    expect((t1 as unknown as { _l1Deferred?: boolean })._l1Deferred).toBeFalsy();
    expect(full.statefulPipelineManager.enqueueL1Drain).toHaveBeenCalledTimes(1);
    expect(full.statefulPipelineManager.armL1IdleAfterDrain).not.toHaveBeenCalled();
    expect((t1 as unknown as { _l2ProfileScopes?: string[] })._l2ProfileScopes).toEqual(["profile:a"]);

    const tail = makeFakeGateway({
      storedCount: 1,
      creditUsed: 0,
      hasMore: true,
      hasFullBacklog: false,
      profileScopes: [],
      deferred: false,
    });
    const t2 = makeTask();
    await buildExecutor(tail).executeL1(t2);
    expect((t2 as unknown as { _l1Deferred?: boolean })._l1Deferred).toBeFalsy();
    expect(tail.statefulPipelineManager.enqueueL1Drain).not.toHaveBeenCalled();
    expect(tail.statefulPipelineManager.armL1IdleAfterDrain).toHaveBeenCalledTimes(1);
  });
});
