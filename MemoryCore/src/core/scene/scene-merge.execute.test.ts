/**
 * T03：executeMerge 事务 happy path（本地 fs、隔离 dataDir、journal/preimage/锁）。
 *
 * 只覆盖 SPEC-E §4.6–§4.8 的 Stage 1 行为；恢复/冲突/幂等由 T04 补齐。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractAnchorIds } from "../../utils/supersede.js";
import { parseSceneBlock } from "./scene-format.js";
import { readSceneIndex } from "./scene-index.js";
import { generateSceneNavigation } from "./scene-navigation.js";
import {
  executeMerge,
  mergeJournalPaths,
  parseMergeSceneConfig,
  planMerge,
  type MergeSceneConfig,
  type MergeScenePlan,
} from "./scene-merge.js";

const NOW = "2026-11-19T10:00:00.000Z";
const SCENE_CHAR_CAP = 500_000;

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDataDir(prefix = "merge-exec-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  mkdirSync(join(dir, "scene_blocks"), { recursive: true });
  return dir;
}

function sceneRaw(anchor: string, label: string, created: string, heat = 1): string {
  return [
    "-----META-START-----",
    "created: " + created,
    "updated: " + created,
    "summary: 旧摘要",
    "heat: " + heat,
    "-----META-END-----",
    "",
    "## 要点",
    "- " + label + " 要点一",
    "",
    "## 事实",
    "- " + label + " 事实（记忆ID: " + anchor + "）",
    "",
    "## 活动",
    "- " + label + " 活动一",
  ].join("\n");
}

function getConfig(): MergeSceneConfig {
  const config = parseMergeSceneConfig({ mode: "shadow" }, SCENE_CHAR_CAP);
  if (!config) throw new Error("expected shadow config");
  return config;
}

function writeScene(dataDir: string, name: string, raw: string): void {
  writeFileSync(join(dataDir, "scene_blocks", name), raw, "utf8");
}

function makePlan(
  dataDir: string,
  aName: string,
  bName: string,
  target = "merged-scene.md",
): { config: MergeSceneConfig; plan: MergeScenePlan } {
  const config = getConfig();
  const aRaw = readFileSync(join(dataDir, "scene_blocks", aName), "utf8");
  const bRaw = readFileSync(join(dataDir, "scene_blocks", bName), "utf8");
  const existing = readdirSync(join(dataDir, "scene_blocks"));
  const result = planMerge(
    { filename: aName, raw: aRaw },
    { filename: bName, raw: bRaw },
    { config, now: NOW, target, sceneCharCap: SCENE_CHAR_CAP, existingSceneNames: existing },
  );
  if (!result.ok) throw new Error("planMerge rejected: " + result.rejection.message);
  return { config, plan: result.plan };
}

describe("executeMerge (T03 local fs happy path)", () => {
  it("merges two of three scenes, writes C/journal/preimages and syncs index/nav", async () => {
    const dataDir = tempDataDir();
    const aRaw = sceneRaw("m_1795000000000_aaaaaaaa", "alpha", "2026-11-01T00:00:00.000Z", 1);
    const bRaw = sceneRaw("m_1795000000001_bbbbbbbb", "beta", "2026-11-02T00:00:00.000Z", 5);
    const otherRaw = sceneRaw("m_1795000000002_cccccccc", "other", "2026-11-03T00:00:00.000Z", 2);
    writeScene(dataDir, "alpha.md", aRaw);
    writeScene(dataDir, "beta.md", bRaw);
    writeScene(dataDir, "other.md", otherRaw);

    const { config, plan } = makePlan(dataDir, "alpha.md", "beta.md");
    const result = await executeMerge({
      plan,
      config,
      sceneCharCap: SCENE_CHAR_CAP,
      dataDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code + ": " + result.error.message);
    expect(result.status).toBe("merged");

    const files = readdirSync(join(dataDir, "scene_blocks"))
      .filter((name) => name.endsWith(".md"))
      .sort();
    expect(files).toEqual(["merged-scene.md", "other.md"]);

    const index = await readSceneIndex(dataDir);
    expect(index.map((entry) => entry.filename).sort()).toEqual(["merged-scene.md", "other.md"]);
    const nav = generateSceneNavigation(index, dataDir);
    expect(nav).toContain("merged-scene.md");
    expect(nav).not.toContain("alpha.md");
    expect(nav).not.toContain("beta.md");

    const cRaw = readFileSync(join(dataDir, "scene_blocks", "merged-scene.md"), "utf8");
    const block = parseSceneBlock(cRaw, "merged-scene.md");
    const headings = block.content
      .split("\n")
      .filter((line) => /^## (要点|事实|活动)\s*$/.test(line));
    expect(headings).toEqual(["## 要点", "## 事实", "## 活动"]);
    expect(block.meta.created).toBe("2026-11-01T00:00:00.000Z");
    expect(block.meta.updated).toBe(NOW);
    expect(block.meta.heat).toBe(5);
    expect(block.meta.summary).toContain("alpha");
    expect(block.meta.summary).toContain("beta");
    expect(block.meta.summary).not.toBe("旧摘要");

    const anchors = extractAnchorIds(block.content).sort();
    const expectedAnchors = [
      ...extractAnchorIds(parseSceneBlock(aRaw, "alpha.md").content),
      ...extractAnchorIds(parseSceneBlock(bRaw, "beta.md").content),
    ].sort();
    expect(anchors).toEqual(expectedAnchors);

    const paths = mergeJournalPaths(dataDir, config, plan.key);
    expect(existsSync(paths.file)).toBe(true);
    const journal = JSON.parse(readFileSync(paths.file, "utf8")) as { stage: string; target: { filename: string } };
    expect(journal.stage).toBe("done");
    expect(journal.target.filename).toBe("merged-scene.md");
    expect(readFileSync(join(paths.preimageDir, "A.pre.md"), "utf8")).toBe(aRaw);
    expect(readFileSync(join(paths.preimageDir, "B.pre.md"), "utf8")).toBe(bRaw);

    expect(readdirSync(join(dataDir, ".metadata", "merge-tmp"))).toEqual([]);
    expect(existsSync(join(dataDir, ".metadata", "merge.lock"))).toBe(false);
  });

  it("refreshes persona navigation when persona.md exists", async () => {
    const dataDir = tempDataDir();
    const aRaw = sceneRaw("m_1795000000000_aaaaaaaa", "alpha", "2026-11-01T00:00:00.000Z");
    const bRaw = sceneRaw("m_1795000000001_bbbbbbbb", "beta", "2026-11-02T00:00:00.000Z");
    writeScene(dataDir, "alpha.md", aRaw);
    writeScene(dataDir, "beta.md", bRaw);

    const before = await readSceneIndex(dataDir);
    expect(before).toHaveLength(0);
    const oldNav = generateSceneNavigation(
      [
        { filename: "alpha.md", summary: "", heat: 1, created: "", updated: "" },
        { filename: "beta.md", summary: "", heat: 1, created: "", updated: "" },
      ],
      dataDir,
    );
    writeFileSync(join(dataDir, "persona.md"), "PERSONA BODY\n\n" + oldNav + "\n", "utf8");

    const { config, plan } = makePlan(dataDir, "alpha.md", "beta.md");
    const result = await executeMerge({ plan, config, sceneCharCap: SCENE_CHAR_CAP, dataDir });
    expect(result.ok).toBe(true);

    const persona = readFileSync(join(dataDir, "persona.md"), "utf8");
    expect(persona).toContain("PERSONA BODY");
    expect(persona).toContain("merged-scene.md");
    expect(persona).not.toContain("alpha.md");
    expect(persona).not.toContain("beta.md");
  });

  it("rejects a modified input with MERGE_CONFLICT and leaves the data untouched", async () => {
    const dataDir = tempDataDir();
    const aRaw = sceneRaw("m_1795000000000_aaaaaaaa", "alpha", "2026-11-01T00:00:00.000Z");
    const bRaw = sceneRaw("m_1795000000001_bbbbbbbb", "beta", "2026-11-02T00:00:00.000Z");
    writeScene(dataDir, "alpha.md", aRaw);
    writeScene(dataDir, "beta.md", bRaw);
    const { config, plan } = makePlan(dataDir, "alpha.md", "beta.md");

    const changed = aRaw + "\n- 外部追加行";
    writeScene(dataDir, "alpha.md", changed);
    const result = await executeMerge({ plan, config, sceneCharCap: SCENE_CHAR_CAP, dataDir });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected conflict");
    expect(result.error.code).toBe("MERGE_CONFLICT");
    expect(readFileSync(join(dataDir, "scene_blocks", "alpha.md"), "utf8")).toBe(changed);
    expect(existsSync(join(dataDir, "scene_blocks", "merged-scene.md"))).toBe(false);
    expect(existsSync(join(dataDir, ".metadata", "merge.lock"))).toBe(false);
  });

  it("rejects non-local backends before any write", async () => {
    const dataDir = tempDataDir();
    writeScene(dataDir, "alpha.md", sceneRaw("m_1795000000000_aaaaaaaa", "alpha", "2026-11-01T00:00:00.000Z"));
    writeScene(dataDir, "beta.md", sceneRaw("m_1795000000001_bbbbbbbb", "beta", "2026-11-02T00:00:00.000Z"));
    const { config, plan } = makePlan(dataDir, "alpha.md", "beta.md");

    const result = await executeMerge({
      plan,
      config,
      sceneCharCap: SCENE_CHAR_CAP,
      dataDir,
      backend: "storage",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected unsupported backend");
    expect(result.error.code).toBe("MERGE_UNSUPPORTED_ATOMICITY");
    expect(existsSync(join(dataDir, ".metadata"))).toBe(false);
  });

  it("refuses the production data directory", async () => {
    const source = tempDataDir();
    writeScene(source, "alpha.md", sceneRaw("m_1795000000000_aaaaaaaa", "alpha", "2026-11-01T00:00:00.000Z"));
    writeScene(source, "beta.md", sceneRaw("m_1795000000001_bbbbbbbb", "beta", "2026-11-02T00:00:00.000Z"));
    const { config, plan } = makePlan(source, "alpha.md", "beta.md");
    const productionLike = join(tmpdir(), ".memory-tencentdb", "memory-tdai", "merge-stage1-" + Date.now());

    const result = await executeMerge({
      plan,
      config,
      sceneCharCap: SCENE_CHAR_CAP,
      dataDir: productionLike,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected production guard");
    expect(result.error.code).toBe("MERGE_PRODUCTION_DATADIR");
    expect(existsSync(productionLike)).toBe(false);
  });

  it("allowProductionDataDir=true 仅绕过生产目录保护（内部 on 分支），仍走 preflight", async () => {
    const source = tempDataDir();
    writeScene(source, "alpha.md", sceneRaw("m_1795000000000_aaaaaaaa", "alpha", "2026-11-01T00:00:00.000Z"));
    writeScene(source, "beta.md", sceneRaw("m_1795000000001_bbbbbbbb", "beta", "2026-11-02T00:00:00.000Z"));
    const { config, plan } = makePlan(source, "alpha.md", "beta.md");
    const productionLike = join(tmpdir(), ".memory-tencentdb", "memory-tdai", "merge-stage3-allow-" + Date.now());

    const result = await executeMerge({
      plan,
      config,
      sceneCharCap: SCENE_CHAR_CAP,
      dataDir: productionLike,
      allowProductionDataDir: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected preflight failure");
    // 只在 preflight 前有锁内零数据写：输入场景不存在 → MERGE_CONFLICT（不是生产保护）。
    expect(result.error.code).toBe("MERGE_CONFLICT");
    cleanupDirs.push(productionLike);
  });

  it("returns MERGE_TARGET_EXISTS and releases the lock when the target appears after planning", async () => {
    const dataDir = tempDataDir();
    writeScene(dataDir, "alpha.md", sceneRaw("m_1795000000000_aaaaaaaa", "alpha", "2026-11-01T00:00:00.000Z"));
    writeScene(dataDir, "beta.md", sceneRaw("m_1795000000001_bbbbbbbb", "beta", "2026-11-02T00:00:00.000Z"));
    const { config, plan } = makePlan(dataDir, "alpha.md", "beta.md");
    writeScene(dataDir, "merged-scene.md", sceneRaw("m_1795000000003_dddddddd", "late", "2026-11-05T00:00:00.000Z"));

    const result = await executeMerge({ plan, config, sceneCharCap: SCENE_CHAR_CAP, dataDir });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected target existing");
    expect(result.error.code).toBe("MERGE_TARGET_EXISTS");
    expect(existsSync(join(dataDir, ".metadata", "merge.lock"))).toBe(false);
  });

  it("同 key 已完成再次执行：skipped idempotent，零写且不产生第二个 C（Standards P1-2）", async () => {
    const dataDir = tempDataDir();
    writeScene(dataDir, "alpha.md", sceneRaw("m_1795000000000_aaaaaaaa", "alpha", "2026-11-01T00:00:00.000Z"));
    writeScene(dataDir, "beta.md", sceneRaw("m_1795000000001_bbbbbbbb", "beta", "2026-11-02T00:00:00.000Z"));
    const { config, plan } = makePlan(dataDir, "alpha.md", "beta.md");
    const first = await executeMerge({ plan, config, sceneCharCap: SCENE_CHAR_CAP, dataDir });
    expect(first.ok).toBe(true);
    const snapshot = readdirSync(join(dataDir, "scene_blocks")).sort();

    const second = await executeMerge({ plan, config, sceneCharCap: SCENE_CHAR_CAP, dataDir });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected idempotent hit");
    expect(second.status).toBe("skipped");
    expect(second.code).toBe("idempotent");
    expect(second.journalStage).toBe("done");
    expect(readdirSync(join(dataDir, "scene_blocks")).sort()).toEqual(snapshot);
  });
});
