// P3（2026-10-24，指纹守卫修复审查遗留）：启动行数护栏告警。
// 挂账出处：2026-10-23 守卫修复审查「>2 万行护栏告警未做（ANALYZE 已消掉主要退化路径，P3）」。
// 契约：启动时 l1_records 行数 > 20000 则打一行 WARN（提示回填/ANALYZE 成本与后续规模），
// 仅告警不改变行为——回填与索引+ANALYZE 照常执行；≤ 20000 不打。
// 用临时库文件灌行触发（阈值 20000 来自实现常量，测试按行为钉住，不 import 常量）。
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VectorStore } from "./memory-store.js";

type RawDb = {
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    all: (a?: unknown[]) => unknown[];
    get: (a?: unknown[]) => Record<string, unknown> | undefined;
    run: (a?: unknown[]) => unknown;
  };
};

function internalDb(store: VectorStore): RawDb {
  return (store as unknown as { db: RawDb }).db;
}

function seedRows(store: VectorStore, n: number): void {
  const db = internalDb(store);
  db.exec("BEGIN");
  try {
    const ins = db.prepare("INSERT INTO l1_records (record_id, content) VALUES (?, ?)");
    // node:sqlite StatementSync.run 用位置参数（数组会被当作命名参数对象抛 ERR_INVALID_STATE）
    for (let i = 0; i < n; i++) ins.run(`r${i}`, `内容 ${i}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function makeLogger(warns: string[]) {
  return { info: () => {}, warn: (m: string) => warns.push(m), error: () => {}, debug: () => {} };
}

const WARN_HIT = (m: string) => m.includes("l1_records") && m.includes("20001");
const WARN_MISS = (m: string) => m.includes("l1_records") && m.includes("20000");

describe("启动行数护栏 WARN（backfillL1Fingerprints / 索引+ANALYZE 处）", () => {
  it(">20000 行 → 启动打一行护栏 WARN，且行为不变（回填仍执行、指纹照常补齐）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fp-warn-over-"));
    const dbPath = join(dir, "vectors.db");
    try {
      const s1 = new VectorStore(dbPath, 0);
      await s1.init();
      seedRows(s1, 20_001);
      s1.close();

      const warns: string[] = [];
      const s2 = new VectorStore(dbPath, 0, makeLogger(warns));
      await s2.init();
      try {
        expect(warns.filter(WARN_HIT)).toHaveLength(1);
        // 不改变行为：直插行指纹为 NULL，本次启动回填后必须全部补齐
        const db = internalDb(s2);
        const nulls = db.prepare("SELECT COUNT(*) AS c FROM l1_records WHERE content_fingerprint IS NULL").get() as { c: number };
        expect(nulls.c).toBe(0);
      } finally {
        s2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("≤20000 行 → 不打护栏 WARN", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fp-warn-under-"));
    const dbPath = join(dir, "vectors.db");
    try {
      const s1 = new VectorStore(dbPath, 0);
      await s1.init();
      seedRows(s1, 5);
      s1.close();

      const warns: string[] = [];
      const s2 = new VectorStore(dbPath, 0, makeLogger(warns));
      await s2.init();
      try {
        expect(warns.filter(WARN_MISS)).toHaveLength(0);
      } finally {
        s2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
