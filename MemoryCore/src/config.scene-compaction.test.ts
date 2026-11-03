// 票⑧（exp/p1-8-scene-compaction）：persona.sceneCompaction 配置解析。
// 缺省关闭（undefined）；非法 ratio / target>=trigger / 非布尔 enabled → throw
// （对齐 recallRanking / parseSemanticGateConfig 的拒绝先例，灰度开关不静默回落）。
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig：persona.sceneCompaction 解析", () => {
  it("缺省 → undefined（关闭=Phase 5 零 I/O、行为逐字节不变）", () => {
    expect(parseConfig({}).persona.sceneCompaction).toBeUndefined();
  });

  it("显式 false → undefined（关闭）", () => {
    expect(parseConfig({ persona: { sceneCompaction: false } }).persona.sceneCompaction).toBeUndefined();
  });

  it("true → 默认开启 0.7/0.5", () => {
    expect(parseConfig({ persona: { sceneCompaction: true } }).persona.sceneCompaction).toEqual({
      enabled: true,
      triggerRatio: 0.7,
      targetRatio: 0.5,
    });
  });

  it("对象：enabled 与比例透传；缺省比例回落 0.7/0.5", () => {
    expect(
      parseConfig({ persona: { sceneCompaction: { enabled: true, triggerRatio: 0.8, targetRatio: 0.4 } } }).persona
        .sceneCompaction,
    ).toEqual({ enabled: true, triggerRatio: 0.8, targetRatio: 0.4 });
    expect(parseConfig({ persona: { sceneCompaction: { enabled: true } } }).persona.sceneCompaction).toEqual({
      enabled: true,
      triggerRatio: 0.7,
      targetRatio: 0.5,
    });
    expect(parseConfig({ persona: { sceneCompaction: {} } }).persona.sceneCompaction).toEqual({
      enabled: false,
      triggerRatio: 0.7,
      targetRatio: 0.5,
    });
  });

  it("非法值 → throw（不静默回落）", () => {
    expect(() => parseConfig({ persona: { sceneCompaction: { triggerRatio: 0 } } })).toThrow(/sceneCompaction/);
    expect(() => parseConfig({ persona: { sceneCompaction: { targetRatio: 1 } } })).toThrow(/sceneCompaction/);
    expect(() =>
      parseConfig({ persona: { sceneCompaction: { triggerRatio: 0.5, targetRatio: 0.5 } } }),
    ).toThrow(/sceneCompaction/);
    expect(() => parseConfig({ persona: { sceneCompaction: { enabled: "on" } } })).toThrow(/sceneCompaction/);
    expect(() => parseConfig({ persona: { sceneCompaction: "on" } })).toThrow(/sceneCompaction/);
  });
});
