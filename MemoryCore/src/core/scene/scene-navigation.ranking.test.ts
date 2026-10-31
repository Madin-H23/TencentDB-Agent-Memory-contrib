// 票⑦（exp/p1-7-recall-ranking）：renderSceneNavigation 排序接线 + off 兼容钉。
//
// 装配面判定：scene-navigation.ts:110 的 heat 降序是全仓唯一「按热度排序」的召回
// 收口点（grep 佐证）；本测试钉住两件事——
// ① off（不传 opts.ranking）：与 develop 基线（6890d9e）**双版本同进程逐字节一致**，
//    基线经 `git show 6890d9e:MemoryCore/<file>` 独立再生（非固定 hash 自证）；
// ② on（传 opts.ranking）：顺序按多信号改变 + 观测锚点恰打一行（off 零输出）。
import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { generateSceneNavigation, renderSceneNavigation } from "./scene-navigation.js";
import type { SceneNavigationRenderOptions } from "./scene-navigation.js";
import {
  RECALL_RANKING_DEFAULTS,
  formatRecallRankAnchor,
} from "./recall-ranking.js";
import type { ResolvedRecallRanking } from "./recall-ranking.js";
import type { SceneIndexEntry } from "./scene-index.js";

const BASELINE_REV = "6890d9e";
const BASELINE_FILES = [
  "src/core/scene/scene-navigation.ts",
  "src/utils/pii-redact.ts",
];

async function loadBaselineNavigationModule(): Promise<{
  renderSceneNavigation: (entries: SceneIndexEntry[], opts: SceneNavigationRenderOptions) => string;
  generateSceneNavigation: (entries: SceneIndexEntry[], dataDir?: string, useCos?: boolean) => string;
}> {
  const tmpRoot = await fs.mkdtemp(path.join(process.cwd(), ".p7-pin-baseline-"));
  for (const rel of BASELINE_FILES) {
    const content = execSync(`git show ${BASELINE_REV}:MemoryCore/${rel}`, {
      cwd: path.resolve(process.cwd(), ".."),
      maxBuffer: 16 * 1024 * 1024,
    });
    const dest = path.join(tmpRoot, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content);
  }
  const mod = await import(pathToFileURL(path.join(tmpRoot, "src/core/scene/scene-navigation.ts")).href);
  await fs.rm(tmpRoot, { recursive: true, force: true });
  return mod as unknown as {
    renderSceneNavigation: (entries: SceneIndexEntry[], opts: SceneNavigationRenderOptions) => string;
    generateSceneNavigation: (entries: SceneIndexEntry[], dataDir?: string, useCos?: boolean) => string;
  };
}

const NOW = Date.parse("2026-10-31T00:00:00.000Z");
const DAY = 86_400_000;

function entry(partial: Partial<SceneIndexEntry>): SceneIndexEntry {
  return { filename: "s.md", summary: "", heat: 0, created: "", updated: "", ...partial };
}

function opts(over: Partial<SceneNavigationRenderOptions> = {}): SceneNavigationRenderOptions {
  return {
    pathFor: (e) => `scene_blocks/${e.filename}`,
    readTool: "read",
    footer: "FOOTER",
    ...over,
  };
}

const ENTRY_SETS: SceneIndexEntry[][] = [
  [],
  [entry({ filename: "only.md", heat: 7 })],
  // 热度平票（输入序敏感）+ 中文/emoji 文件名（码点边界）
  [
    entry({ filename: "生活与健康管理.md", heat: 50, summary: "健康与作息安排", updated: "2026-10-01T00:00:00.000Z" }),
    entry({ filename: "技术自评👍.md", heat: 50, summary: "技术", updated: "2026-09-01T00:00:00.000Z" }),
    entry({ filename: "z-last.md", heat: 200, summary: "z", updated: "2026-08-01T00:00:00.000Z" }),
  ],
  // 大集合（覆盖多组 min/max 组合）
  Array.from({ length: 40 }, (_, i) =>
    entry({ filename: `scene-${String(i).padStart(2, "0")}.md`, heat: (i * 37) % 500, updated: new Date(NOW - i * 3 * DAY).toISOString() })),
];

describe("票⑦ off 兼容钉（双版本同进程，基线=git show 6890d9e）", () => {
  it("off：4 组输入 × renderSceneNavigation 与基线逐字节一致", async () => {
    const baseline = await loadBaselineNavigationModule();
    for (const entries of ENTRY_SETS) {
      expect(renderSceneNavigation(entries, opts())).toBe(baseline.renderSceneNavigation(entries, opts()));
    }
  });

  it("off：generateSceneNavigation（含 dataDir/useCos 两形态）与基线逐字节一致", async () => {
    const baseline = await loadBaselineNavigationModule();
    const entries = ENTRY_SETS[2]!;
    expect(generateSceneNavigation(entries)).toBe(baseline.generateSceneNavigation(entries));
    expect(generateSceneNavigation(entries, "/tmp/data")).toBe(baseline.generateSceneNavigation(entries, "/tmp/data"));
  });

  it("off：显式 ranking=undefined 与不传同形（调用方缺省穿线的安全网）", async () => {
    const baseline = await loadBaselineNavigationModule();
    const entries = ENTRY_SETS[2]!;
    expect(renderSceneNavigation(entries, opts({ ranking: undefined }))).toBe(
      baseline.renderSceneNavigation(entries, opts()),
    );
  });
});

