// #43 覆盖战役：session-filter 会话跳过判定零直测补齐。
// 全部针对已 export 的 isNonInteractiveTrigger + SessionFilter，零生产代码改动。
import { describe, it, expect } from "vitest";
import { isNonInteractiveTrigger, SessionFilter } from "./session-filter.js";
import type { AgentHookContext } from "./session-filter.js";

function ctx(sessionKey?: string, extra?: Partial<AgentHookContext>): AgentHookContext {
  return { sessionKey, ...(extra ?? {}) };
}

describe("session-filter · A 组：isNonInteractiveTrigger trigger 门控", () => {
  it("4 个 SKIP_TRIGGERS 各命中（含大小写混合）→ true", () => {
    for (const t of ["cron", "heartbeat", "automation", "schedule", "Cron", "HEARTBEAT", "Automation"]) {
      expect(isNonInteractiveTrigger(t)).toBe(true);
    }
  });

  it("非跳过 trigger / undefined → false", () => {
    expect(isNonInteractiveTrigger("user")).toBe(false);
    expect(isNonInteractiveTrigger("message")).toBe(false);
    expect(isNonInteractiveTrigger(undefined)).toBe(false);
    expect(isNonInteractiveTrigger("")).toBe(false);
  });
});

describe("session-filter · B 组：sessionKey 形态", () => {
  it("含 :cron: / :heartbeat:（大小写混合）→ true", () => {
    expect(isNonInteractiveTrigger(undefined, "sess-TESTTOKEN0001:cron:abc")).toBe(true);
    expect(isNonInteractiveTrigger(undefined, "sess-TESTTOKEN0001:HEARTBEAT:abc")).toBe(true);
  });

  it("普通 key → false；trigger 与 sessionKey 同时给、trigger 命中优先", () => {
    expect(isNonInteractiveTrigger(undefined, "sess-TESTTOKEN0001:user:abc")).toBe(false);
    expect(isNonInteractiveTrigger("cron", "sess-TESTTOKEN0001:user:abc")).toBe(true);
  });
});

describe("session-filter · C 组：SessionFilter builtin matcher + glob + ctx 门控", () => {
  const f = new SessionFilter();

  it("builtin：scene-extract / subagent / temp: 前缀命中", () => {
    expect(f.shouldSkip("agent:default:memory-scene-extract-1795")).toBe(true);
    expect(f.shouldSkip("agent:default:subagent:worker1")).toBe(true);
    expect(f.shouldSkip("temp:slug-generator")).toBe(true);
  });

  it("普通业务 key 不命中；用户 glob（含 *）按整 key 匹配", () => {
    expect(f.shouldSkip("sess-TESTTOKEN0001:user:abc")).toBe(false);
    const g = new SessionFilter(["bench-judge-*", "  ", ""]);
    expect(g.shouldSkip("bench-judge-007")).toBe(true);
    expect(g.shouldSkip("other-session")).toBe(false);
  });

  it("shouldSkipCtx：无 sessionKey / memory- sessionId / 非交互 trigger → true", () => {
    expect(f.shouldSkipCtx(ctx(undefined))).toBe(true);
    expect(f.shouldSkipCtx(ctx("sess-TESTTOKEN0001", { sessionId: "memory-abc" }))).toBe(true);
    expect(f.shouldSkipCtx(ctx("sess-TESTTOKEN0001", { trigger: "cron" }))).toBe(true);
    expect(f.shouldSkipCtx(ctx("sess-TESTTOKEN0001", { trigger: "user" }))).toBe(false);
  });
});

describe("session-filter · D 组：边界防御", () => {
  it("空串 / 超长 key 不崩", () => {
    const f = new SessionFilter();
    expect(f.shouldSkip("")).toBe(false);
    expect(f.shouldSkip("x".repeat(10000))).toBe(false);
  });
});
