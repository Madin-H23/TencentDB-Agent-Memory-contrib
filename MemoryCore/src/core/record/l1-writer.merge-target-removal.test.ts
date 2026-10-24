// 票15（2026-10-24）：merge/update 目标删除的跨会话回归钉。
// 缺陷（票12 污染审计发现）：writeMemory 的 deleteFilter 含 sessionId/sessionKey，
// 而 dedup 候选召回刻意跨会话（P2-④ 并行安全）——读跨会话、删不跨会话，
// 跨会话合并半生效：合并版入库、目标旧版残留（生产实证 48 目标 29 存活）。
// 修复：deleteFilter 收窄到租户维度（teamId/userId/agentId），与读边界对齐。
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VectorStore } from "../store/sqlite/memory-store.js";
import { writeMemory } from "./l1-writer.js";
import type { ExtractedMemory, MemoryRecord } from "./l1-writer.js";
import type { DedupDecision } from "./l1-dedup.js";
import type { IMemoryStore } from "../store/types.js";
import type { Logger } from "../types.js";

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function rec(id: string, content: string, sessionId: string): MemoryRecord {
  return {
    id,
    content,
    type: "instruction",
    priority: 80,
    scene_name: "署名规范",
    source_message_ids: ["m1"],
    metadata: {},
    timestamps: ["2026-10-24T00:00:00.000Z"],
    createdAt: "2026-10-24T00:00:00.000Z",
    updatedAt: "2026-10-24T00:00:00.000Z",
    sessionKey: "zcode-default",
    sessionId,
    userId: "default",
    agentId: "default",
  } as MemoryRecord;
}

const TARGET = rec(
  "m_target_1",
  "用户要求公开提交署名使用 Weijian He；全局身份绝不进公开提交。",
  "sess-old",
);

async function makeStore(): Promise<{ store: VectorStore; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "merge-removal-"));
  const store = new VectorStore(join(dir, "vectors.db"), 0);
  await store.init();
  return { store, dir };
}

function cleanup(store: VectorStore, dir: string) {
  try {
    store.close();
  } catch {
    /* ignore */
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe("票15: merge 目标删除跨会话生效（半生效缺陷回归钉）", () => {
  it("跨会话目标（同租户）在 merge 后被真实删除", async () => {
    const { store, dir } = await makeStore();
    try {
      await store.upsertL1(TARGET);
      expect((await store.getAllL1Texts()).some((r) => r.record_id === "m_target_1")).toBe(true);

      const memory: ExtractedMemory = {
        content: "用户要求公开提交署名使用 Weijian He（含 email）；全局身份绝不进公开提交。",
        type: "instruction",
        priority: 80,
        source_message_ids: ["m2"],
        metadata: {},
        scene_name: "署名规范",
      };
      const decision: DedupDecision = {
        record_id: "m_writer_1",
        action: "merge",
        target_ids: ["m_target_1"],
      };
      // 写入方在新会话 sess-new；目标在 sess-old（同租户 user/agent=default）
      await writeMemory({
        memory,
        decision,
        baseDir: dir,
        sessionKey: "zcode-default",
        sessionId: "sess-new",
        userId: "default",
        agentId: "default",
        logger,
        vectorStore: store,
        storage: undefined,
      });

      const after = await store.getAllL1Texts();
      expect(after.some((r) => r.record_id === "m_target_1")).toBe(false);
      expect(after.some((r) => r.record_id === "m_writer_1")).toBe(true);
    } finally {
      cleanup(store, dir);
    }
  });

  it("deleteFilter 只含租户三维（不含 sessionId/sessionKey）", async () => {
    const captured: Array<{ ids: string[]; filter: unknown }> = [];
    const mockStore = {
      queryL1Records: async () => [],
      deleteL1Batch: async (ids: string[], filter?: unknown) => {
        captured.push({ ids, filter });
        return true;
      },
      upsertL1: async () => true,
    } as unknown as IMemoryStore;

    const memory: ExtractedMemory = {
      content: "合并后的内容",
      type: "instruction",
      priority: 80,
      source_message_ids: ["m2"],
      metadata: {},
      scene_name: "署名规范",
    };
    const decision: DedupDecision = {
      record_id: "m_writer_2",
      action: "merge",
      target_ids: ["m_t1", "m_t2"],
    };
    await writeMemory({
      memory,
      decision,
      baseDir: mkdtempSync(join(tmpdir(), "merge-removal-mock-")),
      sessionKey: "k1",
      sessionId: "sess-B",
      teamId: "team-x",
      userId: "u1",
      agentId: "a1",
      logger,
      vectorStore: mockStore,
      storage: undefined,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].ids).toEqual(["m_t1", "m_t2"]);
    expect(captured[0].filter).toEqual({ teamId: "team-x", userId: "u1", agentId: "a1" });
    expect(captured[0].filter).not.toHaveProperty("sessionId");
    expect(captured[0].filter).not.toHaveProperty("sessionKey");
  });
});
