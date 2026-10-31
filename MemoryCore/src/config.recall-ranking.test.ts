// 票⑦（exp/p1-7-recall-ranking）：persona.recallRanking 配置解析。
// 默认 off（undefined）；true=默认权重；对象=校验合并；畸形=拒绝（throw，与
// extraction.dedupRecallRerank 的结构化开关拒绝先例一致——灰度开关不静默回落）。
import { describe, it, expect } from "vitest";
import { parseConfig } from "./config.js";
import { RECALL_RANKING_DEFAULTS } from "./core/scene/recall-ranking.js";

describe("parseConfig：persona.recallRanking 解析", () => {
  it("缺省 → undefined（off=行为与基线逐字节一致）", () => {
    expect(parseConfig({}).persona.recallRanking).toBeUndefined();
  });

  it("显式 false → undefined（off）；显式 true → 默认权重（on）", () => {
    expect(parseConfig({ persona: { recallRanking: false } }).persona.recallRanking).toBeUndefined();
    expect(parseConfig({ persona: { recallRanking: true } }).persona.recallRanking).toEqual(RECALL_RANKING_DEFAULTS);
  });

  it("对象 → 校验合并（缺省字段回落默认值）", () => {
    const cfg = parseConfig({ persona: { recallRanking: { w2: 0.5, halfLifeDays: 7 } } });
    expect(cfg.persona.recallRanking).toEqual({
      w1: RECALL_RANKING_DEFAULTS.w1, w2: 0.5, w3: RECALL_RANKING_DEFAULTS.w3,
      w4: RECALL_RANKING_DEFAULTS.w4, halfLifeDays: 7,
    });
  });

  it("负权重 / NaN / 非法类型 → 拒绝（throw，报文含 recallRanking）", () => {
    expect(() => parseConfig({ persona: { recallRanking: { w1: -1 } } })).toThrow(/recallRanking/);
    expect(() => parseConfig({ persona: { recallRanking: { halfLifeDays: 0 } } })).toThrow(/recallRanking/);
    expect(() => parseConfig({ persona: { recallRanking: "on" as unknown as boolean } })).toThrow(/recallRanking/);
    expect(() => parseConfig({ persona: { recallRanking: null as unknown as boolean } })).toThrow(/recallRanking/);
  });

  it("设置 recallRanking 不影响 persona 兄弟字段（parseConfig 吃 memory 子树，persona 为其顶层组）", () => {
    const cfg = parseConfig({ persona: { recallRanking: true, maxScenes: 24 } });
    expect(cfg.persona.recallRanking).toEqual(RECALL_RANKING_DEFAULTS);
    expect(cfg.persona.maxScenes).toBe(24);
    expect(cfg.persona.sceneFormatV2).toBe(false);
    expect(cfg.persona.explicitInvalidation).toBe(false);
  });
});
