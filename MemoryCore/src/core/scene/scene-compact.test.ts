// 票⑧（exp/p1-8-scene-compaction）：确定性压实纯函数 compactSceneBlock 的契约测试。
// 规则口径见 scene-compact.ts 模块头：只折叠 `## 活动` 段内无锚点行（且含锚点行永不
// 删除/改写）、从最旧一端（活动段尾部）开始、折到 target 即停、不足则
// reason=insufficient_archive（绝不截断事实/要点）。
import { describe, expect, it } from "vitest";
import { compactSceneBlock, parseSceneCompactionConfig } from "./scene-compact.js";
import { findV2Sections, toV2Format } from "./scene-format-v2.js";
import { ANCHOR_RE } from "../../utils/supersede.js";

const OLD_ID = "m_1793300000000_cccccccc";
const MID_ID = "m_1793400000000_bbbbbbbb";
const NEW_ID = "m_1793500000000_aaaaaaaa";

/** 批次追加式 v1 文件：最新批次在文件前部，最旧批次在文件尾部（与生产实盘同向）。 */
function v1File(): string {
  return [
    "-----META-START-----",
    "created: 2026-10-01T00:00:00.000Z",
    "updated: 2026-10-31T00:00:00.000Z",
    "summary: 测试场景摘要（无锚点）",
    "heat: 7",
    "-----META-END-----",
    "",
    "## ★10-31 10:00Z 本批·最新批次（新增事实一笔）",
    "",
    "- 最新批次叙述行甲：这是用于填充分量的长叙述内容，确保折叠一行即可净减少文件字符数。",
    `- 最新批次事实乙（${NEW_ID}）`,
    "",
    "## ★10-30 10:00Z 本批·中间批次（新增事实一笔）",
    "",
    "- 中间批次叙述行甲：这是用于填充分量的长叙述内容，确保折叠一行即可净减少文件字符数。",
    `- 中间批次事实乙（${MID_ID}）`,
    "",
    "## ★10-29 10:00Z 本批·最旧批次（新增事实一笔）",
    "",
    // 最旧批叙述刻意加长：保证「只折最旧一端」时单行折叠即可达到目标（方向钉证据）
    `- 最旧批次叙述行甲：${"用于填充分量的长叙述内容。".repeat(10)}`,
    `- 最旧批次事实乙（${OLD_ID}）`,
  ].join("\n");
}

function anchorsOf(s: string): string[] {
  return (s.match(ANCHOR_RE) ?? []).sort();
}

/** 取某 v2 段（含段标题行）的逐字节文本，用于「事实/要点段未被触碰」断言。 */
function sectionText(raw: string, key: "gist" | "facts" | "archive"): string {
  const span = findV2Sections(raw)[key];
  if (!span) return "";
  return raw.split("\n").slice(span.start, span.end).join("\n");
}

describe("compactSceneBlock：阈值与保守返回", () => {
  it("未超阈值（length <= triggerChars）→ 原样返回，compacted=false，零折叠", () => {
    const raw = v1File();
    const r = compactSceneBlock(raw, { triggerChars: raw.length, targetChars: 10 });
    expect(r.compacted).toBe(false);
    expect(r.content).toBe(raw);
    expect(r.beforeChars).toBe(raw.length);
    expect(r.afterChars).toBe(raw.length);
    expect(r.foldedLines).toBe(0);
  });

  it("META 缺失 → 原样返回（不破坏）；META 畸形（END 在 START 前）同理", () => {
    const noMeta = ["## 活动", "", ...Array.from({ length: 40 }, (_, i) => `- 无 META 叙述行 ${i}，用于超过小阈值。`)].join("\n");
    const r1 = compactSceneBlock(noMeta, { triggerChars: 10, targetChars: 1 });
    expect(r1.compacted).toBe(false);
    expect(r1.content).toBe(noMeta);

    const broken = ["-----META-END-----", "summary: x", "-----META-START-----", "## 活动", "- 叙述"].join("\n");
    const r2 = compactSceneBlock(broken, { triggerChars: 10, targetChars: 1 });
    expect(r2.compacted).toBe(false);
    expect(r2.content).toBe(broken);
  });

  it("非法选项（NaN / 非正 trigger / 负 target）→ 原样返回（防御性 no-op）", () => {
    const raw = v1File();
    for (const opts of [
      { triggerChars: Number.NaN, targetChars: 1 },
      { triggerChars: 0, targetChars: 1 },
      { triggerChars: 100, targetChars: -1 },
      { triggerChars: Number.POSITIVE_INFINITY, targetChars: 1 },
    ]) {
      const r = compactSceneBlock(raw, opts);
      expect(r.compacted).toBe(false);
      expect(r.content).toBe(raw);
    }
  });
});

