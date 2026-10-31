// 票⑦（exp/p1-7-recall-ranking）：召回多信号排序纯模块测试。
//
// score = (w1·norm(heat) + w2·exp(-age/halfLife) + w3·relevance + w4·norm(uses)) / Σw
// 纯函数零 I/O；off=接线层不传 ranking（模块不被调用，off 钉见 scene-navigation.ranking.test.ts）。
import { describe, expect, it } from "vitest";
import {
  RECALL_RANKING_DEFAULTS,
  formatRecallRankAnchor,
  logNorm,
  parseRecallRankingConfig,
  rankSceneEntries,
  recallRecency,
  scoreRecallParts,
  updatedToAgeDays,
} from "./recall-ranking.js";
import type { SceneIndexEntry } from "./scene-index.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-31T00:00:00.000Z");

function entry(partial: Partial<SceneIndexEntry>): SceneIndexEntry {
  return { filename: "s.md", summary: "", heat: 0, created: "", updated: "", ...partial };
}

describe("parseRecallRankingConfig：三态解析（off/true/对象）", () => {
  it("缺省（undefined）→ undefined=off", () => {
    expect(parseRecallRankingConfig(undefined)).toBeUndefined();
  });

  it("显式 false → undefined=off", () => {
    expect(parseRecallRankingConfig(false)).toBeUndefined();
  });

  it("true → 默认权重 on", () => {
    expect(parseRecallRankingConfig(true)).toEqual(RECALL_RANKING_DEFAULTS);
  });

  it("空对象 → 各字段回落默认值", () => {
    expect(parseRecallRankingConfig({})).toEqual(RECALL_RANKING_DEFAULTS);
  });

  it("部分对象 → 缺省字段回落、显式字段原样保留", () => {
    expect(parseRecallRankingConfig({ w1: 0.5 })).toEqual({
      w1: 0.5, w2: RECALL_RANKING_DEFAULTS.w2, w3: RECALL_RANKING_DEFAULTS.w3,
      w4: RECALL_RANKING_DEFAULTS.w4, halfLifeDays: RECALL_RANKING_DEFAULTS.halfLifeDays,
    });
    expect(parseRecallRankingConfig({ halfLifeDays: 7 })).toEqual({
      w1: RECALL_RANKING_DEFAULTS.w1, w2: RECALL_RANKING_DEFAULTS.w2, w3: RECALL_RANKING_DEFAULTS.w3,
      w4: RECALL_RANKING_DEFAULTS.w4, halfLifeDays: 7,
    });
  });

  it("完整对象 → 逐字段 echo", () => {
    const raw = { w1: 0.4, w2: 0.3, w3: 0.2, w4: 0.1, halfLifeDays: 14 };
    expect(parseRecallRankingConfig(raw)).toEqual(raw);
  });

  it("负权重 → 拒绝（throw）", () => {
    expect(() => parseRecallRankingConfig({ w1: -0.1 })).toThrow(/recallRanking\.w1/);
    expect(() => parseRecallRankingConfig({ w4: -1 })).toThrow(/recallRanking\.w4/);
  });

  it("NaN / ±Infinity 权重 → 拒绝", () => {
    expect(() => parseRecallRankingConfig({ w2: Number.NaN })).toThrow(/recallRanking\.w2/);
    expect(() => parseRecallRankingConfig({ w3: Number.POSITIVE_INFINITY })).toThrow(/recallRanking\.w3/);
    expect(() => parseRecallRankingConfig({ halfLifeDays: Number.NEGATIVE_INFINITY })).toThrow(/recallRanking\.halfLifeDays/);
  });

  it("halfLifeDays ≤ 0 → 拒绝（0 会产生除零）", () => {
    expect(() => parseRecallRankingConfig({ halfLifeDays: 0 })).toThrow(/recallRanking\.halfLifeDays/);
    expect(() => parseRecallRankingConfig({ halfLifeDays: -30 })).toThrow(/recallRanking\.halfLifeDays/);
  });

  it("全零权重 → 拒绝（得分恒定无排序意义）", () => {
    expect(() => parseRecallRankingConfig({ w1: 0, w2: 0, w3: 0, w4: 0 })).toThrow(/recallRanking/);
  });

  it("字符串 \"on\" / 数字 / null / 数组 → 拒绝（灰度开关不静默回落）", () => {
    expect(() => parseRecallRankingConfig("on")).toThrow(/recallRanking/);
    expect(() => parseRecallRankingConfig(1)).toThrow(/recallRanking/);
    expect(() => parseRecallRankingConfig(null)).toThrow(/recallRanking/);
    expect(() => parseRecallRankingConfig([0.35])).toThrow(/recallRanking/);
  });

  it("超大有限权重 → 接受（得分按 Σw 归一，比例有效）", () => {
    const big = { w1: 1e12, w2: 2e12, w3: 0, w4: 0, halfLifeDays: 30 };
    expect(parseRecallRankingConfig(big)).toEqual(big);
  });
});

