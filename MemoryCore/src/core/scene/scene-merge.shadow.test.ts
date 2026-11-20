/**
 * Stage 2 S01：shadow 选对（纯函数）与 journal GC。
 *
 * 选对的输入是目录事实（filename + raw），不读 fs；GC 用隔离临时 dataDir，
 * 只验证「保留最近 200 条/90 天、failed 永不删、损坏不删、只删 journal+preimage」。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatSceneBlock } from "./scene-format.js";
import {
  gcMergeJournals,
  parseMergeSceneConfig,
  selectMergeCandidate,
  type MergeSceneConfig,
  type MergeShadowInput,
} from "./scene-merge.js";

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "merge-shadow-"));
  cleanupDirs.push(dir);
  return dir;
}

const META = { created: "2026-11-01T00:00:00.000Z", updated: "2026-11-02T00:00:00.000Z", summary: "测试", heat: 10 };

function anchor(i: number): string {
  return "m_17950783076" + String(10 + i) + "_" + String(i).repeat(8).slice(0, 8);
}

function v2Scene(opts: { anchors?: string[]; note?: string; pad?: number }): string {
  const anchors = opts.anchors ?? [];
  const lines = [
    "## 要点",
    ...anchors.map((id) => "- 要点 " + id),
    ...(opts.note ? [opts.note] : []),
    "## 事实",
    "- 事实行",
    "## 活动",
    "- 活动行",
  ];
  if (opts.pad) lines.push("## 活动", "padding-".repeat(opts.pad));
  return formatSceneBlock(META, lines.join("\n"));
}

function sceneInput(filename: string, opts: { anchors?: string[]; note?: string; pad?: number; raw?: string }): MergeShadowInput {
  return { filename, raw: opts.raw ?? v2Scene(opts) };
}

const CONFIG: Pick<MergeSceneConfig, "headScenes" | "pairCharLimit"> = {
  headScenes: ["技术研究-TDAI记忆系统治理与观测.md"],
  pairCharLimit: 40_000,
};

describe("selectMergeCandidate", () => {
  it("选共享锚点最多的对", () => {
    const a = sceneInput("技术研究-a.md", { anchors: [anchor(1), anchor(2)] });
    const b = sceneInput("技术研究-b.md", { anchors: [anchor(1), anchor(2), anchor(3)] });
    const c = sceneInput("技术研究-c.md", { anchors: [anchor(1)] });
    const picked = selectMergeCandidate([c, a, b], CONFIG);
    expect(picked).not.toBeNull();
    expect([picked!.a.filename, picked!.b.filename]).toEqual(["技术研究-a.md", "技术研究-b.md"]);
    expect(picked!.sharedAnchors).toBe(2);
  });

  it("头部场景被排除", () => {
    const head = sceneInput(CONFIG.headScenes[0]!, { anchors: [anchor(1), anchor(2)] });
    const b = sceneInput("技术研究-b.md", { anchors: [anchor(1)] });
    const c = sceneInput("技术研究-c.md", { anchors: [anchor(1)] });
    const picked = selectMergeCandidate([head, b, c], CONFIG);
    expect([picked!.a.filename, picked!.b.filename]).toEqual(["技术研究-b.md", "技术研究-c.md"]);
  });

  it("头部场景即使共享锚点最多也被排除", () => {
    const head = sceneInput(CONFIG.headScenes[0]!, { anchors: [anchor(1), anchor(2)] });
    const b = sceneInput("技术研究-b.md", { anchors: [anchor(1), anchor(2)] });
    const c = sceneInput("技术研究-c.md", { anchors: [anchor(1)] });
    const picked = selectMergeCandidate([head, b, c], CONFIG);
    expect([picked!.a.filename, picked!.b.filename]).toEqual(["技术研究-b.md", "技术研究-c.md"]);
  });

  it("归档（文件名或 META archive:true）被排除", () => {
    const archivedByName = sceneInput("技术研究-a-archive.md", { anchors: [anchor(1)] });
    const archivedByMeta = sceneInput("技术研究-a2.md", {
      anchors: [anchor(1)],
      raw: formatSceneBlock({ ...META, archive: true } as never, "## 要点\n- x"),
    });
    const b = sceneInput("技术研究-b.md", { anchors: [anchor(1)] });
    const c = sceneInput("技术研究-c.md", { anchors: [anchor(1)] });
    const picked = selectMergeCandidate([archivedByName, archivedByMeta, b, c], CONFIG);
    expect(picked).not.toBeNull();
    expect([picked!.a.filename, picked!.b.filename]).toEqual(["技术研究-b.md", "技术研究-c.md"]);
  });

  it("[DELETED] 与空正文被排除", () => {
    const deleted = sceneInput("技术研究-a.md", {
      raw: formatSceneBlock(META, "[DELETED]"),
    });
    const empty = { filename: "技术研究-e.md", raw: "" };
    const b = sceneInput("技术研究-b.md", { anchors: [anchor(1)] });
    const c = sceneInput("技术研究-c.md", { anchors: [anchor(1)] });
    const picked = selectMergeCandidate([deleted, empty, b, c], CONFIG);
    expect([picked!.a.filename, picked!.b.filename]).toEqual(["技术研究-b.md", "技术研究-c.md"]);
  });

  it("非 v2 被排除", () => {
    const v1 = { filename: "技术研究-a.md", raw: formatSceneBlock(META, "只是正文，没有段标题") };
    const b = sceneInput("技术研究-b.md", { anchors: [anchor(1)] });
    const c = sceneInput("技术研究-c.md", { anchors: [anchor(1)] });
    const picked = selectMergeCandidate([v1, b, c], CONFIG);
    expect([picked!.a.filename, picked!.b.filename]).toEqual(["技术研究-b.md", "技术研究-c.md"]);
  });

  it("超 pairCharLimit 的对被排除，选择更短的对", () => {
    const big = sceneInput("技术研究-a.md", { anchors: [anchor(1), anchor(2)], pad: 2000 });
    const b = sceneInput("技术研究-b.md", { anchors: [anchor(1), anchor(2)] });
    const c = sceneInput("技术研究-c.md", { anchors: [anchor(1)] });
    const picked = selectMergeCandidate([big, b, c], { ...CONFIG, pairCharLimit: 2000 });
    expect(picked).not.toBeNull();
    expect([picked!.a.filename, picked!.b.filename]).toEqual(["技术研究-b.md", "技术研究-c.md"]);
  });

  it("输入换序结果不变", () => {
    const inputs = [
      sceneInput("技术研究-a.md", { anchors: [anchor(1)] }),
      sceneInput("技术研究-b.md", { anchors: [anchor(1), anchor(2)] }),
      sceneInput("技术研究-c.md", { anchors: [anchor(2)] }),
    ];
    const first = selectMergeCandidate(inputs, CONFIG);
    const second = selectMergeCandidate([...inputs].reverse(), CONFIG);
    expect(first).toEqual(second);
    // 共享锚点数与字符数均平手 → 文件名字典序兜底（a-b 在 c 之前）。
    expect([first!.a.filename, first!.b.filename]).toEqual(["技术研究-a.md", "技术研究-b.md"]);
  });

  it("无共享锚点 / 输入不足 / 非法选项返回 null", () => {
    const a = sceneInput("技术研究-a.md", { anchors: [anchor(1)] });
    const b = sceneInput("技术研究-b.md", { anchors: [anchor(2)] });
    expect(selectMergeCandidate([a, b], CONFIG)).toBeNull();
    expect(selectMergeCandidate([a], CONFIG)).toBeNull();
    expect(selectMergeCandidate([a, b], { ...CONFIG, pairCharLimit: 0 })).toBeNull();
  });
});

function journalKey(i: number): string {
  return createHash("sha256").update("gc-" + String(i)).digest("hex");
}

function journalFixture(key: string, stage: string, updatedAt: string): unknown {
  return {
    version: 1,
    key,
    inputs: {
      a: { filename: "技术研究-a.md", sha256: "a".repeat(64), chars: 10 },
      b: { filename: "技术研究-b.md", sha256: "b".repeat(64), chars: 10 },
    },
    concatOrder: "a,b",
    target: { filename: "a-b-合并.md", sha256: "c".repeat(64), chars: 20 },
    stage,
    attempts: [],
    pid: 1,
    host: "test",
    startedAt: updatedAt,
    updatedAt,
    metrics: {},
  };
}

function writeJournal(dir: string, key: string, stage: string, updatedAt: string, withPreimage = false): void {
  const root = join(dir, ".metadata", "merge-journal");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, key + ".json"), JSON.stringify(journalFixture(key, stage, updatedAt)));
  if (withPreimage) {
    mkdirSync(join(root, key), { recursive: true });
    writeFileSync(join(root, key, "A.pre.md"), "pre-a");
  }
}

const GC_CONFIG = { journalDir: ".metadata/merge-journal" } as Pick<MergeSceneConfig, "journalDir">;

describe("gcMergeJournals", () => {
  it("目录不存在时零写返回", async () => {
    const dir = makeTmp();
    const result = await gcMergeJournals({ dataDir: dir, config: GC_CONFIG });
    expect(result).toEqual({ scanned: 0, removed: 0, kept: 0, corrupt: 0 });
  });

  it("超过 200 条时删最旧，保留最新 200 条与 preimage 对应关系", async () => {
    const dir = makeTmp();
    const base = Date.parse("2026-11-01T00:00:00.000Z");
    for (let i = 0; i < 205; i += 1) {
      const key = journalKey(i);
      const ts = new Date(base + i * 1000).toISOString();
      writeJournal(dir, key, "done", ts, i < 7);
    }
    const result = await gcMergeJournals({ dataDir: dir, config: GC_CONFIG, now: base + 10_000_000 });
    expect(result).toEqual({ scanned: 205, removed: 5, kept: 200, corrupt: 0 });
    const root = join(dir, ".metadata", "merge-journal");
    expect(readdirSync(root).filter((n) => n.endsWith(".json"))).toHaveLength(200);
    expect(existsSync(join(root, journalKey(0)))).toBe(false);
    expect(existsSync(join(root, journalKey(0) + ".json"))).toBe(false);
    expect(existsSync(join(root, journalKey(204) + ".json"))).toBe(true);
  });

  it("超过 90 天的删、fresh 与 failed 保留", async () => {
    const dir = makeTmp();
    const now = Date.parse("2026-11-19T00:00:00.000Z");
    writeJournal(dir, journalKey(1), "done", new Date(now - 91 * 24 * 3600 * 1000).toISOString());
    writeJournal(dir, journalKey(2), "done", new Date(now - 89 * 24 * 3600 * 1000).toISOString());
    writeJournal(dir, journalKey(3), "failed", new Date(now - 200 * 24 * 3600 * 1000).toISOString());
    const result = await gcMergeJournals({ dataDir: dir, config: GC_CONFIG, now });
    expect(result.removed).toBe(1);
    expect(result.kept).toBe(2);
    const root = join(dir, ".metadata", "merge-journal");
    expect(existsSync(join(root, journalKey(1) + ".json"))).toBe(false);
    expect(existsSync(join(root, journalKey(2) + ".json"))).toBe(true);
    expect(existsSync(join(root, journalKey(3) + ".json"))).toBe(true);
  });

  it("非终态 journal（prepared/c_persisted/a_deleted/b_deleted）永不回收", async () => {
    const dir = makeTmp();
    const now = Date.parse("2026-11-19T00:00:00.000Z");
    const oldTs = new Date(now - 200 * 24 * 3600 * 1000).toISOString();
    const stages = ["prepared", "c_persisted", "a_deleted", "b_deleted"];
    stages.forEach((stage, i) => writeJournal(dir, journalKey(10 + i), stage, oldTs, true));
    writeJournal(dir, journalKey(20), "done", oldTs);
    writeJournal(dir, journalKey(21), "rolled_back", oldTs);
    const result = await gcMergeJournals({ dataDir: dir, config: GC_CONFIG, now });
    expect(result.removed).toBe(2);
    expect(result.kept).toBe(4);
    const root = join(dir, ".metadata", "merge-journal");
    stages.forEach((_stage, i) => {
      expect(existsSync(join(root, journalKey(10 + i) + ".json"))).toBe(true);
      expect(existsSync(join(root, journalKey(10 + i), "A.pre.md"))).toBe(true);
    });
    expect(existsSync(join(root, journalKey(20) + ".json"))).toBe(false);
    expect(existsSync(join(root, journalKey(21) + ".json"))).toBe(false);
  });

  it("损坏 journal 跳过且不删，.json.tmp 被清理", async () => {
    const dir = makeTmp();
    const root = join(dir, ".metadata", "merge-journal");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "broken.json"), "{not-json");
    writeFileSync(join(root, "orphan.json.tmp"), "{}");
    const result = await gcMergeJournals({ dataDir: dir, config: GC_CONFIG });
    expect(result.corrupt).toBe(1);
    expect(result.removed).toBe(0);
    expect(existsSync(join(root, "broken.json"))).toBe(true);
    expect(existsSync(join(root, "orphan.json.tmp"))).toBe(false);
  });

  it("默认配置解析出的 journalDir 可用于 GC", async () => {
    const config = parseMergeSceneConfig(true, 500_000)!;
    const dir = makeTmp();
    const result = await gcMergeJournals({ dataDir: dir, config });
    expect(result.scanned).toBe(0);
  });
});