describe("compactSceneBlock：v1 → v2 迁移后压实", () => {
  it("v1 输入先 toV2Format（含 ## 要点 投影）再折叠活动段", () => {
    const raw = v1File();
    const r = compactSceneBlock(raw, { triggerChars: raw.length - 1, targetChars: raw.length - 100 });
    expect(r.compacted).toBe(true);
    expect(r.content).toContain("## 要点");
    expect(r.content).toContain("测试场景摘要（无锚点）");
    expect(r.content).toContain("## 事实");
    expect(r.content).toContain("## 活动");
    expect(r.beforeChars).toBe(raw.length);
    expect(r.afterChars).toBe(r.content.length);
    expect(r.afterChars).toBeLessThanOrEqual(raw.length - 100);
    expect(r.foldedLines).toBeGreaterThan(0);
  });

  it("折叠方向：活动段尾部（最旧批）先折，最新/中间批叙述优先保留", () => {
    const raw = v1File();
    const migrated = toV2Format(raw);
    // 目标只够折掉一条长叙述行（+ 标记行开销），必须落在最旧一端
    const r = compactSceneBlock(raw, { triggerChars: raw.length - 1, targetChars: migrated.length - 20 });
    expect(r.compacted).toBe(true);
    expect(r.content).not.toContain("最旧批次叙述行甲");
    expect(r.content).toContain("中间批次叙述行甲");
    expect(r.content).toContain("最新批次叙述行甲");
  });
});

describe("compactSceneBlock：只动活动段，事实/要点逐字节不变", () => {
  it("要点段与事实段在压实前后逐字节一致；锚点集合 lost=0", () => {
    const raw = v1File();
    const migrated = toV2Format(raw);
    const r = compactSceneBlock(raw, { triggerChars: raw.length - 1, targetChars: raw.length - 100 });
    expect(sectionText(r.content, "facts")).toBe(sectionText(migrated, "facts"));
    expect(sectionText(r.content, "gist")).toBe(sectionText(migrated, "gist"));
    expect(anchorsOf(r.content)).toEqual(anchorsOf(raw));
    expect(anchorsOf(r.content)).toEqual([OLD_ID, MID_ID, NEW_ID].sort());
  });

  it("活动段内的锚点行永不删除/改写（即使被折叠区域包围）", () => {
    const raw = [
      "-----META-START-----",
      "created: 2026-10-01T00:00:00.000Z",
      "updated: 2026-10-31T00:00:00.000Z",
      "summary: 已 v2 的场景摘要",
      "heat: 3",
      "-----META-END-----",
      "",
      "## 要点",
      "已 v2 的场景摘要",
      "",
      "## 事实",
      `- 事实行一（${NEW_ID}）`,
      "",
      "## 活动",
      "- 新批叙述行：这是用于填充分量的长叙述内容，确保折叠能净减少字符数。",
      `- 新批活动内的锚点行（${MID_ID}）`,
      "- 旧批叙述行：这是用于填充分量的长叙述内容，确保折叠能净减少字符数。",
      `- 旧批活动内的锚点行（${OLD_ID}）`,
    ].join("\n");
    const r = compactSceneBlock(raw, { triggerChars: raw.length - 1, targetChars: 1 });
    expect(r.compacted).toBe(true);
    expect(r.reason).toBe("insufficient_archive");
    // 活动段锚点行原样保留在活动段（即位于 `## 活动` 之后）
    const archive = sectionText(r.content, "archive");
    expect(archive).toContain(`- 新批活动内的锚点行（${MID_ID}）`);
    expect(archive).toContain(`- 旧批活动内的锚点行（${OLD_ID}）`);
    // 无锚点叙述行全部折叠
    expect(r.content).not.toContain("新批叙述行");
    expect(r.content).not.toContain("旧批叙述行");
    expect(r.keptAnchorLines).toBe(2);
    // 事实段与要点段不动
    expect(sectionText(r.content, "facts")).toBe(sectionText(raw, "facts"));
    expect(sectionText(r.content, "gist")).toBe(sectionText(raw, "gist"));
    expect(anchorsOf(r.content)).toEqual(anchorsOf(raw));
  });

  it("折叠标记行格式固定：`- [compacted] 更早 N 条批次叙事已折叠（原始内容见 .backup 快照）`", () => {
    const raw = v1File();
    const r = compactSceneBlock(raw, { triggerChars: raw.length - 1, targetChars: 1 });
    const marker = r.content.split("\n").filter((l) => l.includes("[compacted]"));
    expect(marker).toHaveLength(1);
    expect(marker[0]).toMatch(/^- \[compacted\] 更早 \d+ 条批次叙事已折叠（原始内容见 \.backup 快照）$/);
    // N 与本次折叠行数一致
    expect(marker[0]).toContain(`更早 ${r.foldedLines} 条`);
  });
});

