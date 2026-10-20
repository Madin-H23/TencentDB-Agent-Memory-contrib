// 思考等级映射（2026-10-20 用户需求：思考改按等级）——纯函数直测。
import { describe, it, expect, afterEach } from "vitest";
import {
  resolveThinkingLevel,
  thinkingLevelPatch,
  isThinkingLevel,
  THINKING_LEVELS,
} from "./llm-runner.js";

const OLD_ENV = process.env.TDAI_DISABLE_THINKING;

afterEach(() => {
  if (OLD_ENV === undefined) delete process.env.TDAI_DISABLE_THINKING;
  else process.env.TDAI_DISABLE_THINKING = OLD_ENV;
});

describe("resolveThinkingLevel（等级判定：显式 > 旧三态 > env）", () => {
  it("显式等级优先（覆盖 env 与旧三态）", () => {
    process.env.TDAI_DISABLE_THINKING = "true";
    expect(resolveThinkingLevel("high", true)).toBe("high");
    expect(resolveThinkingLevel("enabled", false)).toBe("enabled");
  });

  it("旧三态无损映射：true→disabled / false→enabled", () => {
    delete process.env.TDAI_DISABLE_THINKING;
    expect(resolveThinkingLevel(undefined, true)).toBe("disabled");
    expect(resolveThinkingLevel(undefined, false)).toBe("enabled");
  });

  it("都缺省 → env 兜底（env true=disabled，否则 default）", () => {
    process.env.TDAI_DISABLE_THINKING = "true";
    expect(resolveThinkingLevel(undefined, undefined)).toBe("disabled");
    delete process.env.TDAI_DISABLE_THINKING;
    expect(resolveThinkingLevel(undefined, undefined)).toBe("default");
  });
});

describe("thinkingLevelPatch（等级 → 请求体注入）", () => {
  it("default / enabled 不注入任何思考参数", () => {
    expect(thinkingLevelPatch("default")).toBeNull();
    expect(thinkingLevelPatch("enabled")).toBeNull();
  });

  it("disabled → thinking:{type:disabled}（v2 行为不变）", () => {
    expect(thinkingLevelPatch("disabled")).toEqual({ thinking: { type: "disabled" } });
  });

  it("low / high → reasoning_effort", () => {
    expect(thinkingLevelPatch("low")).toEqual({ reasoning_effort: "low" });
    expect(thinkingLevelPatch("high")).toEqual({ reasoning_effort: "high" });
  });

  it("max → reasoning_effort:high + thinking:{type:enabled}", () => {
    expect(thinkingLevelPatch("max")).toEqual({ reasoning_effort: "high", thinking: { type: "enabled" } });
  });
});

describe("isThinkingLevel / THINKING_LEVELS", () => {
  it("合法值集合固定六档，非法值被拒", () => {
    expect([...THINKING_LEVELS]).toEqual(["default", "disabled", "enabled", "low", "high", "max"]);
    expect(isThinkingLevel("high")).toBe(true);
    expect(isThinkingLevel("Medium")).toBe(false);
    expect(isThinkingLevel(undefined)).toBe(false);
  });
});