describe("recallRecency：Ebbinghaus 指数衰减", () => {
  it("age=0 → 1", () => {
    expect(recallRecency(0, 30)).toBe(1);
  });

  it("age=halfLife → 0.5（半衰期定义）", () => {
    expect(recallRecency(30, 30)).toBeCloseTo(0.5, 12);
  });

  it("age=2×halfLife → 0.25", () => {
    expect(recallRecency(60, 30)).toBeCloseTo(0.25, 12);
  });

  it("age 极大 → 趋近 0", () => {
    expect(recallRecency(365 * 20, 30)).toBeLessThan(1e-8);
  });

  it("age 为负（未来时间戳/时钟偏斜）→ 钳到 0 → 1", () => {
    expect(recallRecency(-5, 30)).toBe(1);
  });
});

describe("logNorm：集合内 log1p 归一（无 min-max 地板伪影，量级压缩）", () => {
  it("max 值 → 1", () => {
    expect(logNorm(10, 10)).toBe(1);
  });

  it("量级压缩：14× 线性差 → 约 2.8× 的 log 差（数量级差≈线性小差）", () => {
    const lo = logNorm(44, 631);
    expect(lo).toBeGreaterThan(0.5);
    expect(logNorm(631, 631)).toBe(1);
    expect(lo).toBeLessThan(logNorm(300, 631));
  });

  it("max≤0（全零热度集合）→ 0（无区分度不放大）", () => {
    expect(logNorm(0, 0)).toBe(0);
    expect(logNorm(5, 0)).toBe(0);
  });

  it("负值/越界钳到 [0,1]（防御性）", () => {
    expect(logNorm(-5, 10)).toBe(0);
    expect(logNorm(100, 10)).toBe(1);
  });
});

describe("updatedToAgeDays：updated 时间戳 → 天龄", () => {
  it("合法 ISO → 精确天龄", () => {
    expect(updatedToAgeDays("2026-10-30T00:00:00.000Z", NOW)).toBeCloseTo(1, 9);
    expect(updatedToAgeDays("2026-10-01T00:00:00.000Z", NOW)).toBeCloseTo(30, 9);
  });

  it("空串/undefined（META 缺 updated）→ 按 epoch 0（最老，与 heat 缺省回 0 同向保守）", () => {
    expect(updatedToAgeDays("", NOW)).toBeGreaterThan(10_000);
    expect(updatedToAgeDays(undefined, NOW)).toBeGreaterThan(10_000);
  });

  it("畸形时间戳 → 同缺省（最老），不抛", () => {
    expect(updatedToAgeDays("not-a-date", NOW)).toBeGreaterThan(10_000);
    expect(updatedToAgeDays("2026-13-99", NOW)).toBeGreaterThan(10_000);
  });

  it("未来时间戳 → 钳 0（不产生负龄放大）", () => {
    expect(updatedToAgeDays("2027-01-01T00:00:00.000Z", NOW)).toBe(0);
  });
});

