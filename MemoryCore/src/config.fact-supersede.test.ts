// 票 P1-6b 接线：persona.factSupersede 配置解析（同款先例：sceneCompaction/recallRanking 拒绝式）。
// 缺省关闭；true=shadow+0.55（安全默认=影子先量）；对象可调 mode/minSimilarity；非法 throw。
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig：persona.factSupersede 解析", () => {
  it("缺省 → undefined（关闭=Phase 5 零 I/O、行为逐字节不变）", () => {
    expect(parseConfig({}).persona.factSupersede).toBeUndefined();
  });

  it("显式 false → undefined（关闭）", () => {
    expect(parseConfig({ persona: { factSupersede: false } }).persona.factSupersede).toBeUndefined();
  });

  it("true → 安全默认 shadow + 0.55", () => {
    expect(parseConfig({ persona: { factSupersede: true } }).persona.factSupersede).toEqual({
      mode: "shadow",
      minSimilarity: 0.55,
    });
  });

  it("对象：mode=on 与自定义阈值透传", () => {
    expect(parseConfig({ persona: { factSupersede: { mode: "on", minSimilarity: 0.65 } } }).persona.factSupersede).toEqual({
      mode: "on",
      minSimilarity: 0.65,
    });
  });

  it("对象缺省字段回落 shadow/0.55", () => {
    expect(parseConfig({ persona: { factSupersede: {} } }).persona.factSupersede).toEqual({
      mode: "shadow",
      minSimilarity: 0.55,
    });
  });

  it("mode=off → undefined（关闭）", () => {
    expect(parseConfig({ persona: { factSupersede: { mode: "off" } } }).persona.factSupersede).toBeUndefined();
  });

  it("非法 mode / 阈值越界 / 非布尔对象 → throw（不静默回落）", () => {
    expect(() => parseConfig({ persona: { factSupersede: { mode: "always" } } })).toThrow();
    expect(() => parseConfig({ persona: { factSupersede: { minSimilarity: 1 } } })).toThrow();
    expect(() => parseConfig({ persona: { factSupersede: { minSimilarity: 0 } } })).toThrow();
    expect(() => parseConfig({ persona: { factSupersede: { minSimilarity: -0.2 } } })).toThrow();
    expect(() => parseConfig({ persona: { factSupersede: "on" } })).toThrow();
    expect(() => parseConfig({ persona: { factSupersede: 42 } })).toThrow();
  });
});
