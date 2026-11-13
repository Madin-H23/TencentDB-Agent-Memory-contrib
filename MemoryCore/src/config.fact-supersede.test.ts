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

// ── P1-6b 批准桶接线（T2·judgeStatePath）──

describe("parseConfig：persona.factSupersede.judgeStatePath（批准桶路径）", () => {
  it("缺省 → undefined（不过滤=接线前行为·全量标记）", () => {
    expect(parseConfig({ persona: { factSupersede: true } }).persona.factSupersede?.judgeStatePath).toBeUndefined();
    expect(parseConfig({ persona: { factSupersede: { mode: "on" } } }).persona.factSupersede?.judgeStatePath).toBeUndefined();
  });

  it("对象透传绝对路径", () => {
    const p = "D:/Develop/tdai-workspace/exp-l2/scripts/judge/state.json";
    expect(
      parseConfig({ persona: { factSupersede: { mode: "on", judgeStatePath: p } } }).persona.factSupersede?.judgeStatePath,
    ).toBe(p);
  });

  it("显式 null/空串 → undefined（视作未配置）", () => {
    expect(
      parseConfig({ persona: { factSupersede: { judgeStatePath: null } } }).persona.factSupersede?.judgeStatePath,
    ).toBeUndefined();
    expect(
      parseConfig({ persona: { factSupersede: { judgeStatePath: "   " } } }).persona.factSupersede?.judgeStatePath,
    ).toBeUndefined();
  });

  it("非字符串 → throw（不静默回落）", () => {
    expect(() => parseConfig({ persona: { factSupersede: { judgeStatePath: 42 } } })).toThrow();
    expect(() => parseConfig({ persona: { factSupersede: { judgeStatePath: true } } })).toThrow();
    expect(() => parseConfig({ persona: { factSupersede: { judgeStatePath: {} } } })).toThrow();
  });

  it("mode=off 时 judgeStatePath 被忽略（整项 undefined）", () => {
    expect(
      parseConfig({ persona: { factSupersede: { mode: "off", judgeStatePath: "/x.json" } } }).persona.factSupersede,
    ).toBeUndefined();
  });
});
