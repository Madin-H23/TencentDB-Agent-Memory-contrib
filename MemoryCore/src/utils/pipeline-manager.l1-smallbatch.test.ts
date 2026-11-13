// 票 P2-A2（exp/p2-a2-l1-smallbatch-defer）：MemoryPipelineManager.runL1 的
// deferred 分支测试（新建 runL1 harness）。
//
// 背景（P0-2）：defer 禁走 runL1 catch/throw 路径——那会 l1RetryCount++（与
// llm_error 277 次/窗共享 max-5 配额，小批 defer 数轮即烧穿 ⇒ 攒批停摆）+ error
// 日志 + buffer 回填空转。改为 runner 内门槛前置 early-return 专用形状
// （{deferred:true, hasMore:false, hasFullBacklog:false}），runL1 在成功块前
// 分流：重挂 l1Idle、跳过 conversation_count 重置/warmup/l2_pending/L2 timer，
// retry 计数不动（零 LLM 成本零异常机制＝OPT 原始「触发侧预判」框架）。
import { describe, it, expect } from "vitest";
import { MemoryPipelineManager } from "./pipeline-manager.js";
import type { L1Runner, L1RunnerResult, PipelineConfig } from "./pipeline-manager.js";
import type { Logger } from "../core/types.js";

const SESSION_KEY = "zcode-default";

interface Harness {
  m: MemoryPipelineManager;
  persisted: Array<Record<string, unknown>>;
  infoLines: string[];
}

function makeManager(runner: L1Runner, enableWarmup = true): Harness {
  const persisted: Array<Record<string, unknown>> = [];
  const infoLines: string[] = [];
  const cfg: PipelineConfig = {
    everyNConversations: 5,
    enableWarmup,
    l1: { idleTimeoutSeconds: 30 },
    l2: {
      delayAfterL1Seconds: 90,
      minIntervalSeconds: 900,
      maxIntervalSeconds: 3600,
      sessionActiveWindowHours: 24,
    },
  };
  const m = new MemoryPipelineManager(cfg, {
    debug: () => {},
    info: (msg: string) => infoLines.push(msg),
    warn: () => {},
    error: () => {},
  } as unknown as Logger);
  m.setL1Runner(runner);
  m.setPersister(async (states) => {
    persisted.push(states as Record<string, unknown>);
  });
  return { m, persisted, infoLines };
}

/** 造一个带 conversation_count=3 / warmup_threshold=1 / l2_pending=0 的会话态 */
function seedSession(m: MemoryPipelineManager, over: Partial<{ conversation_count: number; warmup_threshold: number; l2_pending_l1_count: number; l1RetryCount: number }> = {}) {
  const anyM = m as unknown as {
    sessionStates: Map<string, Record<string, unknown>>;
    messageBuffers: Map<string, unknown[]>;
    getOrCreateTimers: (k: string) => { l1RetryCount: number };
  };
  anyM.sessionStates.set(SESSION_KEY, {
    conversation_count: over.conversation_count ?? 3,
    last_extraction_time: "",
    last_extraction_updated_time: "",
    last_active_time: Date.now(),
    l2_pending_l1_count: over.l2_pending_l1_count ?? 0,
    warmup_threshold: over.warmup_threshold ?? 1,
    l2_last_extraction_time: "",
  });
  anyM.messageBuffers.set(SESSION_KEY, []);
  anyM.getOrCreateTimers(SESSION_KEY).l1RetryCount = over.l1RetryCount ?? 0;
}

const runL1 = (m: MemoryPipelineManager) =>
  (m as unknown as { runL1: (k: string) => Promise<void> }).runL1(SESSION_KEY);

const stateOf = (m: MemoryPipelineManager) =>
  (m as unknown as { sessionStates: Map<string, Record<string, number>> }).sessionStates.get(SESSION_KEY)!;

const timersOf = (m: MemoryPipelineManager) =>
  (m as unknown as { sessionTimers: Map<string, { l1Idle: { pending: boolean; scheduledTime: number }; l2Schedule: { pending: boolean }; l1RetryCount: number }> })
    .sessionTimers.get(SESSION_KEY)!;

/** deferred 桩：复刻 runner 内 early-return 专用形状（P0-2） */
const deferredRunner: L1Runner = async () =>
  ({ deferred: true, hasMore: false, hasFullBacklog: false, processedCount: 0, storedCount: 0, profileScopes: [] }) as L1RunnerResult;