describe("compactSceneBlock：target 到点即停 / 不足则如实标注", () => {
  it("折到 afterChars <= target 即停；target 越紧折叠行数越多（单调）", () => {
    const raw = v1File();
    const loose = compactSceneBlock(raw, { triggerChars: raw.length - 1, targetChars: raw.length - 1 });
    const tight = compactSceneBlock(raw, { triggerChars: raw.length - 1, targetChars: raw.length - 150 });
    expect(loose.compacted).toBe(true);
    expect(loose.afterChars).toBeLessThanOrEqual(raw.length - 1);
    expect(loose.reason).toBeUndefined();
    expect(tight.afterChars).toBeLessThanOrEqual(raw.length - 150);
    expect(tight.foldedLines).toBeGreaterThan(loose.foldedLines);
  });

  it("可折叠行折完仍 > target → reason=insufficient_archive，绝不截断事实/要点/锚点", () => {
    const raw = v1File();
    const migrated = toV2Format(raw);
    const r = compactSceneBlock(raw, { triggerChars: raw.length - 1, targetChars: 1 });
    expect(r.compacted).toBe(true);
    expect(r.reason).toBe("insufficient_archive");
    expect(r.afterChars).toBeGreaterThan(1);
    expect(sectionText(r.content, "facts")).toBe(sectionText(migrated, "facts"));
    expect(sectionText(r.content, "gist")).toBe(sectionText(migrated, "gist"));
    expect(anchorsOf(r.content)).toEqual(anchorsOf(raw));
    // 活动段只剩标记行（及可能的锚点行），没有无锚点叙述残留
    expect(r.content).not.toContain("批次叙述行甲");
  });

  it("不存在无锚点可折叠行（活动段为空/全锚点）→ 不压实，原样返回", () => {
    const raw = [
      "-----META-START-----",
      "created: 2026-10-01T00:00:00.000Z",
      "updated: 2026-10-31T00:00:00.000Z",
      "summary: 全锚点场景",
      "heat: 1",
      "-----META-END-----",
      "",
      "## 要点",
      "全锚点场景",
      "",
      "## 事实",
      `- 事实（${OLD_ID}）`,
      "",
      "## 活动",
      `- 活动锚点行（${MID_ID}）`,
    ].join("\n");
    const r = compactSceneBlock(raw, { triggerChars: 10, targetChars: 1 });
    expect(r.compacted).toBe(false);
    expect(r.content).toBe(raw);
    expect(r.reason).toBe("insufficient_archive");
  });
});

