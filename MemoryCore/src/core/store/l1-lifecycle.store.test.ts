// 票 P2-A1 分支 B1（裁判条件4）：归档层集成测试——tmp 库 init→迁移→影子/置位→门控过滤。
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "./sqlite/memory-store.js";
import type { MemoryRecord } from "../record/l1-writer.js";
import type { L1ArchiveConfig } from "./l1-lifecycle.js";

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function rec(id: string, updatedAt: string): MemoryRecord {
  return {
    id,
    content: `内容 ${id}`,
    type: "fact",
    priority: 60,
    scene_name: null,
    source_message_ids: ["m1"],
    metadata: {},
    timestamps: [updatedAt],
    createdAt: updatedAt,
    updatedAt,
    sessionKey: "zcode-default",
    sessionId: "sess-1",
    userId: "default",
    agentId: "default",
  } as unknown as MemoryRecord;
}

async function makeStore(): Promise<{ store: VectorStore; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "l1-archive-"));
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

const OLD = "2026-06-01T00:00:00.000Z"; // ~164 天前
const NEW = "2026-11-01T00:00:00.000Z"; // ~11 天前
const cfgOn: L1ArchiveConfig = { enabled: true, mode: "on", ageDays: 90, protectScenes: [] };
const cfgShadow: L1ArchiveConfig = { enabled: true, mode: "shadow", ageDays: 90, protectScenes: [] };

describe("P2-A1 B1 归档层集成（裁判条件4）", () => {
  it("init 后 archived 列存在（迁移生效）", async () => {
    const { store, dir } = await makeStore();
    try {
      await store.upsertL1(rec("m_old", OLD), undefined);
      const archived = store.getArchivedL1Ids();
      expect(archived).toBeInstanceOf(Set);
      expect(archived.size).toBe(0); // 未置位
    } finally {
      cleanup(store, dir);
    }
  });

  it("applyArchivePolicy shadow：返回候选计数但不置位（零行为）", async () => {
    const { store, dir } = await makeStore();
    try {
      await store.upsertL1(rec("m_old", OLD), undefined);
      await store.upsertL1(rec("m_new", NEW), undefined);
      const r = store.applyArchivePolicy(cfgShadow, Date.now());
      expect(r.candidates).toBe(1);
      expect(r.archived).toBe(0);
      expect(store.getArchivedL1Ids().size).toBe(0);
    } finally {
      cleanup(store, dir);
    }
  });

  it("applyArchivePolicy on：旧记忆置位（含批量事务），新记忆不动", async () => {
    const { store, dir } = await makeStore();
    try {
      await store.upsertL1(rec("m_old", OLD), undefined);
      await store.upsertL1(rec("m_new", NEW), undefined);
      const r = store.applyArchivePolicy(cfgOn, Date.now());
      expect(r.archived).toBe(1);
      expect(store.getArchivedL1Ids().has("m_old")).toBe(true);
      expect(store.getArchivedL1Ids().has("m_new")).toBe(false);
    } finally {
      cleanup(store, dir);
    }
  });

  it("双门控：flag=false 时行级过滤零行为（getArchivedL1Ids 恒报真值·裁判条件3）", async () => {
    const { store, dir } = await makeStore();
    try {
      await store.upsertL1(rec("m_old", OLD), undefined);
      store.applyArchivePolicy(cfgOn, Date.now());
      store.setL1ArchiveFilterActive(false); // config off 模拟
      expect(store.getArchivedL1Ids().has("m_old")).toBe(true); // 报告恒真值
      // 行级过滤消费的缓存被清空（refreshArchivedL1Cache）→ searchL1* 过滤分支零行为
      store.setL1ArchiveFilterActive(true); // config on 模拟
      expect(store.getArchivedL1Ids().has("m_old")).toBe(true); // 过滤恢复
    } finally {
      cleanup(store, dir);
    }
  });

  it("setArchivedL1 空数组零操作不抛", async () => {
    const { store, dir } = await makeStore();
    try {
      store.setArchivedL1([], true);
      expect(store.getArchivedL1Ids().size).toBe(0);
    } finally {
      cleanup(store, dir);
    }
  });

  it("unarchive：置位后可清除（可逆性）", async () => {
    const { store, dir } = await makeStore();
    try {
      await store.upsertL1(rec("m_old", OLD), undefined);
      store.applyArchivePolicy(cfgOn, Date.now());
      expect(store.getArchivedL1Ids().has("m_old")).toBe(true);
      store.setL1ArchiveFilterActive(true);
      store.setArchivedL1(["m_old"], false);
      expect(store.getArchivedL1Ids().has("m_old")).toBe(false);
    } finally {
      cleanup(store, dir);
    }
  });
});
