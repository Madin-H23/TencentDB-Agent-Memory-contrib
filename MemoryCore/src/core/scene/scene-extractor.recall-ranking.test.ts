// 票⑦（exp/p1-7-recall-ranking）：SceneExtractor 接线——opts.recallRanking 驱动
// updateSceneNavigation 的导航排序（persona.md nav 段顺序）+ 观测锚点。
// 缺省 off：nav 顺序与基线一致（heat 降序）+ 零锚点输出。
import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SceneExtractor } from "./scene-extractor.js";
import type { LLMRunParams } from "../../core/types.js";
import { RECALL_RANKING_DEFAULTS } from "./recall-ranking.js";

function makeFakeRunner() {
  const captured: LLMRunParams[] = [];
  return {
    captured,
    run: async (params: LLMRunParams) => {
      captured.push(params);
      return "done";
    },
  } as unknown as { run: (p: LLMRunParams) => Promise<string> } & { captured: LLMRunParams[] };
}

function makeLogger() {
  const lines: string[] = [];
  return {
    lines,
    debug: (m: string) => lines.push(`DEBUG ${m}`),
    info: (m: string) => lines.push(`INFO ${m}`),
    warn: (m: string) => lines.push(`WARN ${m}`),
    error: (m: string) => lines.push(`ERROR ${m}`),
  };
}

const STALE_UPDATED = "2026-08-01T00:00:00.000Z"; // 距 2026-10-31 约 91 天（>> 30 天半衰期）
const FRESH_UPDATED = "2026-10-31T00:00:00.000Z";

function sceneFile(summary: string, heat: number, updated: string): string {
  return [
    "-----META-START-----",
    `created: 2026-05-01T00:00:00.000Z`,
    `updated: ${updated}`,
    `summary: ${summary}`,
    `heat: ${heat}`,
    "-----META-END-----",
    "",
    "场景正文（非空，避免被 META-only 清理移除）。",
  ].join("\n");
}

async function seedDataDir(): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-extractor-p7-"));
  await fs.mkdir(path.join(dataDir, "scene_blocks"), { recursive: true });
  // 三条目集合：陈旧高热（100）/ 新鲜中热（90）/ 低热陈旧（5）——
  // off 序 = heat 降序（100, 90, 5）；默认权重 on 时 fresh 翻到 stale 前。
  await fs.writeFile(path.join(dataDir, "scene_blocks", "陈旧高热.md"), sceneFile("陈旧场景", 100, STALE_UPDATED), "utf-8");
  await fs.writeFile(path.join(dataDir, "scene_blocks", "新鲜中热.md"), sceneFile("新鲜场景", 90, FRESH_UPDATED), "utf-8");
  await fs.writeFile(path.join(dataDir, "scene_blocks", "低热陈旧.md"), sceneFile("低热场景", 5, STALE_UPDATED), "utf-8");
  await fs.writeFile(path.join(dataDir, "persona.md"), "用户画像正文。\n", "utf-8");
  return dataDir;
}

function navIndexOf(persona: string, filename: string): number {
  // updateSceneNavigation → generateSceneNavigation(index)（无 dataDir）→ 相对路径形态
  return persona.indexOf(`### Path: scene_blocks/${filename}`);
}

async function extractOnce(opts: { recallRanking?: typeof RECALL_RANKING_DEFAULTS }) {
  const dataDir = await seedDataDir();
  const logger = makeLogger();
  try {
    const fake = makeFakeRunner();
    const extractor = new SceneExtractor({
      dataDir,
      config: {} as never,
      maxScenes: 24,
      llmRunner: fake as never,
      logger: logger as never,
      ...(opts.recallRanking !== undefined ? { recallRanking: opts.recallRanking } : {}),
    });
    await extractor.extract([{ content: "一条测试记忆", created_at: "2026-10-31T00:00:00.000Z", id: "m_1787881381525_2eee472e" }]);
    const persona = await fs.readFile(path.join(dataDir, "persona.md"), "utf-8");
    return { persona, logger };
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

describe("SceneExtractor 接线：recallRanking → 导航排序 + 观测锚点", () => {
  it("off（缺省）：nav 按 heat 降序（陈旧高热在前），零锚点输出", async () => {
    const { persona, logger } = await extractOnce({});
    const staleIdx = navIndexOf(persona, "陈旧高热.md");
    const freshIdx = navIndexOf(persona, "新鲜中热.md");
    const lowIdx = navIndexOf(persona, "低热陈旧.md");
    expect(staleIdx).toBeLessThan(freshIdx);
    expect(freshIdx).toBeLessThan(lowIdx);
    expect(logger.lines.some((l) => l.includes("l2_recall_rank"))).toBe(false);
  });

  it("on：默认权重下新鲜场景翻转到陈旧高热之前 + 锚点恰打一行", async () => {
    const { persona, logger } = await extractOnce({ recallRanking: RECALL_RANKING_DEFAULTS });
    const staleIdx = navIndexOf(persona, "陈旧高热.md");
    const freshIdx = navIndexOf(persona, "新鲜中热.md");
    expect(freshIdx).toBeLessThan(staleIdx);
    const anchorLines = logger.lines.filter((l) => l.includes("metric=l2_recall_rank value=1"));
    expect(anchorLines.length).toBe(1);
    expect(anchorLines[0]).toContain("scenes=3");
    expect(anchorLines[0]).toContain("signals=w1:0.35;w2:0.3;w3:0.25;w4:0.1;halfLifeDays:30");
  });
});
