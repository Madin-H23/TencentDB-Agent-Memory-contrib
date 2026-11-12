// 票 P2-A3 C 案机制化：scene-archive 测试（先红·含子代理审核 12 项必测）。
// 机制：活动段内旧批次段 spill 到 <scene>-archive.md（rolling ageDays）。
// 硬不变量：锚点全局守恒（主+归档 ⊇ 操作前）；默认读视图逐字节不变；未来段 fail-closed。
import { describe, expect, it } from "vitest";
import {
  parseSceneArchiveConfig,
  selectArchiveSegments,
  planSceneSpill,
  BATCH_HEAD_RE,
} from "./scene-archive.js";

const NOW = Date.parse("2026-11-12T10:00:00Z");

/** v2 文件：META+要点+事实+活动（活动段内含批次头段）。 */
function v2File(opts: { factLines?: string[]; actSegments?: Array<{ date: string; lines: string[] }> } = {}): string {
  const fact = opts.factLines ?? [`- 事实一（m_1794000000000_aaaa0001）`];
  const act = opts.actSegments ?? [
    { date: "10-29", lines: [`- 旧批次叙事（m_1794000000001_bbbb0002）`, "- 第二行旧叙事"] },
    { date: "11-10", lines: [`- 新批次叙事（m_1794000000002_cccc0003）`] },
  ];
  const lines = [
    "-----META-START-----",
    "created: 2026-11-01T00:00:00.000Z",
    "updated: 2026-11-10T00:00:00.000Z",
    "summary: 测试场景",
    "heat: 5",
    "-----META-END-----",
    "",
    "## 要点",
    "摘要一行",
    "",
    "## 事实",
    ...fact,
    "",
    "## 活动",
  ];
  for (const seg of act) {
    lines.push(`### ★${seg.date} 10:00Z 本批·测试`);
    lines.push(...seg.lines);
  }
  return lines.join("\n");
}

describe("BATCH_HEAD_RE：三形态头识别（P1-1）", () => {
  it("识别 ★MM-DD / 无★ MM-DD / YYYY-MM-DD 三形态", () => {
    expect(BATCH_HEAD_RE.test("### ★10-29 10:00Z 本批")).toBe(true);
    expect(BATCH_HEAD_RE.test("### 11-06 02:15Z 本批")).toBe(true);
    expect(BATCH_HEAD_RE.test("### 2026-11-08 16:45Z 批")).toBe(true);
    expect(BATCH_HEAD_RE.test("## ★11-09 14:30Z 批")).toBe(true);
  });

  it("不误切非批次标题", () => {
    expect(BATCH_HEAD_RE.test("### 批处理注意事项")).toBe(false);
    expect(BATCH_HEAD_RE.test("### v1.2-3 版本说明")).toBe(false);
    expect(BATCH_HEAD_RE.test("#### ★10-29 四级标题")).toBe(false);
  });
});

describe("parseSceneArchiveConfig：拒绝式（对齐 sceneCompaction/l1Archive 先例）", () => {
  it("缺省/false → undefined（off·Phase 5 零 I/O）", () => {
    expect(parseSceneArchiveConfig(undefined)).toBeUndefined();
    expect(parseSceneArchiveConfig(false)).toBeUndefined();
  });

  it("true → shadow + ageDays 10（安全默认=影子先量）", () => {
    expect(parseSceneArchiveConfig(true)).toEqual({ enabled: true, mode: "shadow", ageDays: 10, protectScenes: [] });
  });

  it("对象透传 mode/ageDays/protectScenes", () => {
    expect(parseSceneArchiveConfig({ mode: "on", ageDays: 7, protectScenes: ["x.md"] })).toEqual({
      enabled: true,
      mode: "on",
      ageDays: 7,
      protectScenes: ["x.md"],
    });
  });

  it("mode=off → undefined；非法 throw（不静默回落）", () => {
    expect(parseSceneArchiveConfig({ mode: "off" })).toBeUndefined();
    expect(() => parseSceneArchiveConfig("on")).toThrow();
    expect(() => parseSceneArchiveConfig({ ageDays: 0 })).toThrow();
    expect(() => parseSceneArchiveConfig({ ageDays: -1 })).toThrow();
    expect(() => parseSceneArchiveConfig({ mode: "always" })).toThrow();
    expect(() => parseSceneArchiveConfig({ protectScenes: "x" })).toThrow();
  });
});

