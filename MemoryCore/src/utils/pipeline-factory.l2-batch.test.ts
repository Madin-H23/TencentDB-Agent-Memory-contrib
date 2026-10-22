// L2 场景抽取的**批次上限与游标语义**（2026-10-22，用户令「先做 N=50（yaml 可配）+ 游标按本批推进」）。
//
// 背景（§13.14/§13.15）：L2 此前把"游标之后的全部 L1 记录"塞进一次提示词 ⇒ 积压时单轮
// 40 万字符（实测 4,041 条）⇒ 必然撞上下文（400）+ 内存尖峰 ⇒ 提交量一紧就把网关进程送走；
// 且 L2 长时间占住 profile 级 checkpoint 锁 ⇒ 56 个会话的 L1/L2/L3 任务全被 park
// ⇒ L1 游标不前进 ⇒ 积压更大（自增强回路）。
//
// 本文件钉三条契约：
//   A 批次上限：单轮最多取 N 条（默认 50，yaml persona.maxL2Batch 可配）；
//   B 游标按**本批**推进：latestCursor = 本批记录的最大 updatedAt（不是全部记录的最大值）；
//   C 不丢记录：分片后两轮拿到的记录合起来 = 全部，且与同毫秒兄弟不丢。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  /** 每轮抽取器收到的记忆 id 序列（按轮次分桶） */
  batches: [] as string[][],
}));

vi.mock("../core/scene/scene-extractor.js", () => ({
  SceneExtractor: class {
    async extract(memories: Array<{ id: string }>) {
      const ids = memories.map((m) => m.id);
      h.batches.push(ids);
      return { memoriesProcessed: ids.length, success: true };
    }
  },
}));

const { createL2Runner } = await import("./pipeline-factory.js");

const SESSION_KEY = "zcode-default";
const T0 = Date.UTC(2026, 9, 22, 0, 0, 0);
const ts = (n: number) => new Date(T0 + n * 1000).toISOString();

type Row = {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  metadata_json: string;
  timestamp_str: string;
  timestamp_start: string;
  timestamp_end: string;
  created_time: string;
  updated_time: string;
  version: number;
  session_key: string;
  session_id: string;
  team_id: string;
  task_id: string;
  user_id: string;
  agent_id: string;
};

function makeRow(id: string, updated: string): Row {
  return {
    record_id: id,
    content: `内容 ${id}`,
    type: "episodic",
    priority: 50,
    scene_name: "场景",
    metadata_json: "{}",
    timestamp_str: updated,
    timestamp_start: updated,
    timestamp_end: updated,
    created_time: updated,
    updated_time: updated,
    version: 1,
    session_key: SESSION_KEY,
    session_id: "sess-1",
    team_id: "default",
    task_id: "t1",
    user_id: "default",
    agent_id: "default",
  };
}

/** 假 store：像真实 sqlite 实现那样按 updatedAfter（严格大于）过滤 */
function makeStore(rows: Row[]) {
  return {
    isDegraded: () => false,
    queryL1Records: async (filter?: { updatedAfter?: string; sessionKey?: string }) => {
      let out = rows;
      if (filter?.updatedAfter) {
        out = out.filter((r) => r.updated_time > filter.updatedAfter!);
      }
      if (filter?.sessionKey) {
        out = out.filter((r) => r.session_key === filter.sessionKey);
      }
      return out;
    },
  } as never;
}

function makeRunner(baseDir: string, rows: Row[], maxL2Batch?: number) {
  return createL2Runner({
    pluginDataDir: baseDir,
    cfg: {
      persona: { maxScenes: 15, promptMode: "chat", sceneBackupCount: 3, ...(maxL2Batch ? { maxL2Batch } : {}) },
      llm: { layers: { l2: { model: "deepseek-v4-flash" } }, providerLabel: "opencode-go" },
    } as never,
    openclawConfig: undefined,
    vectorStore: makeStore(rows),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
    llmRunner: { run: async () => "" } as never,
  });
}

function makeRows(n: number, updatedAt: (i: number) => string = (i) => ts(i + 1)): Row[] {
  return Array.from({ length: n }, (_, i) => makeRow(`r${String(i + 1).padStart(3, "0")}`, updatedAt(i)));
}

describe("L2 批次上限（persona.maxL2Batch）", () => {
  beforeEach(() => {
    h.batches.length = 0;
  });

  it("A：单轮最多取 N 条（配 50、有 120 条 ⇒ 抽取器只收到 50 条，且是最旧的 50 条）", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l2-batch-cap-"));
    try {
      const runner = makeRunner(baseDir, makeRows(120), 50);
      await runner(SESSION_KEY);
      expect(h.batches.length).toBe(1);
      expect(h.batches[0].length).toBe(50);
      expect(h.batches[0][0]).toBe("r001");
      expect(h.batches[0][49]).toBe("r050");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("A：未配置时默认 50（yaml 可配、缺省不放大）", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l2-batch-default-"));
    try {
      const runner = makeRunner(baseDir, makeRows(120));
      await runner(SESSION_KEY);
      expect(h.batches[0].length).toBe(50);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("B：游标按本批推进（本批最后一条的 updatedAt，不是全部记录的最大值）", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l2-batch-cursor-"));
    try {
      const runner = makeRunner(baseDir, makeRows(120), 50);
      const res = await runner(SESSION_KEY);
      expect(res?.latestCursor).toBe(ts(50)); // 第 50 条的 updatedAt
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("C：分片不丢不重——两轮拿到的记录合起来 = 全部 120 条", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l2-batch-noloss-"));
    try {
      const rows = makeRows(120);
      const runner = makeRunner(baseDir, rows, 50);
      const first = await runner(SESSION_KEY);
      const second = await runner(SESSION_KEY, first?.latestCursor);
      const third = await runner(SESSION_KEY, second?.latestCursor);
      const got = h.batches.flat();
      expect(got.length).toBe(120);
      expect(new Set(got).size).toBe(120);
      expect(got).toEqual(rows.map((r) => r.record_id));
      expect(third?.latestCursor).toBe(ts(120));
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("C：同毫秒兄弟不丢——批次边界落在同值组中间时，整组都进本批", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l2-batch-samets-"));
    try {
      // r001..r049 各 1 秒；r050..r054 五条同值(ts(50))；r055 之后正常递增
      const updated = (i: number) => (i < 49 ? ts(i + 1) : i < 54 ? ts(50) : ts(i + 2));
      const rows = makeRows(80, updated);
      const runner = makeRunner(baseDir, rows, 50);
      const first = await runner(SESSION_KEY);
      const got = h.batches[0];
      // 前 49 条 + 5 条同值兄弟 = 54 条（超过 limit 是有意的：同值扩边防丢）
      expect(got.length).toBe(54);
      expect(got).toContain("r050");
      expect(got).toContain("r054");
      // 游标取本批最大值 = ts(50)，下一轮从 ts(50) 之后开始 ⇒ 同值兄弟不重复也不丢
      expect(first?.latestCursor).toBe(ts(50));
      const second = await runner(SESSION_KEY, first?.latestCursor);
      const secondIds = h.batches[1];
      expect(secondIds).not.toContain("r050");
      expect(secondIds).not.toContain("r054");
      expect(new Set([...got, ...secondIds]).size).toBe(80);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
