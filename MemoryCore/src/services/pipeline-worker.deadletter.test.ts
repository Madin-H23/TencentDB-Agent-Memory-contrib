// #44 死信可观测/可恢复纯函数层直测：serializeDeadLetter + deadLetterRetryDecision。
import { describe, it, expect } from "vitest";
import { serializeDeadLetter, deadLetterRetryDecision, buildDeadLetterList } from "./pipeline-worker.js";
import type { DeadLetterEntry } from "./pipeline-worker.js";
import type { TaskPayload } from "../core/state/types.js";

function task(overrides: Partial<TaskPayload> = {}): TaskPayload {
  return {
    id: "L2-sess-TESTTOKEN0001-1795",
    type: "L2",
    instanceId: "default",
    sessionId: "sess-TESTTOKEN0001",
    priority: 1,
    createdAt: 1795000000000,
    ...overrides,
  };
}

function entry(overrides: Partial<DeadLetterEntry> = {}): DeadLetterEntry {
  return {
    task: task(),
    error: "parked lock-conflict retry limit (8)",
    retryCount: 8,
    deadAt: 1795000600000,
    ...overrides,
  };
}

describe("deadletter · A 组：serializeDeadLetter 只摘关键字段（天然脱敏）", () => {
  it("精确 DTO：taskId/taskType/sessionId/error/retryCount/deadAt", () => {
    expect(serializeDeadLetter(entry())).toEqual({
      taskId: "L2-sess-TESTTOKEN0001-1795",
      taskType: "L2",
      sessionId: "sess-TESTTOKEN0001",
      error: "parked lock-conflict retry limit (8)",
      retryCount: 8,
      deadAt: 1795000600000,
    });
  });

  it("task.data 潜在敏感内容不进 DTO（即使含凭据形态也不输出）", () => {
    const e = entry({ task: task({ data: { apiKey: "DATA_SECRET_MARKER", note: "x" } }), error: "err" });
    const dto = serializeDeadLetter(e);
    expect(JSON.stringify(dto)).not.toContain("apiKey");
    expect(JSON.stringify(dto)).not.toContain("DATA_SECRET_MARKER");
  });

  it("内部投递元数据 _msgId/_stream/_ownerId 不进 DTO", () => {
    const e = entry({ task: task({ _msgId: "m1", _stream: "s1", _ownerId: "o1" }) });
    const dto = serializeDeadLetter(e) as Record<string, unknown>;
    expect(dto).not.toHaveProperty("_msgId");
    expect(dto).not.toHaveProperty("_stream");
    expect(dto).not.toHaveProperty("_ownerId");
  });
});

describe("deadletter · B 组：deadLetterRetryDecision 门控（默认 off）", () => {
  it("off 恒拒绝（默认关，敏感闸留用户）", () => {
    expect(deadLetterRetryDecision("off", false)).toEqual({ allowed: false, reason: "mode-off" });
    expect(deadLetterRetryDecision("off", true)).toEqual({ allowed: false, reason: "mode-off" });
  });

  it("on 且未入队 → 允许；on 且已入队 → 幂等拒绝", () => {
    expect(deadLetterRetryDecision("on", false)).toEqual({ allowed: true, reason: "ok" });
    expect(deadLetterRetryDecision("on", true)).toEqual({ allowed: false, reason: "already-enqueued" });
  });

  it("边界：缺省 mode 当 off", () => {
    expect(deadLetterRetryDecision(undefined, false)).toEqual({ allowed: false, reason: "mode-off" });
  });
});

describe("deadletter · C 组：buildDeadLetterList 列表组装（只读端点数据源）", () => {
  it("空队列 → 空列表（不崩）", () => {
    expect(buildDeadLetterList([])).toEqual([]);
  });

  it("多条目按 deadAt 降序（最新死信在前），逐条经 serializeDeadLetter 脱敏", () => {
    const older = entry({ deadAt: 1000, task: task({ id: "old", sessionId: "sess-OLD" }) });
    const newer = entry({ deadAt: 2000, task: task({ id: "new", sessionId: "sess-NEW", data: { secret: "DATA_SECRET_MARKER" } }) });
    const list = buildDeadLetterList([older, newer]);
    expect(list.map((d) => d.taskId)).toEqual(["new", "old"]);
    expect(JSON.stringify(list)).not.toContain("DATA_SECRET_MARKER");
    expect(list[0]).toEqual(serializeDeadLetter(newer));
  });

  it("不修改入参（纯函数）", () => {
    const arr = [entry({ deadAt: 1 }), entry({ deadAt: 2 })];
    const snapshot = arr.map((e) => e.deadAt);
    buildDeadLetterList(arr);
    expect(arr.map((e) => e.deadAt)).toEqual(snapshot);
  });
});