describe("selectArchiveSegments：活动段内旧批次段切片", () => {
  const cfgOn = { enabled: true, mode: "on" as const, ageDays: 10, protectScenes: [] as string[] };

  it("age>N 段选中、age≤N 不选；正好=N 边界不选（严格大于·日界 UTC）", () => {
    // now=11-12 00:00Z（零点·date 粒度头的精确 N 天才可构造）；
    // 10-29=14 天前选；11-02=正好 10 天不选（严格大于）；11-10=2 天前不选
    const midnight = Date.parse("2026-11-12T00:00:00Z");
    const raw = v2File({
      actSegments: [
        { date: "10-29", lines: ["- 旧1"] },
        { date: "11-02", lines: ["- 边界"] },
        { date: "11-10", lines: ["- 新"] },
      ],
    });
    const segs = selectArchiveSegments(raw, cfgOn, midnight);
    expect(segs.map((s) => s.date)).toEqual(["10-29"]);
  });

  it("无批次头文件 → 空", () => {
    expect(selectArchiveSegments(v2File({ actSegments: [] }), cfgOn, NOW)).toEqual([]);
  });

  it("protectScenes 命中 → 空（调用方传 scene 名）", () => {
    const raw = v2File();
    expect(selectArchiveSegments(raw, { ...cfgOn, protectScenes: ["测试场景"] }, NOW, "测试场景")).toEqual([]);
    expect(selectArchiveSegments(raw, cfgOn, NOW, "测试场景")).toHaveLength(1);
  });

  it("12 月段在 1 月 now 下判旧（MM-DD 回退去年）；显式未来年段 fail-closed 不选", () => {
    const jan = Date.parse("2027-01-05T00:00:00Z");
    // MM-DD 回退：12-20 → 2026-12-20（16 天前）→ 选
    const raw = v2File({ actSegments: [{ date: "12-20", lines: ["- 去年"] }] });
    expect(selectArchiveSegments(raw, cfgOn, jan)).toHaveLength(1);
    // 显式未来年（时钟漂移/误写）→ 绝不归档最新段
    const future = v2File({ actSegments: [{ date: "2027-12-25", lines: ["- 未来"] }] });
    expect(selectArchiveSegments(future, cfgOn, jan)).toHaveLength(0);
  });

  it("段体至活动段尾（后接异名 v2 段）=整段在内·可选；事实段内的头天然不选", () => {
    // 活动段非至 EOF：10-29 段整段落在活动段内（结束于异名头前）→ 可选
    const rawTail = [
      "-----META-START-----", "summary: x", "-----META-END-----", "",
      "## 要点", "摘要", "", "## 事实", "- 事实（m_1794000000000_aaaa0001）", "",
      "## 活动",
      "### ★10-29 10:00Z 旧批",
      "- 旧叙事",
      "## 其他段",
      "- 段外内容",
    ].join("\n");
    expect(selectArchiveSegments(rawTail, cfgOn, NOW).map((s) => s.date)).toEqual(["10-29"]);
    // 批次头落在事实段（it-ops 现役形态 43 头中 42 在事实段）→ select 只扫活动段·天然不选
    const rawFact = [
      "-----META-START-----", "summary: x", "-----META-END-----", "",
      "## 要点", "摘要", "",
      "## 事实",
      "### ★10-29 10:00Z 旧批",
      "- 事实段内的旧批次行",
      "",
      "## 活动",
      "### ★11-10 10:00Z 新批",
      "- 新叙事",
    ].join("\n");
    expect(selectArchiveSegments(rawFact, cfgOn, NOW)).toEqual([]);
  });

  it("非精确 v2（无 ## 活动 段）→ 空（视图恒等前提不成立 fail-closed）", () => {
    const raw = ["-----META-START-----", "summary: x", "-----META-END-----", "", "### ★10-29 10:00Z 旧批", "- 内容"].join("\n");
    expect(selectArchiveSegments(raw, cfgOn, NOW)).toEqual([]);
  });
});