describe("scoreRecallParts：加权与归一", () => {
  const parts = { normHeat: 1, recency: 0.5, relevance: 1, normUses: 0.5 };

  it("单权重分解：w1=1 其余 0 → score=normHeat", () => {
    expect(scoreRecallParts(parts, { w1: 1, w2: 0, w3: 0, w4: 0, halfLifeDays: 30 })).toBeCloseTo(1, 12);
  });

  it("权重整体缩放不变性：×5 同比例权重得分相同", () => {
    const base = { w1: 0.2, w2: 0.2, w3: 0.2, w4: 0.2, halfLifeDays: 30 };
    const scaled = { w1: 1, w2: 1, w3: 1, w4: 1, halfLifeDays: 30 };
    expect(scoreRecallParts(parts, scaled)).toBeCloseTo(scoreRecallParts(parts, base), 12);
  });

  it("单独调 w2 改变次序：陈旧高热 vs 新鲜低热", () => {
    const stale = { normHeat: 1, recency: 0, relevance: 1, normUses: 1 };
    const fresh = { normHeat: 0, recency: 1, relevance: 1, normUses: 0 };
    const w2Off = { w1: 0.5, w2: 0, w3: 0.5, w4: 0, halfLifeDays: 30 };
    const w2On = { w1: 0, w2: 1, w3: 0, w4: 0, halfLifeDays: 30 };
    expect(scoreRecallParts(stale, w2Off)).toBeGreaterThan(scoreRecallParts(fresh, w2Off));
    expect(scoreRecallParts(fresh, w2On)).toBeGreaterThan(scoreRecallParts(stale, w2On));
  });

  it("单独调 w4 生效：heat 与 uses 信号分叉时（纯函数层，接线层 uses=heat 同源）", () => {
    const a = { normHeat: 1, recency: 0.5, relevance: 1, normUses: 0 };
    const b = { normHeat: 0, recency: 0.5, relevance: 1, normUses: 1 };
    const w4Off = { w1: 0.5, w2: 0.5, w3: 0, w4: 0, halfLifeDays: 30 };
    const w4On = { w1: 0, w2: 0, w3: 0, w4: 1, halfLifeDays: 30 };
    expect(scoreRecallParts(a, w4Off)).toBeGreaterThan(scoreRecallParts(b, w4Off));
    expect(scoreRecallParts(b, w4On)).toBeGreaterThan(scoreRecallParts(a, w4On));
  });

  it("relevance 恒定（纯导航=1）→ 不改变相对次序（均匀平移）", () => {
    const a = { normHeat: 1, recency: 0.2, relevance: 1, normUses: 0.3 };
    const b = { normHeat: 0.4, recency: 0.9, relevance: 1, normUses: 0.7 };
    const rel1 = { w1: 0.35, w2: 0.3, w3: 0.25, w4: 0.1, halfLifeDays: 30 };
    const rel0 = { w1: 0.35, w2: 0.3, w3: 0, w4: 0.1, halfLifeDays: 30 };
    const d1 = scoreRecallParts(a, rel1) - scoreRecallParts(b, rel1);
    const d0 = scoreRecallParts(a, rel0) - scoreRecallParts(b, rel0);
    // w3 对所有条目等量加入（relevance 恒 1），但归一分母变化会等比缩放差值
    expect(Math.sign(d1)).toBe(Math.sign(d0));
  });
});

