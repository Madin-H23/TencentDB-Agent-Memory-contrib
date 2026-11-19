/**
 * Stage 2（SPEC-E §4.13）：SceneExtractor Phase 4.5 mergeScene shadow 钩子。
 *
 * 口径：只读选对 + planMerge + 单行 metric=l2_merge；零写、无锁、无 journal。
 * off 分支零调用；candidatePairs 按配置序取第一对可用者；任何异常 fail-soft。
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SceneExtractor } from "./scene-extractor.js";
import { parseMergeSceneConfig, type MergeSceneConfig } from "./scene-merge.js";
import type { LLMRunParams } from "../types.js";

const ANCHOR = (i: number) => `m_1793500000000_${i.toString(16).padStart(8, "0")}`;
const CAP = 500_000;

/** 临时 dataDir 统一回收（避免 mkdtemp 泄漏）。 */
const TMP_DIRS: string[] = [];
afterEach(async () => {
  while (TMP_DIRS.length > 0) {
    const dir = TMP_DIRS.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function makeFakeRunner() {
  return {
    run: async (_params: LLMRunParams) => "done",
  };
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

interface SceneFixture {
  created?: string;
  updated?: string;
  summary?: string;
  archive?: boolean;
  gist?: string[];
  facts?: string[];
  activity?: string[];
}

/** 生成 v2 场景块（META + 要点/事实/活动）。 */
function sceneFile(o: SceneFixture = {}): string {
  return [
    "-----META-START-----",
    `created: ${o.created ?? "2026-11-01T00:00:00.000Z"}`,
    `updated: ${o.updated ?? "2026-11-02T00:00:00.000Z"}`,
    `summary: ${o.summary ?? "测试场景"}`,
    "heat: 1",
    ...(o.archive ? ["archive: true"] : []),
    "-----META-END-----",
    "",
    "## 要点",
    ...(o.gist ?? ["- 要点内容"]),
    "",
    "## 事实",
    ...(o.facts ?? ["- 事实内容"]),
    "",
    "## 活动",
    ...(o.activity ?? ["- 活动内容"]),
    "",
  ].join("\n");
}

async function seed(files: Record<string, string>): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-merge-shadow-"));
  TMP_DIRS.push(dataDir);
  await fs.mkdir(path.join(dataDir, "scene_blocks"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dataDir, "scene_blocks", name), content, "utf-8");
  }
  await fs.writeFile(path.join(dataDir, "persona.md"), "用户画像正文。\n", "utf-8");
  return dataDir;
}

async function sceneBlocksSnapshot(dataDir: string): Promise<Record<string, string>> {
  const dir = path.join(dataDir, "scene_blocks");
  const names = (await fs.readdir(dir)).sort();
  const out: Record<string, string> = {};
  for (const name of names) out[name] = await fs.readFile(path.join(dir, name), "utf-8");
  return out;
}

function shadowConfig(overrides: Record<string, unknown> = {}): MergeSceneConfig {
  const config = parseMergeSceneConfig({ mode: "shadow", ...overrides }, CAP);
  if (!config) throw new Error("shadow config 解析失败");
  return config;
}

async function runExtract(
  dataDir: string,
  opts: { mergeScene?: MergeSceneConfig; sceneCharCap?: number },
) {
  const logger = makeLogger();
  const extractor = new SceneExtractor({
    dataDir,
    config: {} as never,
    maxScenes: 24,
    sceneCharCap: opts.sceneCharCap ?? CAP,
    llmRunner: makeFakeRunner() as never,
    logger: logger as never,
    ...(opts.mergeScene !== undefined ? { mergeScene: opts.mergeScene } : {}),
  });
  const result = await extractor.extract([
    { content: "一条测试记忆", created_at: "2026-11-19T00:00:00.000Z", id: ANCHOR(99) },
  ]);
  return { result, logger };
}

function mergeLines(logger: { lines: string[] }): string[] {
  return logger.lines.filter((line) => line.includes("metric=l2_merge"));
}

/** A/B 共享 1 个锚点，C 独立；用于自动选对与显式配对。 */
const FILES = {
  "场景-a.md": sceneFile({ gist: [`- 要点 A（${ANCHOR(1)}）`], facts: ["- 事实 A"], activity: ["- 活动 A"] }),
  "场景-b.md": sceneFile({ gist: ["- 要点 B"], facts: [`- 事实 B（${ANCHOR(1)}）`], activity: ["- 活动 B"] }),
  "场景-c.md": sceneFile({ gist: [`- 要点 C（${ANCHOR(2)}）`], facts: ["- 事实 C"], activity: ["- 活动 C"] }),
};

describe("mergeScene shadow 钩子", () => {
  it("off（缺省）：不产 metric，scene_blocks 逐字节不变，无 journal", async () => {
    const dataDir = await seed(FILES);
    const before = await sceneBlocksSnapshot(dataDir);
    const { logger } = await runExtract(dataDir, {});
    expect(mergeLines(logger)).toHaveLength(0);
    expect(await sceneBlocksSnapshot(dataDir)).toEqual(before);
    expect(existsSync(path.join(dataDir, ".metadata", "merge-journal"))).toBe(false);
  });

  it("candidatePairs：按配置序产 planned metric，零写盘", async () => {
    const dataDir = await seed(FILES);
    const before = await sceneBlocksSnapshot(dataDir);
    const config = shadowConfig({ candidatePairs: [{ a: "场景-a.md", b: "场景-b.md" }] });
    const { logger } = await runExtract(dataDir, { mergeScene: config });
    const lines = mergeLines(logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("result=planned");
    expect(lines[0]).toContain("pair=场景-a.md + 场景-b.md");
    expect(lines[0]).toMatch(/key=[0-9a-f]{12}\b/);
    expect(lines[0]).toContain("charsC=");
    expect(lines[0]).toContain("anchorsIn=2");
    expect(lines[0]).toContain("anchorsOut=2");
    expect(lines[0]).toContain("sharedAnchors=1");
    expect(await sceneBlocksSnapshot(dataDir)).toEqual(before);
    expect(existsSync(path.join(dataDir, ".metadata", "merge-journal"))).toBe(false);
  });

  it("candidatePairs 全部缺文件：rejected candidate_unavailable，不回退自动选对", async () => {
    const dataDir = await seed(FILES);
    const config = shadowConfig({ candidatePairs: [{ a: "场景-a.md", b: "不存在.md" }] });
    const { logger } = await runExtract(dataDir, { mergeScene: config });
    const lines = mergeLines(logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("result=rejected");
    expect(lines[0]).toContain("code=candidate_unavailable");
  });

  it("无 candidatePairs：按共享锚点自动选对并产 planned", async () => {
    const dataDir = await seed(FILES);
    const { logger } = await runExtract(dataDir, { mergeScene: shadowConfig() });
    const lines = mergeLines(logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("result=planned");
    expect(lines[0]).toContain("pair=场景-a.md + 场景-b.md");
    expect(lines[0]).toContain("sharedAnchors=1");
  });

  it("候选无共享锚点：skipped no_candidate", async () => {
    const files = {
      "孤立-a.md": sceneFile({ gist: [`- 要点（${ANCHOR(3)}）`] }),
      "孤立-b.md": sceneFile({ gist: [`- 要点（${ANCHOR(4)}）`] }),
    };
    const dataDir = await seed(files);
    const { logger } = await runExtract(dataDir, { mergeScene: shadowConfig() });
    const lines = mergeLines(logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("result=skipped");
    expect(lines[0]).toContain("code=no_candidate");
  });

  it("candidatePairs 首对非 v2：跳过该对；无其他可用对 → candidate_unavailable（fail-soft）", async () => {
    const files = {
      ...FILES,
      "扁平.md": "-----META-START-----\ncreated: 2026-11-01T00:00:00.000Z\nupdated: 2026-11-02T00:00:00.000Z\nsummary: 扁平\nheat: 1\n-----META-END-----\n\n- 只有一段自由正文（" + ANCHOR(5) + "）\n",
    };
    const dataDir = await seed(files);
    const config = shadowConfig({ candidatePairs: [{ a: "场景-a.md", b: "扁平.md" }] });
    const { result, logger } = await runExtract(dataDir, { mergeScene: config });
    const lines = mergeLines(logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("result=rejected");
    expect(lines[0]).toContain("code=candidate_unavailable");
    expect(result.success).toBe(true);
  });

  it("candidatePairs 首对归档：跳过该对，按序取下一对 planned", async () => {
    const files = {
      ...FILES,
      "场景-旧.md": sceneFile({ archive: true, gist: ["- 归档要点"], facts: ["- 归档事实"], activity: ["- 归档活动"] }),
    };
    const dataDir = await seed(files);
    const config = shadowConfig({
      candidatePairs: [
        { a: "场景-a.md", b: "场景-旧.md" },
        { a: "场景-a.md", b: "场景-b.md" },
      ],
    });
    const { logger } = await runExtract(dataDir, { mergeScene: config });
    const lines = mergeLines(logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("result=planned");
    expect(lines[0]).toContain("pair=场景-a.md + 场景-b.md");
  });

  it("sceneCharCap=0：rejected scene_char_cap_unset", async () => {
    const dataDir = await seed(FILES);
    const { logger } = await runExtract(dataDir, { mergeScene: shadowConfig(), sceneCharCap: 0 });
    const lines = mergeLines(logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("result=rejected");
    expect(lines[0]).toContain("code=scene_char_cap_unset");
  });

  it("读取超预算：skipped budget_exceeded（直调钩子，fail-soft）", async () => {
    const dataDir = await seed(FILES);
    const logger = makeLogger();
    const slow = {
      readdirNames: async () => {
        await new Promise((resolve) => setTimeout(resolve, 700));
        return ["场景-a.md", "场景-b.md", "场景-c.md"];
      },
      readFile: async (name: string) => {
        await new Promise((resolve) => setTimeout(resolve, 700));
        const base = name.includes("场景-a") ? "场景-a.md" : name.includes("场景-b") ? "场景-b.md" : "场景-c.md";
        return FILES[base];
      },
    };
    const extractor = new SceneExtractor({
      dataDir,
      config: {} as never,
      maxScenes: 24,
      sceneCharCap: CAP,
      llmRunner: makeFakeRunner() as never,
      logger: logger as never,
      storage: slow as never,
      mergeScene: shadowConfig(),
    });
    await (extractor as unknown as { runMergeShadowHook: () => Promise<void> }).runMergeShadowHook();
    const lines = mergeLines(logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("result=skipped");
    expect(lines[0]).toContain("code=budget_exceeded");
    expect(lines[0].startsWith("WARN")).toBe(true);
  });

  it("钩子不写 .metadata：目录在 extract 前后无 merge-journal 子目录", async () => {
    const dataDir = await seed(FILES);
    const config = shadowConfig({ candidatePairs: [{ a: "场景-a.md", b: "场景-b.md" }] });
    await runExtract(dataDir, { mergeScene: config });
    const metaDir = path.join(dataDir, ".metadata");
    if (existsSync(metaDir)) {
      expect(existsSync(path.join(metaDir, "merge-journal"))).toBe(false);
    }
  });
});
