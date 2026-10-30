// 方案C（exp/l2-plan-c-write-cap）：persona.sceneCharCap 配置解析。
// 默认 32000；显式 0=off 必须原样通过（num() 只滤非有限数值，不滤 0）。
import { describe, it, expect } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig：persona.sceneCharCap 解析", () => {
  it("缺省 → 32000（默认帽）", () => {
    const cfg = parseConfig({});
    expect(cfg.persona.sceneCharCap).toBe(32_000);
  });

  it("显式 0 → 0（off 语义，不得被 ?? 吃掉）", () => {
    const cfg = parseConfig({ persona: { sceneCharCap: 0 } });
    expect(cfg.persona.sceneCharCap).toBe(0);
  });

  it("显式数值 → 原样透传", () => {
    const cfg = parseConfig({ persona: { sceneCharCap: 12_345 } });
    expect(cfg.persona.sceneCharCap).toBe(12_345);
  });

  it("非法类型 → 回退默认 32000", () => {
    const cfg = parseConfig({ persona: { sceneCharCap: "32k" } });
    expect(cfg.persona.sceneCharCap).toBe(32_000);
  });
});
