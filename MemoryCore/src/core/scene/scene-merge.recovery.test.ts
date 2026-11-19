/**
 * T04：journal 恢复、外部冲突、幂等与锁接管。
 *
 * 用真实本地 fs + 隔离临时 dataDir 手工构造各中断点，避免依赖 kill -9；
 * 只验证「收敛到 2 或 3 个活动场景」与「不覆盖外部写」两条外部行为。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSceneBlock } from "./scene-format.js";
import { readSceneIndex, syncSceneIndex } from "./scene-index.js";
import {
  executeMerge,
  mergeJournalPaths,
  parseMergeSceneConfig,
  planMerge,
  recoverMergeJournal,
  type MergeJournal,
  type MergeJournalStage,
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

function tempDataDir(prefix = "merge-recover-"): string {
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

function getConfig(overrides: Partial<MergeSceneConfig> = {}): MergeSceneConfig {
  const config = parseMergeSceneConfig({ mode: "shadow" }, SCENE_CHAR_CAP);
  if (!config) throw new Error("expected shadow config");
  return { ...config, ...overrides };
}

interface Fixture {
  dataDir: string;
  config: MergeSceneConfig;
  plan: MergeScenePlan;
  aRaw: string;
  bRaw: string;
}

function fixture(overrides: Partial<MergeSceneConfig> = {}): Fixture {
  const dataDir = tempDataDir();
  const aRaw = sceneRaw("m_1795000000000_aaaaaaaa", "alpha", "2026-11-01T00:00:00.000Z", 1);
  const bRaw = sceneRaw("m_1795000000001_bbbbbbbb", "beta", "2026-11-02T00:00:00.000Z", 5);
  const otherRaw = sceneRaw("m_1795000000002_cccccccc", "other", "2026-11-03T00:00:00.000Z", 2);
  writeFileSync(join(dataDir, "scene_blocks", "alpha.md"), aRaw, "utf8");
  writeFileSync(join(dataDir, "scene_blocks", "beta.md"), bRaw, "utf8");
  writeFileSync(join(dataDir, "scene_blocks", "other.md"), otherRaw, "utf8");
  const config = getConfig(overrides);
  const existing = readdirSync(join(dataDir, "scene_blocks"));
  const planned = planMerge(
    { filename: "alpha.md", raw: aRaw },
    { filename: "beta.md", raw: bRaw },
    { config, now: NOW, target: "merged-scene.md", sceneCharCap: SCENE_CHAR_CAP, existingSceneNames: existing },
  );
  if (!planned.ok) throw new Error("plan rejected: " + planned.rejection.message);
  return { dataDir, config, plan: planned.plan, aRaw, bRaw };
}

interface JournalOptions {
  stage: MergeJournalStage;
  /** prepared 阶段模拟「C 已 rename 但 journal 未更新」。 */
  withC?: boolean;
}

