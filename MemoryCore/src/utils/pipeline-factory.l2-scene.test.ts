// L2 场景抽取的两条契约（2026-10-21）：
//   A 超时上限：L2 场景抽取必须用 llm.layers.l2.timeoutMs（yaml 600000），
//     此前工厂构造 SceneExtractor 时不传 timeoutMs → 抽取器内部回落硬编码
//     300s（opts.timeoutMs ?? 300_000）并以该值覆盖层配置 ⇒ yaml 的层超时
//     对场景抽取从不生效（实测 22 次失败里 16 次卡在这条 300s 线上）。
//   B 失败记账：场景抽取失败必须上抛，让 worker 记 Task failed（可重试/可进
//     死信）；此前抽取器把错误塞进返回值 success:false，工厂 continue 吞掉
//     → worker 记 "Task completed: L2"（失败不可见、不重试、不进死信），
//     且 cursor 按全部 records 的最大 updatedAt 推进 → 失败组被静默跳过。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  captured: [] as Array<Record<string, unknown>>,
  extractResult: { memoriesProcessed: 0, success: false, error: "boom" } as {
    memoriesProcessed: number;
    success: boolean;
    error?: string;
    emptyExtraction?: boolean;
  },
}));

vi.mock("../core/scene/scene-extractor.js", () => ({
  SceneExtractor: class {
    constructor(opts: Record<string, unknown>) {
      h.captured.push(opts);
    }
    async extract() {
      return h.extractResult;
    }
  },
}));

const { createL2Runner } = await import("./pipeline-factory.js");

const SESSION_KEY = "zcode-default";
const T0 = "2026-10-21T02:00:00.000Z";

function makeRow(over: Record<string, unknown> = {}) {
  return {
    record_id: "m_1",
    content: "一条记忆内容",
    type: "episodic",
    priority: 50,
    scene_name: "场景",
    metadata_json: "{}",
    timestamp_str: T0,
    timestamp_start: T0,
    timestamp_end: T0,
    created_time: T0,
    updated_time: T0,
    version: 1,
    session_key: SESSION_KEY,
    session_id: "sess-1",
    task_id: "t1",
    team_id: "default",
    user_id: "default",
    agent_id: "default",
    ...over,
  };
}

function makeStore(rows: Array<Record<string, unknown>>) {
  return {
    isDegraded: () => false,
    queryL1Records: async () => rows,
  } as never;
}

function makeRunner(baseDir: string, rows: Array<Record<string, unknown>>, llmLayers?: Record<string, unknown>) {
  return createL2Runner({
    pluginDataDir: baseDir,
    cfg: {
      persona: { maxScenes: 15, promptMode: "chat", sceneBackupCount: 3 },
      llm: llmLayers ? { layers: llmLayers } : {},
    } as never,
    openclawConfig: undefined,
    vectorStore: makeStore(rows),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
    llmRunner: { run: async () => "" } as never,
  });
}

describe("L2 场景抽取：超时上限接线", () => {
  beforeEach(() => {
    h.captured.length = 0;
    h.extractResult = { memoriesProcessed: 0, success: false, error: "boom" };
  });

  it("层配置了 l2.timeoutMs 时，抽取器用层超时（600000）而不是自带 300s", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l2-timeout-"));
    try {
      const runner = makeRunner(baseDir, [makeRow()], { l2: { timeoutMs: 600_000 } });
      await runner(SESSION_KEY).catch(() => {}); // 抽取失败是另一条契约，这里只关心构造参数
      expect(h.captured.length).toBe(1);
      // 生效超时 = 传入值 ?? 抽取器自带 300_000
      const effective = (h.captured[0].timeoutMs as number | undefined) ?? 300_000;
      expect(effective).toBe(600_000);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("层未配置 l2.timeoutMs 时，生效超时仍是抽取器自带的 300s（行为不变）", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l2-timeout-default-"));
    try {
      const runner = makeRunner(baseDir, [makeRow()]);
      await runner(SESSION_KEY).catch(() => {});
      expect(h.captured.length).toBe(1);
      const effective = (h.captured[0].timeoutMs as number | undefined) ?? 300_000;
      expect(effective).toBe(300_000);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

describe("L2 场景抽取：失败必须上抛（不再被吞成 Task completed）", () => {
  beforeEach(() => {
    h.captured.length = 0;
    h.extractResult = { memoriesProcessed: 0, success: false, error: "boom" };
  });

  it("抽取失败（success:false）→ runner 上抛，错误信息带上游原文", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l2-fail-throw-"));
    try {
      const runner = makeRunner(baseDir, [makeRow()]);
      await expect(runner(SESSION_KEY)).rejects.toThrow(/boom/);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("抽取成功但无记忆处理（memoriesProcessed:0）→ 不得上抛（防误伤）", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l2-fail-benign-"));
    try {
      h.extractResult = { memoriesProcessed: 0, success: true };
      const runner = makeRunner(baseDir, [makeRow()]);
      await expect(runner(SESSION_KEY)).resolves.toBeUndefined();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("抽取成功但空抽取（emptyExtraction）→ 不得上抛（防误伤）", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l2-fail-empty-"));
    try {
      h.extractResult = { memoriesProcessed: 0, success: true, emptyExtraction: true };
      const runner = makeRunner(baseDir, [makeRow()]);
      await expect(runner(SESSION_KEY)).resolves.toBeUndefined();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
