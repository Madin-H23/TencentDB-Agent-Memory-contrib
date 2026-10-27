// 票（2026-10-27）：合并/删除路径补写 memory_audit 的回归钉。
// 背景：memory_audit 此前只由 v2-router / chat-memory-handlers（外部请求侧）写入，
// 管线内部 L1 merge/update（删目标 + 写合并版）从不落审计——2026-10-27 巡检实证
// 当日 27 次 merge 决策在 memory_audit 里零对应行，事后只能靠日志锚点回溯。
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

function rec(id: string, content: string, sessionId: string, version = 0): MemoryRecord {
  return {
    id,
    content,
    type: "instruction",
    priority: 80,
    scene_name: "署名规范",
    source_message_ids: ["m1"],
    metadata: {},
    timestamps: ["2026-10-27T00:00:00.000Z"],
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
    version,
    sessionKey: "zcode-default",
    sessionId,
    userId: "default",
    agentId: "default",
  } as MemoryRecord;
}

async function makeStore(): Promise<{ store: VectorStore; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "l1-writer-audit-"));
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

const MEMORY: ExtractedMemory = {
  content: "用户要求公开提交署名使用 Weijian He。",
  type: "instruction",
  priority: 80,
  source_message_ids: ["m2"],
  metadata: {},
  scene_name: "署名规范",
};

describe("合并/删除路径写审计（2026-10-27）", () => {
  it("merge：为每个被删目标写 delete、为新合并版写 update，且共享同一 request_id", async () => {
    const { store, dir } = await makeStore();
    try {
      await store.upsertL1(rec("m_t1", "旧事实一", "sess-a", 2));
      await store.upsertL1(rec("m_t2", "旧事实二", "sess-b", 5));

      const decision: DedupDecision = {
        record_id: "m_new",
        action: "merge",
        target_ids: ["m_t1", "m_t2"],
        merged_content: "用户要求公开提交署名使用 Weijian He（合并版）。",
      };
      const out = await writeMemory({
        memory: MEMORY,
        decision,
        baseDir: dir,
        sessionKey: "zcode-default",
        sessionId: "sess-new",
        teamId: "team-1",
        userId: "user-1",
        agentId: "agent-1",
        taskId: "task-1",
        logger,
        vectorStore: store,
      });
      expect(out?.id).toBe("m_new");

      const audits = await store.queryAudit({ layer: "L1", limit: 10 });
      const deletes = audits.filter((a) => a.action === "delete");
      const updates = audits.filter((a) => a.action === "update");
      expect(deletes.map((a) => a.record_id).sort()).toEqual(["m_t1", "m_t2"]);
      // 删除行的 version 取其真实旧版本
      expect(deletes.find((a) => a.record_id === "m_t1")?.version).toBe(2);
      expect(deletes.find((a) => a.record_id === "m_t2")?.version).toBe(5);
      // 新合并版为 update，版本 = max(旧)+1
      expect(updates).toHaveLength(1);
      expect(updates[0].record_id).toBe("m_new");
      expect(updates[0].version).toBe(6);
      // 同一次合并共享 request_id，便于串联
      const reqIds = new Set(audits.map((a) => a.request_id));
      expect(reqIds.size).toBe(1);
      // 租户三维透传
      expect(updates[0].team_id).toBe("team-1");
      expect(updates[0].user_id).toBe("user-1");
      expect(updates[0].agent_id).toBe("agent-1");
      expect(updates[0].task_id).toBe("task-1");
    } finally {
      cleanup(store, dir);
    }
  });

  it("update：同样写 delete + update", async () => {
    const { store, dir } = await makeStore();
    try {
      await store.upsertL1(rec("m_old", "旧事实", "sess-a", 1));
      const decision: DedupDecision = {
        record_id: "m_upd",
        action: "update",
        target_ids: ["m_old"],
        merged_content: "更新后的事实。",
      };
      await writeMemory({
        memory: MEMORY,
        decision,
        baseDir: dir,
        sessionKey: "zcode-default",
        logger,
        vectorStore: store,
      });
      const audits = await store.queryAudit({ layer: "L1", limit: 10 });
      expect(audits.filter((a) => a.action === "delete").map((a) => a.record_id)).toEqual(["m_old"]);
      expect(audits.filter((a) => a.action === "update").map((a) => a.record_id)).toEqual(["m_upd"]);
    } finally {
      cleanup(store, dir);
    }
  });

  it("store：新增不写审计（审计语义只覆盖 update/delete）", async () => {
    const { store, dir } = await makeStore();
    try {
      const decision: DedupDecision = { record_id: "m_store", action: "store", target_ids: [] };
      await writeMemory({
        memory: MEMORY,
        decision,
        baseDir: dir,
        sessionKey: "zcode-default",
        logger,
        vectorStore: store,
      });
      const audits = await store.queryAudit({ layer: "L1", limit: 10 });
      expect(audits).toHaveLength(0);
    } finally {
      cleanup(store, dir);
    }
  });

  it("审计写入抛错不阻塞主流程（与 v2-router recordAudit 语义一致）", async () => {
    const { store, dir } = await makeStore();
    try {
      await store.upsertL1(rec("m_t1", "旧事实", "sess-a", 1));
      const failing: IMemoryStore = Object.create(store) as IMemoryStore;
      failing.appendAudit = () => {
        throw new Error("audit boom");
      };
      const decision: DedupDecision = {
        record_id: "m_new",
        action: "merge",
        target_ids: ["m_t1"],
        merged_content: "合并版。",
      };
      const out = await writeMemory({
        memory: MEMORY,
        decision,
        baseDir: dir,
        sessionKey: "zcode-default",
        logger,
        vectorStore: failing,
      });
      expect(out?.id).toBe("m_new");
      // 主流程写入成功
      const rows = await store.getAllL1Texts();
      expect(rows.some((r) => r.record_id === "m_new")).toBe(true);
    } finally {
      cleanup(store, dir);
    }
  });
});