describe("compactSceneBlock：幂等", () => {
  it("对已压实且 ≤ trigger 的结果再次调用 → 原样（compacted=false）", () => {
    const raw = v1File();
    const first = compactSceneBlock(raw, { triggerChars: raw.length - 1, targetChars: raw.length - 100 });
    expect(first.compacted).toBe(true);
    const second = compactSceneBlock(first.content, { triggerChars: first.content.length, targetChars: 10 });
    expect(second.compacted).toBe(false);
    expect(second.content).toBe(first.content);
  });

  it("已压实结果仍超 trigger 但已无可折叠行 → 不再改写（内容不变）", () => {
    const raw = v1File();
    const first = compactSceneBlock(raw, { triggerChars: raw.length - 1, targetChars: 1 });
    expect(first.reason).toBe("insufficient_archive");
    const second = compactSceneBlock(first.content, { triggerChars: first.content.length - 1, targetChars: 1 });
    expect(second.content).toBe(first.content);
    expect(second.foldedLines).toBe(0);
  });

  it("二次压实合并标记计数，不产生第二条标记行", () => {
    // 第一次只折一部分；随后追加新批次内容再压实 → 标记仍只有一条且计数累计
    const raw = v1File();
    const first = compactSceneBlock(raw, { triggerChars: raw.length - 1, targetChars: raw.length - 20 });
    expect(first.compacted).toBe(true);
    const grown = first.content.replace(
      "## 活动",
      [
        "## 活动",
        "- 新追加叙述行：这是用于填充分量的长叙述内容，确保折叠能净减少字符数。",
      ].join("\n"),
    );
    const second = compactSceneBlock(grown, { triggerChars: grown.length - 1, targetChars: grown.length - 20 });
    expect(second.compacted).toBe(true);
    const markers = second.content.split("\n").filter((l) => l.includes("[compacted]"));
    expect(markers).toHaveLength(1);
  });
});

describe("parseSceneCompactionConfig：默认关闭 + 非法值 throw", () => {
  it("缺省 / false / null → undefined（关闭，Phase 5 零 I/O）", () => {
    expect(parseSceneCompactionConfig(undefined)).toBeUndefined();
    expect(parseSceneCompactionConfig(false)).toBeUndefined();
    expect(parseSceneCompactionConfig(null)).toBeUndefined();
  });

  it("{} → enabled=false，比例回默认 0.7/0.5", () => {
    expect(parseSceneCompactionConfig({})).toEqual({ enabled: false, triggerRatio: 0.7, targetRatio: 0.5 });
  });

  it("true → 默认开启（0.7/0.5）", () => {
    expect(parseSceneCompactionConfig(true)).toEqual({ enabled: true, triggerRatio: 0.7, targetRatio: 0.5 });
  });

  it("对象：缺省字段回落默认，显式值生效", () => {
    expect(parseSceneCompactionConfig({ enabled: true })).toEqual({ enabled: true, triggerRatio: 0.7, targetRatio: 0.5 });
    expect(parseSceneCompactionConfig({ enabled: true, triggerRatio: 0.8, targetRatio: 0.4 })).toEqual({
      enabled: true,
      triggerRatio: 0.8,
      targetRatio: 0.4,
    });
  });

  it("非法 ratio（∉(0,1)）/ target >= trigger / enabled 非布尔 / 非对象类型 → throw", () => {
    for (const bad of [
      { triggerRatio: 0 },
      { triggerRatio: 1 },
      { triggerRatio: -0.1 },
      { triggerRatio: Number.NaN },
      { targetRatio: 0 },
      { targetRatio: 1 },
      { targetRatio: 1.2 },
      { targetRatio: Number.POSITIVE_INFINITY },
      { triggerRatio: 0.5, targetRatio: 0.5 },
      { triggerRatio: 0.4, targetRatio: 0.6 },
      { enabled: "true" },
      "on",
      1,
      [],
    ]) {
      expect(() => parseSceneCompactionConfig(bad)).toThrow(/sceneCompaction/);
    }
  });
});