function writeJournal(f: Fixture, opts: JournalOptions): string {
  const { dataDir, config, plan } = f;
  const paths = mergeJournalPaths(dataDir, config, plan.key);
  mkdirSync(paths.preimageDir, { recursive: true });
  writeFileSync(join(paths.preimageDir, "A.pre.md"), f.aRaw, "utf8");
  writeFileSync(join(paths.preimageDir, "B.pre.md"), f.bRaw, "utf8");
  const hasC =
    opts.withC === true ||
    opts.stage === "c_persisted" ||
    opts.stage === "a_deleted" ||
    opts.stage === "b_deleted" ||
    opts.stage === "done";
  const targetPath = join(dataDir, "scene_blocks", plan.target);
  if (hasC) writeFileSync(targetPath, plan.c.raw, "utf8");
  const aPath = join(dataDir, "scene_blocks", plan.a.filename);
  const bPath = join(dataDir, "scene_blocks", plan.b.filename);
  if (opts.stage === "a_deleted" || opts.stage === "b_deleted" || opts.stage === "done") {
    writeFileSync(aPath, "[DELETED]", "utf8");
  }
  if (opts.stage === "b_deleted" || opts.stage === "done") {
    writeFileSync(bPath, "[DELETED]", "utf8");
  }
  if (opts.stage === "done") {
    if (existsSync(aPath)) unlinkSync(aPath);
    if (existsSync(bPath)) unlinkSync(bPath);
    void syncSceneIndex(dataDir);
  }
  const at = "2026-11-19T10:00:00.000Z";
  const journal: MergeJournal = {
    version: 1,
    key: plan.key,
    inputs: { a: { ...plan.a }, b: { ...plan.b } },
    concatOrder: plan.concatOrder,
    target: { filename: plan.target, sha256: plan.c.raw ? sha256Of(plan.c.raw) : "", chars: plan.c.raw.length },
    stage: opts.stage,
    attempts: [{ at, pid: process.pid, host: "test", result: opts.stage }],
    pid: process.pid,
    host: "test",
    startedAt: at,
    updatedAt: at,
    metrics: plan.metrics,
  };
  writeFileSync(paths.file, JSON.stringify(journal, null, 2) + "\n", "utf8");
  return paths.file;
}

