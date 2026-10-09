// 跨 sid 去重保真（L0 多线程串线治理，2026-10-09 拍板选项1 同批项）：
// batchDedup 的 conflict recall filter 原样含 sessionId——hook 转发真实 sid 后
// 各线程只在「自己的桶」里查重，两线程产出同一事实会双入库（审核 R4）。
// 语义基线：改造前所有行同落 default 桶、filter 为空（全库查重）；
// 修正后 filter 必须去掉 sessionId 维度（保留 team/user/agent/task），精确保持
// 改造前语义。用 vi.mock 拦截 batchDedup 断言 filter 形状。
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const captured: Array<{ filter?: Record<string, unknown> }> = [];

vi.mock("./l1-dedup.js", () => ({
  batchDedup: async (params: { filter?: Record<string, unknown>; memories: Array<{ record_id: string }> }) => {
    captured.push({ filter: params.filter });
    return params.memories.map((m) => ({ record_id: m.record_id, action: "store" as const, target_ids: [] }));
  },
}));

import { extractL1Memories } from "./l1-extractor.js";
import type { LLMRunner } from "../core/types.js";

const T = 1_700_000_000_000;

const MESSAGES = [
  { id: "m1", role: "user" as const, content: "跨线程去重验证：两线程产出同一事实应只入库一次的语义基线检查消息。", timestamp: T },
];

const RESPONSE = JSON.stringify([
  { scene_name: "去重语义验证场景", message_ids: ["m1"], memories: [{ type: "episodic", content: "去重验证事实内容", priority: 50 }] },
]);

describe("batchDedup filter 不含 sessionId（跨 sid 去重保真）", () => {
  it("userId/agentId/taskId 在场、sessionId 不在 filter 里", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "dedup-filter-test-"));
    try {
      captured.length = 0;
      const llm = { run: async () => RESPONSE } as unknown as LLMRunner;
      await extractL1Memories({
        messages: MESSAGES,
        sessionKey: "zcode-default",
        sessionId: "sess-should-not-leak",
        taskId: "task-1",
        userId: "u1",
        agentId: "ag1",
        baseDir,
        config: {},
        options: { enableDedup: true, promptMode: "chat", llmRunner: llm },
      });
      expect(captured.length).toBe(1);
      const filter = captured[0]!.filter;
      expect(filter).toBeDefined();
      expect(filter).toMatchObject({ teamId: undefined, userId: "u1", agentId: "ag1", taskId: "task-1" });
      expect(filter).not.toHaveProperty("sessionId", "sess-should-not-leak");
      expect(filter).not.toHaveProperty("sessionId");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("仅 sessionId 在场（team/user/agent/task 全空）→ 不传 filter（=改造前全库查重语义）", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "dedup-filter-test2-"));
    try {
      captured.length = 0;
      const llm = { run: async () => RESPONSE } as unknown as LLMRunner;
      await extractL1Memories({
        messages: MESSAGES,
        sessionKey: "zcode-default",
        sessionId: "sess-only",
        baseDir,
        config: {},
        options: { enableDedup: true, promptMode: "chat", llmRunner: llm },
      });
      expect(captured.length).toBe(1);
      expect(captured[0]!.filter).toBeUndefined();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
