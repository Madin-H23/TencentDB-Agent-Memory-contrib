/**
 * Stage 2（SPEC-E §4.13 门禁 A）：pipeline-factory → SceneExtractorOptions.mergeScene 装配透传。
 * 只 mock SceneExtractor 构造器，工厂代码路径真实执行，防止「假旋钮」漏传。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  captured: [] as Array<Record<string, unknown>>,
}));

vi.mock("../core/scene/scene-extractor.js", () => ({
  SceneExtractor: class {
    constructor(opts: Record<string, unknown>) {
      h.captured.push(opts);
    }
    async extract() {
      return { memoriesProcessed: 0, success: true };
    }
  },
}));

const { createL2Runner } = await import("./pipeline-factory.js");

const SESSION_KEY = "zcode-default";
const T0 = "2026-11-19T02:00:00.000Z";

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

function makeRunner(baseDir: string, mergeScene: unknown, rows: Array<Record<string, unknown>>) {
  return createL2Runner({
    pluginDataDir: baseDir,
    cfg: {
      persona: { maxScenes: 24, promptMode: "chat", sceneBackupCount: 3, ...(mergeScene === undefined ? {} : { mergeScene }) },
      llm: {},
    } as never,
    openclawConfig: undefined,
    vectorStore: makeStore(rows),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
    llmRunner: { run: async () => "done" } as never,
  });
}

const CANDIDATE_PAIRS = [{ a: "技术研究-h-family项目群.md", b: "实习周报-格式规范与产出流程.md" }];

describe("L2 装配：persona.mergeScene 必须透传进 SceneExtractorOptions", () => {
  beforeEach(() => {
    h.captured.length = 0;
  });

  it("shadow 配置透传（mode/candidatePairs 原样出现在构造参数）", async () => {
    const mergeScene = { mode: "shadow", candidatePairs: CANDIDATE_PAIRS };
    const baseDir = mkdtempSync(join(tmpdir(), "l2-merge-shadow-"));
    try {
      const runner = makeRunner(baseDir, mergeScene, [makeRow()]);
      await runner(SESSION_KEY).catch(() => {});
      expect(h.captured.length).toBe(1);
      expect(h.captured[0].mergeScene).toBeDefined();
      expect((h.captured[0].mergeScene as Record<string, unknown>).mode).toBe("shadow");
      expect((h.captured[0].mergeScene as Record<string, unknown>).candidatePairs).toEqual(CANDIDATE_PAIRS);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("未配置 mergeScene 时透传 undefined（默认 off，不启用钩子）", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l2-merge-off-"));
    try {
      const runner = makeRunner(baseDir, undefined, [makeRow()]);
      await runner(SESSION_KEY).catch(() => {});
      expect(h.captured.length).toBe(1);
      expect(h.captured[0].mergeScene).toBeUndefined();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
