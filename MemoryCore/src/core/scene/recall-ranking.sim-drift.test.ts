// 票⑦（exp/p1-7-recall-ranking）：小金标脚本公式复刻的防漂移交叉校验。
// scripts/p1-7-recall-sim.mjs 的 rankOnMjs/rankOffMjs 与 TS rankSceneEntries 同构
// （票⑤ l2-index-sim.mjs 防漂移先例）——同输入双实现逐项同序断言，任一侧公式
// 演进未同步时此处红。
import { describe, expect, it } from "vitest";
import { rankSceneEntries, RECALL_RANKING_DEFAULTS } from "./recall-ranking.js";
import type { SceneIndexEntry } from "./scene-index.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports -- .mjs 无类型声明，动态加载
const sim = require("../../../scripts/p1-7-recall-sim.mjs") as {
  rankOffMjs: (entries: Array<SceneIndexEntry>) => SceneIndexEntry[];
  rankOnMjs: (entries: Array<SceneIndexEntry>, ranking?: unknown, nowMs?: number) => SceneIndexEntry[];
};

const NOW = Date.parse("2026-10-31T00:00:00.000Z");
const DAY = 86_400_000;

function entry(partial: Partial<SceneIndexEntry>): SceneIndexEntry {
  return { filename: "s.md", summary: "", heat: 0, created: "", updated: "", ...partial };
}

const SETS: SceneIndexEntry[][] = [
  [],
  [entry({ filename: "only.md", heat: 7, updated: "2026-10-01T00:00:00.000Z" })],
  // 平票 + 中文文件名 + 畸形 heat
  [
    entry({ filename: "生活与健康管理.md", heat: 50, updated: "2026-10-01T00:00:00.000Z" }),
    entry({ filename: "技术自评👍.md", heat: 50, updated: "2026-09-01T00:00:00.000Z" }),
    entry({ filename: "bad.md", heat: Number.NaN, updated: "" }),
    entry({ filename: "z.md", heat: 200, updated: "2026-08-01T00:00:00.000Z" }),
  ],
  // 真实形态：宽热度带 + 宽龄带
  Array.from({ length: 30 }, (_, i) =>
    entry({
      filename: `scene-${String(i).padStart(2, "0")}.md`,
      heat: (i * 53) % 700,
      updated: new Date(NOW - ((i * 7) % 120) * DAY).toISOString(),
    })),
];

describe("票⑦ 防漂移：sim 脚本公式复刻 ≡ TS rankSceneEntries（同输入同序）", () => {
  for (const [si, entries] of SETS.entries()) {
    it(`集合 #${si}（${entries.length} 条）：off 序一致`, () => {
      expect(sim.rankOffMjs(entries).map((e) => e.filename)).toEqual(
        [...entries].sort((a, b) => b.heat - a.heat).map((e) => e.filename),
      );
    });
    it(`集合 #${si}（${entries.length} 条）：on 序一致（默认权重）`, () => {
      expect(sim.rankOnMjs(entries, RECALL_RANKING_DEFAULTS, NOW).map((e) => e.filename)).toEqual(
        rankSceneEntries(entries, RECALL_RANKING_DEFAULTS, NOW).map((e) => e.filename),
      );
    });
    it(`集合 #${si}（${entries.length} 条）：on 序一致（非默认权重/半衰期）`, () => {
      const alt = { w1: 0.2, w2: 0.5, w3: 0.1, w4: 0.2, halfLifeDays: 7 };
      expect(sim.rankOnMjs(entries, alt, NOW).map((e) => e.filename)).toEqual(
        rankSceneEntries(entries, alt, NOW).map((e) => e.filename),
      );
    });
  }
});