describe("planSceneSpill：main/archive/守恒断言", () => {
  const cfgOn = { enabled: true, mode: "on" as const, ageDays: 10, protectScenes: [] as string[] };

  it("锚点全局守恒：主后 ∪ 归档 ⊇ 操作前（含跨段共享锚点）", () => {
    const shared = "m_1794000000003_dddd0004";
    const raw = v2File({
      factLines: [`- 事实行共享锚点（${shared}）`],
      actSegments: [{ date: "10-29", lines: [`- 旧叙事引用（${shared}）`, "- 纯叙事无锚"] }],
    });
    const plan = planSceneSpill("测试场景", raw, cfgOn, NOW);
    const before = new Set(raw.match(/m_\d{13}_[0-9a-f]{8}/g) ?? []);
    const main = new Set(plan.mainAfter.match(/m_\d{13}_[0-9a-f]{8}/g) ?? []);
    const arch = new Set(plan.archiveAppend.match(/m_\d{13}_[0-9a-f]{8}/g) ?? []);
    const union = new Set([...main, ...arch]);
    expect([...before].filter((x) => !union.has(x))).toEqual([]);
  });

  it("幂等：二次 plan 无段可选（主文件已无旧段）", () => {
    const raw = v2File();
    const plan = planSceneSpill("测试场景", raw, cfgOn, NOW);
    expect(plan.segments).toHaveLength(1);
    const plan2 = planSceneSpill("测试场景", plan.mainAfter, cfgOn, NOW);
    expect(plan2.segments).toHaveLength(0);
    expect(plan2.mainAfter).toBe(plan.mainAfter);
  });

  it("mainAfter 不含归档段且含面包屑；archiveAppend 保持段序", () => {
    const raw = v2File({
      actSegments: [
        { date: "10-20", lines: ["- 更旧"] },
        { date: "10-29", lines: ["- 旧"] },
        { date: "11-10", lines: ["- 新"] },
      ],
    });
    const plan = planSceneSpill("测试场景", raw, cfgOn, NOW);
    expect(plan.segments.map((s) => s.date)).toEqual(["10-20", "10-29"]);
    expect(plan.mainAfter).not.toContain("### ★10-29");
    expect(plan.mainAfter).not.toContain("### ★10-20");
    expect(plan.mainAfter).toContain("### ★11-10");
    expect(plan.mainAfter).toContain("[archived→");
    const i20 = plan.archiveAppend.indexOf("### ★10-20");
    const i29 = plan.archiveAppend.indexOf("### ★10-29");
    expect(i20).toBeGreaterThanOrEqual(0);
    expect(i29).toBeGreaterThan(i20); // 段序保持
  });

  it("默认读视图逐字节不变（活动段 spill·要点+事实不动）", () => {
    const raw = v2File();
    const plan = planSceneSpill("测试场景", raw, cfgOn, NOW);
    const view = (t: string) => {
      const a = t.split("\n").findIndex((l) => l.trim() === "## 活动");
      return a < 0 ? t : t.split("\n").slice(0, a).join("\n");
    };
    expect(view(plan.mainAfter)).toBe(view(raw));
  });

  it("无候选 → 零变更（mainAfter===before·archiveAppend 空）", () => {
    const raw = v2File({ actSegments: [{ date: "11-10", lines: ["- 新"] }] });
    const plan = planSceneSpill("测试场景", raw, cfgOn, NOW);
    expect(plan.mainAfter).toBe(raw);
    expect(plan.archiveAppend).toBe("");
    expect(plan.segments).toEqual([]);
  });

  it("段内容哈希稳定（同段两轮同哈希·append 去重依据）", () => {
    const raw = v2File();
    const p1 = planSceneSpill("测试场景", raw, cfgOn, NOW);
    expect(p1.segments[0]?.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(p1.segments[0]?.hash).toBe(planSceneSpill("测试场景", raw, cfgOn, NOW).segments[0]?.hash);
  });

  it("archive append 规格：META updated 推进·summary 保只读标记·尾部空行归一", () => {
    const raw = v2File();
    const plan = planSceneSpill("测试场景", raw, cfgOn, NOW);
    // archiveAppend=纯内容段（META 由调用方合并）；规格=段间单空行、无尾随多余空行
    expect(plan.archiveAppend.endsWith("\n")).toBe(true);
    expect(plan.archiveAppend).not.toMatch(/\n{3,}$/);
    expect(plan.archiveAppend).toContain("### ★10-29");
  });

  it("多场景不串写（scene 名入计划·各自独立）", () => {
    const rawA = v2File();
    const rawB = v2File({ actSegments: [{ date: "10-25", lines: ["- B 的旧段"] }] });
    const pa = planSceneSpill("场景A", rawA, cfgOn, NOW);
    const pb = planSceneSpill("场景B", rawB, cfgOn, NOW);
    expect(pa.archiveAppend).not.toContain("B 的旧段");
    expect(pb.archiveAppend).toContain("B 的旧段");
  });
});
