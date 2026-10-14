// P2（2026-10-14，v2 e601281 移植）：L0 (user_id, agent_id, timestamp) 复合驱动索引。
// queryL0Paginated 的 WHERE user_id+agent_id + ORDER BY timestamp DESC LIMIT/OFFSET
// 在无此索引时只能靠 idx_l0_timestamp 全索引扫描 + 隔离过滤回表。
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "./memory-store.js";

describe("sqlite schema：L0 复合驱动索引", () => {
  it("initSchema 后 idx_l0_user_agent_ts 存在且列序为 (user_id, agent_id, timestamp)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "l0idx-"));
    const store = new VectorStore(join(dir, "vectors.db"), 0);
    try {
      await store.init();
      const db = (store as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } }).db;
      const idx = db
        .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_l0_user_agent_ts'")
        .all() as Array<{ name: string; sql: string }>;
      expect(idx).toHaveLength(1);
      expect(idx[0]!.sql ?? "").toContain("user_id");
      expect(idx[0]!.sql ?? "").toContain("agent_id");
      expect(idx[0]!.sql ?? "").toContain("timestamp");

      // 查询计划：user+agent 等值 + timestamp 排序应命中该索引
      const plan = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT record_id FROM l0_conversations WHERE user_id='u' AND agent_id='a' ORDER BY timestamp DESC LIMIT 20",
        )
        .all() as Array<{ detail: string }>;
      const detail = plan.map((p) => p.detail).join(" | ");
      expect(detail).toContain("idx_l0_user_agent_ts");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