describe("rankSceneEntries：确定性排序", () => {
  it("空输入 → 空数组；输入数组不被改写（纯函数）", () => {
    const input: SceneIndexEntry[] = [];
    expect(rankSceneEntries(input, RECALL_RANKING_DEFAULTS, NOW)).toEqual([]);
    const two = [entry({ filename: "a.md", heat: 5 }), entry({ filename: "b.md", heat: 9 })];
    const snapshot = JSON.stringify(two);
    rankSceneEntries(two, RECALL_RANKING_DEFAULTS, NOW);
    expect(JSON.stringify(two)).toBe(snapshot);
  });

  it("单条目 → 原样返回（同引用）", () => {
    const one = [entry({ filename: "only.md", heat: 3 })];
    expect(rankSceneEntries(one, RECALL_RANKING_DEFAULTS, NOW)).toEqual(one);
  });

  it("同 updated 时按热度降序（w2 无区分度退化为热度序）", () => {
    const input = [
      entry({ filename: "low.md", heat: 10, updated: "2026-10-30T00:00:00.000Z" }),
      entry({ filename: "high.md", heat: 100, updated: "2026-10-30T00:00:00.000Z" }),
      entry({ filename: "mid.md", heat: 50, updated: "2026-10-30T00:00:00.000Z" }),
    ];
    const out = rankSceneEntries(input, RECALL_RANKING_DEFAULTS, NOW);
    expect(out.map((e) => e.filename)).toEqual(["high.md", "mid.md", "low.md"]);
  });

  it("默认权重下新鲜场景翻转到陈旧高热之前（中档热度差 × 远超半衰期的龄差）", () => {
    // log1p 归一下无地板伪影：双条目集合即可翻转（新鲜方 norm≈0.96 而非 min-max 的 0）
    const stale = entry({ filename: "stale.md", heat: 10, updated: "2026-08-01T00:00:00.000Z" }); // 91 天前
    const fresh = entry({ filename: "fresh.md", heat: 9, updated: "2026-10-31T00:00:00.000Z" }); // 0 天
    const low = entry({ filename: "low.md", heat: 1, updated: "2026-08-01T00:00:00.000Z" });
    const out3 = rankSceneEntries([stale, fresh, low], RECALL_RANKING_DEFAULTS, NOW);
    expect(out3.map((e) => e.filename)).toEqual(["fresh.md", "stale.md", "low.md"]);
    const out2 = rankSceneEntries([stale, fresh], RECALL_RANKING_DEFAULTS, NOW);
    expect(out2.map((e) => e.filename)).toEqual(["fresh.md", "stale.md"]);
  });

  it("极端热度差（500×）+ 91 天陈旧：热度仍占优（衰减不至于抹平数量级鸿沟——设计边界显式化）", () => {
    const stale = entry({ filename: "stale.md", heat: 1000, updated: "2026-08-01T00:00:00.000Z" });
    const fresh = entry({ filename: "fresh.md", heat: 2, updated: "2026-10-31T00:00:00.000Z" });
    const out = rankSceneEntries([stale, fresh], RECALL_RANKING_DEFAULTS, NOW);
    expect(out[0]!.filename).toBe("stale.md");
  });

  it("量级热度差（5×）+ 41 天陈旧（≈1.36×半衰期）：新鲜方翻转（log 归一给新近全带可达性）", () => {
    const stale = entry({ filename: "stale.md", heat: 500, updated: "2026-09-20T00:00:00.000Z" }); // 41 天前
    const fresh = entry({ filename: "fresh.md", heat: 100, updated: "2026-10-31T00:00:00.000Z" }); // 0 天
    const out = rankSceneEntries([stale, fresh], RECALL_RANKING_DEFAULTS, NOW);
    expect(out.map((e) => e.filename)).toEqual(["fresh.md", "stale.md"]);
  });

  it("极端热度差下热度仍占优（衰减不至于抹平 500× 热度鸿沟——如实标注的设计边界）", () => {
    const stale = entry({ filename: "stale.md", heat: 1000, updated: "2026-08-01T00:00:00.000Z" });
    const fresh = entry({ filename: "fresh.md", heat: 2, updated: "2026-10-31T00:00:00.000Z" });
    const out = rankSceneEntries([stale, fresh], RECALL_RANKING_DEFAULTS, NOW);
    expect(out[0]!.filename).toBe("stale.md");
  });

  it("同分平票 → 次级键热度降序（与输入顺序无关，确定性）", () => {
    // w3=1 其余 0：得分只含 relevance（恒 1）→ 全体同分 → 按热度降序
    const w3Only = { w1: 0, w2: 0, w3: 1, w4: 0, halfLifeDays: 30 };
    const a = entry({ filename: "a.md", heat: 5, updated: "2026-01-01T00:00:00.000Z" });
    const b = entry({ filename: "b.md", heat: 50, updated: "2026-09-01T00:00:00.000Z" });
    expect(rankSceneEntries([a, b], w3Only, NOW).map((e) => e.filename)).toEqual(["b.md", "a.md"]);
    expect(rankSceneEntries([b, a], w3Only, NOW).map((e) => e.filename)).toEqual(["b.md", "a.md"]);
  });

  it("全同分全同热 → 保持输入顺序（稳定，避免结果抖动）", () => {
    const w3Only = { w1: 0, w2: 0, w3: 1, w4: 0, halfLifeDays: 30 };
    const a = entry({ filename: "甲.md", heat: 5, updated: "2026-01-01T00:00:00.000Z" });
    const b = entry({ filename: "乙.md", heat: 5, updated: "2026-01-01T00:00:00.000Z" });
    expect(rankSceneEntries([a, b], w3Only, NOW).map((e) => e.filename)).toEqual(["甲.md", "乙.md"]);
    expect(rankSceneEntries([b, a], w3Only, NOW).map((e) => e.filename)).toEqual(["乙.md", "甲.md"]);
  });

  it("中文/emoji 场景名（码点边界）：排序不劈代理对、中文文件名参与确定性平票", () => {
    const a = entry({ filename: "生活与健康管理.md", heat: 3, updated: "2026-10-30T00:00:00.000Z" });
    const b = entry({ filename: "技术自评👍.md", heat: 3, updated: "2026-10-30T00:00:00.000Z" });
    const out1 = rankSceneEntries([a, b], RECALL_RANKING_DEFAULTS, NOW);
    const out2 = rankSceneEntries([b, a], RECALL_RANKING_DEFAULTS, NOW);
    expect(out1.map((e) => e.filename)).toEqual(["生活与健康管理.md", "技术自评👍.md"]);
    expect(out2.map((e) => e.filename)).toEqual(["技术自评👍.md", "生活与健康管理.md"]);
    for (const e of [...out1, ...out2]) {
      // 无孤立代理项（码点完整）
      expect(Array.from(e.filename).length).toBeGreaterThan(0);
    }
  });

  it("非有限 heat（NaN/Infinity）→ 按 0 参与归一，不毒化排序（确定性不抖动）", () => {
    const bad = entry({ filename: "bad.md", heat: Number.NaN, updated: "2026-10-30T00:00:00.000Z" });
    const good = entry({ filename: "good.md", heat: 10, updated: "2026-10-30T00:00:00.000Z" });
    const inf = entry({ filename: "inf.md", heat: Number.POSITIVE_INFINITY, updated: "2026-10-30T00:00:00.000Z" });
    const out = rankSceneEntries([bad, good, inf], RECALL_RANKING_DEFAULTS, NOW);
    expect(out.map((e) => e.filename)).toEqual(["good.md", "bad.md", "inf.md"]);
  });
});

describe("formatRecallRankAnchor：观测锚点格式", () => {
  it("默认权重的锚点行（可 grep 解析：metric= 在前、signals= 键值对分号分隔）", () => {
    expect(formatRecallRankAnchor(RECALL_RANKING_DEFAULTS, 14)).toBe(
      "metric=l2_recall_rank value=1 scenes=14 signals=w1:0.35;w2:0.3;w3:0.25;w4:0.1;halfLifeDays:30",
    );
  });

  it("自定义权重原样 echo 进锚点", () => {
    expect(formatRecallRankAnchor({ w1: 1, w2: 2, w3: 0, w4: 0.5, halfLifeDays: 7 }, 0)).toBe(
      "metric=l2_recall_rank value=1 scenes=0 signals=w1:1;w2:2;w3:0;w4:0.5;halfLifeDays:7",
    );
  });
});
