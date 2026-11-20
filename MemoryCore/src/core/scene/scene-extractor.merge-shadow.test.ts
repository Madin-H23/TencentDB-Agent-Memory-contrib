/**
 * Stage 2（SPEC-E §4.13）：SceneExtractor Phase 4.5 mergeScene shadow 钩子。
 *
 * 口径：shadow=只读选对 + planMerge + 单行 metric=l2_merge（零写、无锁、无 journal）；
 * on=先恢复再真实执行一轮（写盘、持 merge 锁、写 journal）。
 * off 分支零调用；candidatePairs 按配置序取第一对可用者；任何异常 fail-soft。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
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
function onConfig(overrides: Record<string, unknown> = {}): MergeSceneConfig {
  const config = parseMergeSceneConfig(
    {
      mode: "on",
      candidatePairs: [{ a: "场景-a.md", b: "场景-b.md" }],
      maxPairsPerRound: 1,
      ...overrides,
    },
    CAP,
  );
  if (!config) throw new Error("on config 解析失败");
  return config;
}

async function sceneNames(dataDir: string): Promise<string[]> {
  return (await fs.readdir(path.join(dataDir, "scene_blocks"))).sort();
}

async function journalStages(dataDir: string): Promise<string[]> {
  const dir = path.join(dataDir, ".metadata", "merge-journal");
  if (!existsSync(dir)) return [];
  const names = (await fs.readdir(dir)).filter((name) => name.endsWith(".json"));
  const stages: string[] = [];
  for (const name of names) {
    const raw = await fs.readFile(path.join(dir, name), "utf-8");
    stages.push(String((JSON.parse(raw) as { stage?: unknown }).stage ?? ""));
  }
  return stages;
}

async function runHook(
  dataDir: string,
  opts: { mergeScene: MergeSceneConfig; sceneCharCap?: number; storage?: unknown },
) {
  const logger = makeLogger();
  const extractor = new SceneExtractor({
    dataDir,
    config: {} as never,
    maxScenes: 24,
    sceneCharCap: opts.sceneCharCap ?? CAP,
    llmRunner: makeFakeRunner() as never,
    logger: logger as never,
    mergeScene: opts.mergeScene,
    ...(opts.storage !== undefined ? { storage: opts.storage as never } : {}),
  });
  await (extractor as unknown as { runMergeHook: () => Promise<void> }).runMergeHook();
  return { logger };
}

describe("mergeScene on 钩子（Stage 3）", () => {
  it("candidatePairs：真实执行一轮，A/B 消失、C 落盘、journal=done、metric=merged", async () => {
    const dataDir = await seed(FILES);
    const { logger } = await runExtract(dataDir, { mergeScene: onConfig() });
    const lines = mergeLines(logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("result=merged");
    expect(lines[0]).toContain("journalStage=done");
    expect(lines[0]).toMatch(/key=[0-9a-f]{12}\b/);
    expect(lines[0]).toContain("pair=场景-a.md + 场景-b.md");
    expect(lines[0]).toContain("charsC=");
    expect(await sceneNames(dataDir)).toEqual(["场景-a-场景-b-合并.md", "场景-c.md"]);
    expect(await journalStages(dataDir)).toEqual(["done"]);
  });

  it("Phase 5 跳过本轮合并产物 C：四个改写分支只作用于其他场景（seams P0）", async () => {
    const dataDir = await seed(FILES);
    const logger = makeLogger();
    const extractor = new SceneExtractor({
      dataDir,
      config: {} as never,
      maxScenes: 24,
      sceneCharCap: CAP,
      llmRunner: makeFakeRunner() as never,
      logger: logger as never,
      mergeScene: onConfig(),
    });
    const hook = extractor as unknown as Record<string, any>;
    hook.sceneArchive = { enabled: true };
    hook.sceneCompaction = { enabled: true };
    hook.factSupersede = {};
    hook.sceneFactArchive = { enabled: true };
    const spies = {
      spill: vi.spyOn(hook, "spillSceneFile").mockResolvedValue(undefined as never),
      compact: vi.spyOn(hook, "compactSceneFile").mockResolvedValue(undefined as never),
      supersede: vi.spyOn(hook, "supersedeFactFile").mockResolvedValue(undefined as never),
      factArchive: vi.spyOn(hook, "factArchiveFile").mockResolvedValue(undefined as never),
    };

    const result = await extractor.extract([
      { content: "一条测试记忆", created_at: "2026-11-20T00:00:00.000Z" },
    ]);

    expect(result.success).toBe(true);
    expect(hook.mergedTargetThisExtract).toBe("场景-a-场景-b-合并.md");
    for (const spy of Object.values(spies)) {
      const files = spy.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(files).not.toContain("场景-a-场景-b-合并.md");
      expect(files).toContain("场景-c.md");
    }
  });

  it("merge 锁忙：skipped MERGE_LOCK_BUSY，零写且不覆盖他人锁", async () => {
    const dataDir = await seed(FILES);
    const before = await sceneBlocksSnapshot(dataDir);
    const metaDir = path.join(dataDir, ".metadata");
    await fs.mkdir(metaDir, { recursive: true });
    const lockPath = path.join(metaDir, "merge.lock");
    const lockRaw = JSON.stringify({ owner: "other-process", pid: 424242, ts: Date.now(), ttlMs: 60_000 });
    await fs.writeFile(lockPath, lockRaw, "utf-8");
    const { logger } = await runHook(dataDir, { mergeScene: onConfig({ lockWaitMs: 0 }) });
    const lines = mergeLines(logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("result=skipped");
    expect(lines[0]).toContain("code=MERGE_LOCK_BUSY");
    expect(await sceneBlocksSnapshot(dataDir)).toEqual(before);
    expect(await fs.readFile(lockPath, "utf-8")).toBe(lockRaw);
    expect(await journalStages(dataDir)).toEqual([]);
  });

  it("非 local backend：skipped unsupported_backend，零写", async () => {
    const dataDir = await seed(FILES);
    const before = await sceneBlocksSnapshot(dataDir);
    const { logger } = await runHook(dataDir, {
      mergeScene: onConfig(),
      storage: { type: "cos" },
    });
    const lines = mergeLines(logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("result=skipped");
    expect(lines[0]).toContain("code=unsupported_backend");
    expect(await sceneBlocksSnapshot(dataDir)).toEqual(before);
    expect(await journalStages(dataDir)).toEqual([]);
  });

  it("candidatePairs 全部不可用：rejected candidate_unavailable，零写", async () => {
    const dataDir = await seed(FILES);
    const before = await sceneBlocksSnapshot(dataDir);
    const { logger } = await runHook(dataDir, {
      mergeScene: onConfig({ candidatePairs: [{ a: "场景-a.md", b: "不存在.md" }] }),
    });
    const lines = mergeLines(logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("result=rejected");
    expect(lines[0]).toContain("code=candidate_unavailable");
    expect(await sceneBlocksSnapshot(dataDir)).toEqual(before);
    expect(await journalStages(dataDir)).toEqual([]);
  });

  it("只补完上轮未竟事务（a_deleted + A 已被上一轮 Phase 5 unlink）：skipped recovered，journal=done", async () => {
    const dataDir = await seed(FILES);
    // 第一轮真实合并 → done journal、A/B 消失、C 落盘。
    await runExtract(dataDir, { mergeScene: onConfig() });
    const journalDir = path.join(dataDir, ".metadata", "merge-journal");
    const journalName = (await fs.readdir(journalDir)).find((name) => name.endsWith(".json"))!;
    const journalPath = path.join(journalDir, journalName);
    const journal = JSON.parse(await fs.readFile(journalPath, "utf-8")) as { stage: string };
    // 回退到 a_deleted 阶段：C 已定稿，A/B 已被 Phase 5 抢先 unlink（S3 执行与治理交错）。
    journal.stage = "a_deleted";
    await fs.writeFile(journalPath, JSON.stringify(journal, null, 2), "utf-8");

    const { logger } = await runHook(dataDir, { mergeScene: onConfig() });
    const lines = mergeLines(logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("result=skipped");
    expect(lines[0]).toContain("code=recovered");
    expect(lines[0]).toContain("journalStage=done");
    expect(lines[0]).not.toContain("ALERT");
    expect(await journalStages(dataDir)).toEqual(["done"]);
    expect(await sceneNames(dataDir)).toEqual(["场景-a-场景-b-合并.md", "场景-c.md"]);
  });

  it("目标已存在：rejected target_exists，L2 success 不受影响", async () => {
    const files = { ...FILES, "场景-a-场景-b-合并.md": sceneFile({ gist: ["- 既有目标"] }) };
    const dataDir = await seed(files);
    const before = await sceneBlocksSnapshot(dataDir);
    const { result, logger } = await runExtract(dataDir, { mergeScene: onConfig() });
    const lines = mergeLines(logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("result=rejected");
    expect(lines[0]).toContain("code=target_exists");
    expect(result.success).toBe(true);
    expect(await sceneBlocksSnapshot(dataDir)).toEqual(before);
    expect(await journalStages(dataDir)).toEqual([]);
  });
});