function sha256Of(value: string): string {
  // 与生产相同的 sha256 文本；直接复用 node:crypto，避免测试引入额外依赖。
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function listScenes(dataDir: string): string[] {
  return readdirSync(join(dataDir, "scene_blocks"))
    .filter((name) => name.endsWith(".md"))
    .sort();
}

function readJournal(file: string): MergeJournal {
  return JSON.parse(readFileSync(file, "utf8")) as MergeJournal;
}

describe("recoverMergeJournal (T04)", () => {
  it("prepared without C rolls back to 3 scenes and marks rolled_back", async () => {
    const f = fixture();
    const journalPath = writeJournal(f, { stage: "prepared" });
    const result = await recoverMergeJournal({ dataDir: f.dataDir, config: f.config });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.scanned).toBe(1);
    expect(result.outcomes[0]).toMatchObject({ action: "rolled_back", stageAfter: "rolled_back" });
    expect(listScenes(f.dataDir)).toEqual(["alpha.md", "beta.md", "other.md"]);
    expect(readJournal(journalPath).stage).toBe("rolled_back");
    expect((await readSceneIndex(f.dataDir)).map((entry) => entry.filename).sort()).toEqual([
      "alpha.md",
      "beta.md",
      "other.md",
    ]);
  });

  it("prepared with a valid renamed C rolls forward to 2 scenes", async () => {
    const f = fixture();
    writeJournal(f, { stage: "prepared", withC: true });
    const result = await recoverMergeJournal({ dataDir: f.dataDir, config: f.config });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.outcomes[0]).toMatchObject({ action: "completed", stageAfter: "done" });
    expect(listScenes(f.dataDir)).toEqual(["merged-scene.md", "other.md"]);
    expect((await readSceneIndex(f.dataDir)).map((entry) => entry.filename).sort()).toEqual([
      "merged-scene.md",
      "other.md",
    ]);
  });

  it("c_persisted rolls forward to 2 scenes", async () => {
    const f = fixture();
    writeJournal(f, { stage: "c_persisted" });
    const result = await recoverMergeJournal({ dataDir: f.dataDir, config: f.config });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.outcomes[0].action).toBe("completed");
    expect(listScenes(f.dataDir)).toEqual(["merged-scene.md", "other.md"]);
  });

  it("a_deleted completes by deleting B and syncing to 2 scenes", async () => {
    const f = fixture();
    writeJournal(f, { stage: "a_deleted" });
    const result = await recoverMergeJournal({ dataDir: f.dataDir, config: f.config });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.outcomes[0].action).toBe("completed");
    expect(listScenes(f.dataDir)).toEqual(["merged-scene.md", "other.md"]);
  });

  it("a_deleted with A already unlinked by Phase 5 still completes to 2 scenes", async () => {
    const f = fixture();
    writeJournal(f, { stage: "a_deleted" });
    // 模拟 Stage 3 执行失败后、下一轮恢复前 Phase 5 把 [DELETED] A unlink 掉。
    unlinkSync(join(f.dataDir, "scene_blocks", "alpha.md"));
    const result = await recoverMergeJournal({ dataDir: f.dataDir, config: f.config });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.outcomes[0].action).toBe("completed");
    expect(listScenes(f.dataDir)).toEqual(["merged-scene.md", "other.md"]);
  });
  it("b_deleted unlinks both soft-deleted files and converges to 2 scenes", async () => {
    const f = fixture();
    writeJournal(f, { stage: "b_deleted" });
    const result = await recoverMergeJournal({ dataDir: f.dataDir, config: f.config });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.outcomes[0].action).toBe("completed");
    expect(existsSync(join(f.dataDir, "scene_blocks", "alpha.md"))).toBe(false);
    expect(existsSync(join(f.dataDir, "scene_blocks", "beta.md"))).toBe(false);
    const index = await readSceneIndex(f.dataDir);
    expect(index.map((entry) => entry.filename).sort()).toEqual(["merged-scene.md", "other.md"]);
  });

  it("done is a no-op and keeps 2 scenes", async () => {
    const f = fixture();
    writeJournal(f, { stage: "done" });
    const result = await recoverMergeJournal({ dataDir: f.dataDir, config: f.config });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.outcomes[0]).toMatchObject({ action: "noop", stageBefore: "done", stageAfter: "done" });
    expect(listScenes(f.dataDir)).toEqual(["merged-scene.md", "other.md"]);
  });

  it("done with a legitimately rewritten C (Phase 5 governance) is still a no-op", async () => {
    // [Stage 3 seams P0] 终态 journal 的 sha256 只是执行时快照：同轮 Phase 5 治理或后续
    // LLM 正常编辑都会改写 C，恢复必须按「存在且非空」判定 noop，不能按 sha 误报冲突。
    const f = fixture();
    const journalPath = writeJournal(f, { stage: "done" });
    const targetPath = join(f.dataDir, "scene_blocks", f.plan.target);
    const rewritten = f.plan.c.raw + "\n\n## 活动\n- 合并后 Phase 5 追加行";
    writeFileSync(targetPath, rewritten, "utf8");

    const result = await recoverMergeJournal({ dataDir: f.dataDir, config: f.config });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.outcomes[0]).toMatchObject({ action: "noop", stageBefore: "done", stageAfter: "done" });
    expect(readFileSync(targetPath, "utf8")).toBe(rewritten);
    expect(readJournal(journalPath).stage).toBe("done");
    expect(listScenes(f.dataDir)).toEqual(["merged-scene.md", "other.md"]);
  });

  it("returns MERGE_CONFLICT and preserves an externally rewritten input", async () => {
    const f = fixture();
    writeJournal(f, { stage: "prepared" });
    const changed = f.aRaw + "\n- 外部追加行";
    writeFileSync(join(f.dataDir, "scene_blocks", "alpha.md"), changed, "utf8");
    const result = await recoverMergeJournal({ dataDir: f.dataDir, config: f.config });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected conflict");
    expect(result.error.code).toBe("MERGE_CONFLICT");
    expect(readFileSync(join(f.dataDir, "scene_blocks", "alpha.md"), "utf8")).toBe(changed);
    expect(listScenes(f.dataDir)).toEqual(["alpha.md", "beta.md", "other.md"]);
  });

  it("two concurrent recoverers serialize on the merge lock", async () => {
    const f = fixture({ lockWaitMs: 0 });
    writeJournal(f, { stage: "prepared" });
    const [one, two] = await Promise.all([
      recoverMergeJournal({ dataDir: f.dataDir, config: f.config }),
      recoverMergeJournal({ dataDir: f.dataDir, config: f.config }),
    ]);

    expect(one.ok || two.ok).toBe(true);
    const completed = [one, two].filter((result) => result.ok).flatMap((result) => result.outcomes);
    expect(completed.some((outcome) => outcome.action === "rolled_back")).toBe(true);
    expect(listScenes(f.dataDir)).toEqual(["alpha.md", "beta.md", "other.md"]);
  });

  it("returns MERGE_JOURNAL_CORRUPT for a damaged journal and releases the lock", async () => {
    const f = fixture();
    const paths = mergeJournalPaths(f.dataDir, f.config, f.plan.key);
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.file, "{not-json", "utf8");

    const result = await recoverMergeJournal({ dataDir: f.dataDir, config: f.config });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected corrupt journal");
    expect(result.error.code).toBe("MERGE_JOURNAL_CORRUPT");
    expect(existsSync(join(f.dataDir, ".metadata", "merge.lock"))).toBe(false);
  });

  it("does not delete a fresh lock owned by another process (token mismatch)", async () => {
    const f = fixture();
    writeJournal(f, { stage: "prepared" });
    const lockPath = join(f.dataDir, ".metadata", "merge.lock");
    mkdirSync(join(f.dataDir, ".metadata"), { recursive: true });
    const otherLock = JSON.stringify({ owner: "other", pid: 1, host: "test", ts: Date.now(), ttlMs: 300000, key: "x" });
    writeFileSync(lockPath, otherLock, "utf8");

    const result = await recoverMergeJournal({ dataDir: f.dataDir, config: f.config });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected lock busy");
    expect(result.error.code).toBe("MERGE_LOCK_BUSY");
    expect(readFileSync(lockPath, "utf8")).toBe(otherLock);
  });

  it("takes over an expired lock and completes recovery", async () => {
    const f = fixture();
    writeJournal(f, { stage: "prepared" });
    const lockPath = join(f.dataDir, ".metadata", "merge.lock");
    mkdirSync(join(f.dataDir, ".metadata"), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ owner: "dead", pid: 1, host: "test", ts: Date.now() - 600000, ttlMs: 1000, key: "x" }),
      "utf8",
    );

    const result = await recoverMergeJournal({ dataDir: f.dataDir, config: f.config });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.outcomes[0].action).toBe("rolled_back");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("takes over a truncated (empty) lock file by mtime once TTL elapsed", async () => {
    const f = fixture();
    writeJournal(f, { stage: "prepared" });
    const lockPath = join(f.dataDir, ".metadata", "merge.lock");
    mkdirSync(join(f.dataDir, ".metadata"), { recursive: true });
    // 模拟 kill 落在锁文件创建/心跳写入中间：锁存在但内容为空，没有 ts/ttl。
    writeFileSync(lockPath, "", "utf8");
    const old = new Date(Date.now() - 600_000);
    utimesSync(lockPath, old, old);

    const result = await recoverMergeJournal({ dataDir: f.dataDir, config: f.config });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.outcomes[0].action).toBe("rolled_back");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("removes orphan atomic-replacement temps left by a crash", async () => {
    const f = fixture();
    writeJournal(f, { stage: "prepared" });
    const orphanA = join(f.dataDir, "scene_blocks", "alpha.md.merge-tmp");
    const orphanPersona = join(f.dataDir, "persona.md.merge-tmp");
    writeFileSync(orphanA, "partial", "utf8");
    writeFileSync(orphanPersona, "partial", "utf8");

    const result = await recoverMergeJournal({ dataDir: f.dataDir, config: f.config });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.outcomes[0].action).toBe("rolled_back");
    expect(existsSync(orphanA)).toBe(false);
    expect(existsSync(orphanPersona)).toBe(false);
    expect(listScenes(f.dataDir)).toEqual(["alpha.md", "beta.md", "other.md"]);
  });

  it("failed journal with a valid C rolls forward instead of staying half-merged", async () => {
    const f = fixture();
    const journalPath = writeJournal(f, { stage: "failed", withC: true });
    const result = await recoverMergeJournal({ dataDir: f.dataDir, config: f.config });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.outcomes[0]).toMatchObject({ action: "completed", stageBefore: "failed", stageAfter: "done" });
    expect(listScenes(f.dataDir)).toEqual(["merged-scene.md", "other.md"]);
    expect(readJournal(journalPath).stage).toBe("done");
  });

  it("rolled_back journal without C is skipped and keeps 3 scenes", async () => {
    const f = fixture();
    writeJournal(f, { stage: "rolled_back" });
    const result = await recoverMergeJournal({ dataDir: f.dataDir, config: f.config });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.outcomes[0]).toMatchObject({
      action: "skipped",
      stageBefore: "rolled_back",
      stageAfter: "rolled_back",
    });
    expect(listScenes(f.dataDir)).toEqual(["alpha.md", "beta.md", "other.md"]);
  });

  it("rolled_back journal with a C is a conflict", async () => {
    const f = fixture();
    writeJournal(f, { stage: "rolled_back", withC: true });
    const result = await recoverMergeJournal({ dataDir: f.dataDir, config: f.config });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected conflict");
    expect(result.error.code).toBe("MERGE_CONFLICT");
  });
});