describe("票⑦ on：多信号排序接线", () => {
  it("on：陈旧高热与新鲜中热翻转（off 序 → on 序按半衰期衰减重排）", () => {
    const stale = entry({ filename: "stale.md", heat: 100, updated: "2026-08-01T00:00:00.000Z" });
    const fresh = entry({ filename: "fresh.md", heat: 90, updated: "2026-10-31T00:00:00.000Z" });
    const third = entry({ filename: "mid.md", heat: 10, updated: "2026-10-30T00:00:00.000Z" });
    const off = renderSceneNavigation([stale, fresh, third], opts());
    const on = renderSceneNavigation([stale, fresh, third], opts({ ranking: RECALL_RANKING_DEFAULTS, nowMs: NOW }));
    // off 序：stale(100) > fresh(90) > mid(10)
    expect(off.indexOf("### Path: scene_blocks/stale.md")).toBeLessThan(off.indexOf("### Path: scene_blocks/fresh.md"));
    // on 序：fresh 翻到 stale 前（91 天龄 vs 0 天，热度差 10%）
    expect(on.indexOf("### Path: scene_blocks/fresh.md")).toBeLessThan(on.indexOf("### Path: scene_blocks/stale.md"));
    // on 与 off 输出不同（排序真的动了）
    expect(on).not.toBe(off);
  });

  it("on：渲染内容逐字不变（只动顺序——条目行文本与 off 渲染同集合同集合行）", () => {
    const entries = ENTRY_SETS[2]!;
    const off = renderSceneNavigation(entries, opts());
    const on = renderSceneNavigation(entries, opts({ ranking: RECALL_RANKING_DEFAULTS, nowMs: NOW }));
    const blockOf = (text: string) =>
      text.split("\n\n").filter((b) => b.startsWith("### Path:")).sort();
    // 同一集合的行块（脱敏/emoji/热度行）逐字节一致，只是块顺序不同
    expect(blockOf(on)).toEqual(blockOf(off));
  });

  it("on：观测锚点恰打一行（onRanked 回调）；off 零输出", () => {
    const entries = ENTRY_SETS[2]!;
    const lines: string[] = [];
    renderSceneNavigation(entries, opts({
      ranking: RECALL_RANKING_DEFAULTS,
      nowMs: NOW,
      onRanked: (line) => lines.push(line),
    }));
    expect(lines).toEqual([formatRecallRankAnchor(RECALL_RANKING_DEFAULTS, entries.length)]);
    expect(lines[0]).toContain("metric=l2_recall_rank value=1");

    const offLines: string[] = [];
    renderSceneNavigation(entries, opts({ onRanked: (line) => offLines.push(line) }));
    expect(offLines).toEqual([]);
  });

  it("on：空索引不出锚点（entries 为空直接返回空串）", () => {
    const lines: string[] = [];
    const out = renderSceneNavigation([], opts({
      ranking: RECALL_RANKING_DEFAULTS,
      nowMs: NOW,
      onRanked: (line) => lines.push(line),
    }));
    expect(out).toBe("");
    expect(lines).toEqual([]);
  });
});

describe("票⑦ generateSceneNavigation 第 4/5 参穿线（on 形态）", () => {
  it("on：generateSceneNavigation(entries, undefined, false, ranking, onRanked) 生效", () => {
    const stale = entry({ filename: "stale.md", heat: 100, updated: "2026-08-01T00:00:00.000Z" });
    const fresh = entry({ filename: "fresh.md", heat: 90, updated: "2026-10-31T00:00:00.000Z" });
    const low = entry({ filename: "low.md", heat: 5, updated: "2026-08-01T00:00:00.000Z" });
    const lines: string[] = [];
    const on = generateSceneNavigation([stale, fresh, low], undefined, false, RECALL_RANKING_DEFAULTS, (l) => lines.push(l));
    expect(on.indexOf("### Path: scene_blocks/fresh.md")).toBeLessThan(on.indexOf("### Path: scene_blocks/stale.md"));
    expect(lines).toEqual([formatRecallRankAnchor(RECALL_RANKING_DEFAULTS, 3)]);
  });
});

describe("票⑦ 默认权重语义（排序免疫性/敏感性的显式口径）", () => {
  const w = (over: Partial<ResolvedRecallRanking>): ResolvedRecallRanking => ({
    ...RECALL_RANKING_DEFAULTS, ...over,
  });

  it("relevance 恒 1 时 w3 不影响相对次序（全条目等量平移）", () => {
    const entries = ENTRY_SETS[3]!;
    const withW3 = renderSceneNavigation(entries, opts({ ranking: RECALL_RANKING_DEFAULTS, nowMs: NOW }));
    const noW3 = renderSceneNavigation(entries, opts({ ranking: w({ w3: 0 }), nowMs: NOW }));
    expect(withW3).toBe(noW3);
  });

  it("halfLifeDays 边界：age=0 与极大 age 分别给满/零衰减分", () => {
    const nowEntry = entry({ filename: "now.md", heat: 5, updated: new Date(NOW).toISOString() });
    const ancient = entry({ filename: "old.md", heat: 5, updated: "1970-01-01T00:00:00.000Z" });
    const out = renderSceneNavigation([ancient, nowEntry], opts({ ranking: RECALL_RANKING_DEFAULTS, nowMs: NOW }));
    expect(out.indexOf("### Path: scene_blocks/now.md")).toBeLessThan(out.indexOf("### Path: scene_blocks/old.md"));
  });
});
