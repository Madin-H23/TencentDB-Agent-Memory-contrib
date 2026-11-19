/**
 * Stage 2 门禁 A（端到端）：pipeline-factory 真实装配 → 真实 SceneExtractor.extract()
 * → Phase 4.5 shadow 钩子产 metric=l2_merge。
 *
 * 与 pipeline-factory.merge-scene.test.ts 的分工：那个文件 mock 抽取器只验证
 * 构造参数透传；本文件不 mock，验证"工厂 → 真实抽取 → 钩子"整条链路，
 * 关闭 Spec 审 P1-2「A 只有 mock 证据」的缺口。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProfileIsolationScope } from "../core/profile/profile-scope.js";
import { parseMergeSceneConfig } from "../core/scene/scene-merge.js";
import { createL2Runner } from "./pipeline-factory.js";

const SESSION_KEY = "zcode-default";
const T0 = "2026-11-19T02:00:00.000Z";
const ANCHOR = "m_1793500000000_00000001";

function sceneRaw(name: string): string {
  return [
    "-----META-START-----",
    "created: 2026-11-01T00:00:00.000Z",
    "updated: 2026-11-02T00:00:00.000Z",
    `summary: ${name}`,
    "heat: 1",
    "-----META-END-----",
    "",
    "## 要点",
    `- 要点（${ANCHOR}）`,
    "",
    "## 事实",
    "- 事实内容",
    "",
    "## 活动",
    "- 活动内容",
    "",
  ].join("\n");
}

function seedScenes(dir: string): void {
  const blocks = join(dir, "scene_blocks");
  mkdirSync(blocks, { recursive: true });
  writeFileSync(join(blocks, "场景-a.md"), sceneRaw("场景-a"), "utf-8");
  writeFileSync(join(blocks, "场景-b.md"), sceneRaw("场景-b"), "utf-8");
  writeFileSync(join(dir, "persona.md"), "用户画像正文。\n", "utf-8");
}

function makeRow() {
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
  };
}

function makeStore(rows: Array<Record<string, unknown>>) {
  return {
    isDegraded: () => false,
    queryL1Records: async () => rows,
  } as never;
}

describe("门禁 A：工厂 → 真实 extract → l2_merge metric", () => {
  it("persona.mergeScene=shadow 时真实 extract 触发 planned metric", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l2-merge-e2e-"));
    try {
      const scope = buildProfileIsolationScope({ teamId: "default", agentId: "default" });
      seedScenes(baseDir);
      seedScenes(join(baseDir, "profiles", encodeURIComponent(scope)));
      const lines: string[] = [];
      const runner = createL2Runner({
        pluginDataDir: baseDir,
        cfg: {
          persona: {
            maxScenes: 24,
            promptMode: "chat",
            sceneBackupCount: 3,
            sceneCharCap: 500_000,
            mergeScene: parseMergeSceneConfig({ mode: "shadow" }, 500_000),
          },
          llm: {},
        } as never,
        openclawConfig: undefined,
        vectorStore: makeStore([makeRow()]),
        logger: {
          debug: () => {},
          info: (m: string) => lines.push(m),
          warn: (m: string) => lines.push(m),
          error: () => {},
        } as never,
        llmRunner: { run: async () => "done" } as never,
      });
      await runner(SESSION_KEY).catch(() => {});
      const metrics = lines.filter((line) => line.includes("metric=l2_merge"));
      expect(metrics).toHaveLength(1);
      expect(metrics[0]).toContain("mode=shadow");
      expect(metrics[0]).toContain("result=planned");
      expect(metrics[0]).toContain("pair=场景-a.md + 场景-b.md");
      expect(metrics[0]).toContain("anchorsIn=");
      expect(metrics[0]).toContain("anchorsOut=");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