describe("runL1：deferred 分支（票 P2-A2·小批延后攒批）", () => {
  it("deferred → 不重置 conversation_count", async () => {
    const { m } = makeManager(deferredRunner);
    seedSession(m, { conversation_count: 3 });
    await runL1(m);
    expect(stateOf(m).conversation_count).toBe(3);
  });

  it("deferred → 不推进 warmup_threshold", async () => {
    const { m } = makeManager(deferredRunner);
    seedSession(m, { warmup_threshold: 1 });
    await runL1(m);
    expect(stateOf(m).warmup_threshold).toBe(1);
  });

  it("deferred → 不置 l2_pending_l1_count（连 profileScopes 分支都不进）", async () => {
    const { m } = makeManager(deferredRunner);
    seedSession(m, { l2_pending_l1_count: 0 });
    await runL1(m);
    expect(stateOf(m).l2_pending_l1_count).toBe(0);
    // 也不得为任何 l2Key 造出新的 session state
    const states = (m as unknown as { sessionStates: Map<string, unknown> }).sessionStates;
    expect([...states.keys()]).toEqual([SESSION_KEY]);
  });

  it("deferred → 不推 L2 timer（l2Schedule 无待触发）", async () => {
    const { m } = makeManager(deferredRunner);
    seedSession(m);
    await runL1(m);
    expect(timersOf(m).l2Schedule.pending).toBe(false);
  });

  it("deferred → l1RetryCount 不动（不烧 max-5 重试配额）", async () => {
    const { m } = makeManager(deferredRunner);
    seedSession(m, { l1RetryCount: 2 });
    await runL1(m);
    expect(timersOf(m).l1RetryCount).toBe(2);
  });

  it("deferred → 重挂 l1Idle（30s 后自然再入队⇒下轮 DB 查询含旧+新消息=攒批）", async () => {
    const { m } = makeManager(deferredRunner);
    seedSession(m);
    await runL1(m);
    const t = timersOf(m).l1Idle;
    expect(t.pending).toBe(true);
    // 约 30s 后触发（l1IdleTimeoutMs=30000；±5s 容差）
    expect(t.scheduledTime).toBeGreaterThan(Date.now() + 25_000);
    expect(t.scheduledTime).toBeLessThanOrEqual(Date.now() + 30_000);
  });

  it("deferred → 不落盘（会话态零变更，persistStates 零调用）", async () => {
    const { m, persisted } = makeManager(deferredRunner);
    seedSession(m);
    await runL1(m);
    expect(persisted.length).toBe(0);
  });

  it("非 deferred 回归钉：正常成功路径——计数重置/warmup 推进/l2_pending/L2 timer/retry 归零/落盘", async () => {
    const { m, persisted } = makeManager(async () => ({ processedCount: 2, storedCount: 1, hasMore: false, hasFullBacklog: false, profileScopes: [] }) as L1RunnerResult);
    seedSession(m, { conversation_count: 3, warmup_threshold: 1, l1RetryCount: 2 });
    await runL1(m);
    expect(stateOf(m).conversation_count).toBe(0);
    expect(stateOf(m).warmup_threshold).toBe(2); // 1×2 < everyN=5
    expect(stateOf(m).l2_pending_l1_count).toBe(1);
    expect(timersOf(m).l1RetryCount).toBe(0);
    expect(timersOf(m).l2Schedule.pending).toBe(true);
    expect(persisted.length).toBe(1);
    expect((persisted[0] as Record<string, { conversation_count: number }>)[SESSION_KEY]!.conversation_count).toBe(0);
  });

  it("非 deferred 回归钉：hasMore 小尾巴 → 同样重挂 l1Idle（既有路径不受新分支影响）", async () => {
    const { m } = makeManager(async () => ({ processedCount: 10, storedCount: 3, hasMore: true, hasFullBacklog: false, profileScopes: [] }) as L1RunnerResult);
    seedSession(m);
    await runL1(m);
    expect(stateOf(m).conversation_count).toBe(0); // 成功路径仍重置
    expect(timersOf(m).l1Idle.pending).toBe(true); // 小尾巴仍挂 idle
    expect(timersOf(m).l2Schedule.pending).toBe(true);
  });
});