describe("executeMerge idempotency (T04)", () => {
  it("same plan returns skipped with no second C; different target also skips", async () => {
    const f = fixture();
    const existing = readdirSync(join(f.dataDir, "scene_blocks"));
    const alt = planMerge(
      { filename: "alpha.md", raw: f.aRaw },
      { filename: "beta.md", raw: f.bRaw },
      { config: f.config, now: NOW, target: "other-name.md", sceneCharCap: SCENE_CHAR_CAP, existingSceneNames: existing },
    );
    if (!alt.ok) throw new Error("alt plan rejected: " + alt.rejection.message);

    const first = await executeMerge({
      plan: f.plan,
      config: f.config,
      sceneCharCap: SCENE_CHAR_CAP,
      dataDir: f.dataDir,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);
    expect(first.status).toBe("merged");

    const second = await executeMerge({
      plan: f.plan,
      config: f.config,
      sceneCharCap: SCENE_CHAR_CAP,
      dataDir: f.dataDir,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error.message);
    expect(second.status).toBe("skipped");
    expect(second.target).toBe("merged-scene.md");
    expect(second.journalStage).toBe("done");

    const third = await executeMerge({
      plan: alt.plan,
      config: f.config,
      sceneCharCap: SCENE_CHAR_CAP,
      dataDir: f.dataDir,
    });
    expect(third.ok).toBe(true);
    if (!third.ok) throw new Error(third.error.message);
    expect(third.status).toBe("skipped");
    expect(third.target).toBe("merged-scene.md");
    expect(listScenes(f.dataDir)).toEqual(["merged-scene.md", "other.md"]);
  });

  it("retries a failed journal with a valid C by finishing it (no second C)", async () => {
    const f = fixture();
    const journalPath = writeJournal(f, { stage: "failed", withC: true });
    const result = await executeMerge({
      plan: f.plan,
      config: f.config,
      sceneCharCap: SCENE_CHAR_CAP,
      dataDir: f.dataDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.status).toBe("skipped");
    expect(result.journalStage).toBe("done");
    expect(listScenes(f.dataDir)).toEqual(["merged-scene.md", "other.md"]);
    expect(readJournal(journalPath).stage).toBe("done");
  });

  it("retries a failed journal without C after restoring a soft-deleted A", async () => {
    const f = fixture();
    const journalPath = writeJournal(f, { stage: "failed" });
    writeFileSync(join(f.dataDir, "scene_blocks", "alpha.md"), "[DELETED]", "utf8");

    const result = await executeMerge({
      plan: f.plan,
      config: f.config,
      sceneCharCap: SCENE_CHAR_CAP,
      dataDir: f.dataDir,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.status).toBe("merged");
    expect(listScenes(f.dataDir)).toEqual(["merged-scene.md", "other.md"]);
    const attempts = readJournal(journalPath).attempts.map((attempt) => attempt.result);
    expect(attempts).toEqual(expect.arrayContaining(["failed", "retry", "prepared", "done"]));
  });

  it("retries a rolled_back journal and merges", async () => {
    const f = fixture();
    const journalPath = writeJournal(f, { stage: "rolled_back" });

    const result = await executeMerge({
      plan: f.plan,
      config: f.config,
      sceneCharCap: SCENE_CHAR_CAP,
      dataDir: f.dataDir,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.status).toBe("merged");
    expect(listScenes(f.dataDir)).toEqual(["merged-scene.md", "other.md"]);
    expect(readJournal(journalPath).stage).toBe("done");
  });

  it("rejects a retry whose target differs from the journal (never a second C)", async () => {
    const f = fixture();
    writeJournal(f, { stage: "failed", withC: true });
    const existing = readdirSync(join(f.dataDir, "scene_blocks"));
    const alt = planMerge(
      { filename: "alpha.md", raw: f.aRaw },
      { filename: "beta.md", raw: f.bRaw },
      { config: f.config, now: NOW, target: "other-name.md", sceneCharCap: SCENE_CHAR_CAP, existingSceneNames: existing },
    );
    if (!alt.ok) throw new Error("alt plan rejected: " + alt.rejection.message);

    const result = await executeMerge({
      plan: alt.plan,
      config: f.config,
      sceneCharCap: SCENE_CHAR_CAP,
      dataDir: f.dataDir,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected conflict");
    expect(result.error.code).toBe("MERGE_CONFLICT");
    expect(listScenes(f.dataDir)).toEqual(["alpha.md", "beta.md", "merged-scene.md", "other.md"]);
  });

  it("rejects non-local backends and the production dataDir unless allowProductionDataDir", async () => {
    const dataDir = tempDataDir();
    const config = getConfig();
    const nonLocal = await recoverMergeJournal({ dataDir, config, backend: "storage" });
    expect(nonLocal.ok).toBe(false);
    if (nonLocal.ok) throw new Error("expected unsupported backend");
    expect(nonLocal.error.code).toBe("MERGE_UNSUPPORTED_ATOMICITY");
    expect(existsSync(join(dataDir, ".metadata"))).toBe(false);

    const productionLike = join(tmpdir(), ".memory-tencentdb", "memory-tdai", "merge-stage3-recover-" + Date.now());
    cleanupDirs.push(productionLike);
    const guarded = await recoverMergeJournal({ dataDir: productionLike, config });
    expect(guarded.ok).toBe(false);
    if (guarded.ok) throw new Error("expected production guard");
    expect(guarded.error.code).toBe("MERGE_PRODUCTION_DATADIR");
    expect(existsSync(productionLike)).toBe(false);

    const allowed = await recoverMergeJournal({ dataDir: productionLike, config, allowProductionDataDir: true });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) throw new Error(allowed.error.message);
    expect(allowed.scanned).toBe(0);
  });

  it("prepared 阶段 A 已被外部删除时仍报 MERGE_CONFLICT（不放宽为 blanket 容忍）", async () => {
    const f = fixture();
    const journalPath = writeJournal(f, { stage: "prepared", withC: true });
    expect(existsSync(journalPath)).toBe(true);
    const aPath = join(f.dataDir, "scene_blocks", f.plan.a.filename);
    unlinkSync(aPath); // 模拟外部并发删除；prepared 阶段尚未轮到删 A

    const result = await recoverMergeJournal({ dataDir: f.dataDir, config: f.config });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected conflict");
    expect(result.error.code).toBe("MERGE_CONFLICT");
    // 不覆盖外部事实：A 不会被凭 preimage 重建，C 已落盘但事务未收敛。
    expect(existsSync(aPath)).toBe(false);
    expect(existsSync(join(f.dataDir, "scene_blocks", f.plan.target))).toBe(true);
  });
});
