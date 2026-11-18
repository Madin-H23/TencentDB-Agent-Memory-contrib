import { describe, expect, it } from "vitest";
import {
  LEGACY_INSTANCE_ID,
  assertTupleField,
  isEvalDisabled,
  isNoScript,
  isUnknownCommand,
  parseAgentTuple,
  serializeAgentTuple,
  type AgentTuple,
} from "./agent-task-queue.js";

function tuple(over: Partial<AgentTuple> = {}): AgentTuple {
  return {
    instance_id: "inst-AX7Q",
    space_id: "space-1",
    user_id: "user-2",
    team_id: "team-3",
    agent_id: "agent-4",
    ...over,
  };
}

describe("agent-task-queue · A 组：5 段 tuple 精确往返", () => {
  it("serializeAgentTuple → parseAgentTuple 逐字段往返", () => {
    const t = tuple();
    const raw = serializeAgentTuple(t);
    expect(raw).toBe("inst-AX7Q|space-1|user-2|team-3|agent-4");
    expect(parseAgentTuple(raw)).toEqual(t);
  });

  it("4 段 legacy tuple 升级为 LEGACY_INSTANCE_ID（非 null，便于上层识别）", () => {
    expect(parseAgentTuple("space-1|user-2|team-3|agent-4")).toEqual(
      tuple({ instance_id: LEGACY_INSTANCE_ID }),
    );
    expect(LEGACY_INSTANCE_ID).toBe("__legacy__");
  });
});

describe("agent-task-queue · B 组：parseAgentTuple 异常输入（≥5 例精确钉死）", () => {
  it("空串 → null", () => {
    expect(parseAgentTuple("")).toBeNull();
  });

  it("少于 5 段（1~3 段且非 4 段）→ null", () => {
    expect(parseAgentTuple("onlyone")).toBeNull();
    expect(parseAgentTuple("a|b")).toBeNull();
    expect(parseAgentTuple("a|b|c")).toBeNull();
  });

  it("多于 5 段（分隔符注入 6 段）→ null，不被当成合法 5 段吞下", () => {
    expect(parseAgentTuple("a|b|c|d|e|f")).toBeNull();
  });

  it("5 段含空字段 → null", () => {
    expect(parseAgentTuple("inst||user|team|agent")).toBeNull();
    expect(parseAgentTuple("inst|space||team|agent")).toBeNull();
    expect(parseAgentTuple("inst|space|user||agent")).toBeNull();
    expect(parseAgentTuple("inst|space|user|team|")).toBeNull();
  });

  it("4 段含空字段 → null", () => {
    expect(parseAgentTuple("space||team|agent")).toBeNull();
    expect(parseAgentTuple("space|user|team|")).toBeNull();
  });

  it("__proto__/constructor 形态字段值作为普通字符串解析（无原型污染）", () => {
    const parsed = parseAgentTuple("__proto__|constructor|user|team|agent");
    expect(parsed).toEqual({
      instance_id: "__proto__",
      space_id: "constructor",
      user_id: "user",
      team_id: "team",
      agent_id: "agent",
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("agent-task-queue · assertTupleField 校验边界（直接导出断言）", () => {
  it("合法字段不抛", () => {
    expect(() => assertTupleField("space_id", "valid-value")).not.toThrow();
  });

  it("空串/非字符串/含分隔符 | → 抛精确错误", () => {
    expect(() => assertTupleField("user_id", "")).toThrow("user_id must be a non-empty string");
    expect(() => assertTupleField("user_id", 42 as unknown as string)).toThrow(
      "user_id must be a non-empty string",
    );
    expect(() => assertTupleField("agent_id", "a|b")).toThrow("agent_id cannot contain '|'");
  });
});

describe("agent-task-queue · C 组：Redis 错误分类纯函数", () => {
  it("isUnknownCommand：unknown command / command not allowed → true，连接错 → false", () => {
    expect(isUnknownCommand(new Error("ERR unknown command 'LMOVE'"))).toBe(true);
    expect(isUnknownCommand(new Error("command 'LMOVE' is not allowed"))).toBe(true);
    expect(isUnknownCommand(new Error("ECONNREFUSED"))).toBe(false);
    expect(isUnknownCommand(new Error("NOSCRIPT"))).toBe(false);
    expect(isUnknownCommand(null)).toBe(false);
  });

  it("isNoScript：仅 NOSCRIPT → true（大小写不敏感）", () => {
    expect(isNoScript(new Error("NOSCRIPT No matching script"))).toBe(true);
    expect(isNoScript(new Error("noscript"))).toBe(true);
    expect(isNoScript(new Error("ERR unknown command"))).toBe(false);
    expect(isNoScript(undefined)).toBe(false);
  });

  it("isEvalDisabled：EVAL 被拒/NOPERM/unknown EVAL* → true，其他 → false", () => {
    expect(isEvalDisabled(new Error("command 'EVAL' is not allowed"))).toBe(true);
    expect(isEvalDisabled(new Error("NOPERM user has no permission"))).toBe(true);
    expect(isEvalDisabled(new Error("ERR unknown command 'EVALSHA'"))).toBe(true);
    expect(isEvalDisabled(new Error("ERR unknown command 'LMOVE'"))).toBe(false);
    expect(isEvalDisabled(new Error("ECONNRESET"))).toBe(false);
  });
});
