// L1 FTS 排序：IDF 覆盖度优先（2026-09-25 用户模拟实测驱动）
//
// 现场问题：query 被 OR 拼成 `"a" OR "b"`，BM25 单独排序。一篇**短**的、只命中
// 高频词（如"哪些"）的记忆，会压过一篇**长**的、真正命中稀有词（如"commit"）的记忆——
// 实测生产库 1643 条下查询「commit 有哪些规矩」，首位命中的是「检查哪些网页尚未迁移」，
// 而 commit 约定那条根本没进前列。scoreThreshold 0.3 在此处完全无效（生产库分数常年
// 0.85~0.90，从未触发），所以问题不在阈值，在排序口径。
//
// 改法：主排序键改为「命中的查询词 IDF 加权和」，BM25 降为同分时的次序键。
// 词权重用 BM25 同款 IDF：w = ln((N - df + 0.5)/(df + 0.5) + 1)，df 越大权重越低；
// 全词权重为 0（都是超高频词）时退化为原 BM25 序，不改变既有行为。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore, buildFtsQuery, rankByTokenCoverage } from "./sqlite.js";
import type { MemoryRecord } from "./types.js";

let dir: string;
let store: VectorStore;

function mem(id: string, content: string): MemoryRecord {
  return {
    id,
    content,
    type: "episodic",
    priority: 70,
    scene_name: "测试场景",
    source_message_ids: [],
    metadata: {},
    timestamps: [],
    createdAt: new Date(1_700_000_000_000).toISOString(),
    updatedAt: new Date(1_700_000_000_000).toISOString(),
    version: 0,
    sessionKey: "rank-test",
    sessionId: "default",
    userId: "default",
    agentId: "default",
  } as unknown as MemoryRecord;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tdai-rank-"));
  store = new VectorStore(join(dir, "vectors.db"), 4);
  store.init();
});
afterEach(() => {
  try {
    store.close();
  } catch {
    /* 已关闭 */
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("rankByTokenCoverage 纯函数", () => {
  it("命中稀有词的文档排到只命中高频词的文档之前（即便后者 BM25 更好）", () => {
    const rows = [
      { record_id: "common", rank: -3.0 }, // BM25 更强，但只命中高频词
      { record_id: "rare", rank: -1.0 }, // BM25 较弱，但命中稀有词
    ];
    const hits = new Map<string, Set<string>>([
      ["哪些", new Set(["common", "rare", "x", "y", "z"])], // df=5/5 → IDF≈0
      ["commit", new Set(["rare"])], // df=1/5 → 高 IDF
    ]);
    const out = rankByTokenCoverage(rows, hits, 5);
    expect(out.map((r) => r.record_id)).toEqual(["rare", "common"]);
  });

  it("所有词都是超高频词（全零权重）→ 保持原 BM25 序，不改变既有行为", () => {
    const rows = [
      { record_id: "a", rank: -1.0 },
      { record_id: "b", rank: -2.0 },
    ];
    const hits = new Map<string, Set<string>>([
      ["用户", new Set(["a", "b"])],
      ["项目", new Set(["a", "b"])],
    ]);
    expect(rankByTokenCoverage(rows, hits, 2).map((r) => r.record_id)).toEqual(["a", "b"]);
  });

  it("命中的稀有词更多的文档优先（覆盖度优先于单个词的权重高低）", () => {
    const rows = [
      { record_id: "one", rank: -2.0 },
      { record_id: "two", rank: -2.0 },
    ];
    const hits = new Map<string, Set<string>>([
      ["commit", new Set(["one", "two"])], // df=2 → 中等权重
      ["中文", new Set(["two"])], // df=1 → 高权重
      ["署名", new Set(["two"])], // df=1 → 高权重
    ]);
    // one 只命中 commit，two 命中三个词 → two 的 IDF 加权和更高
    expect(rankByTokenCoverage(rows, hits, 10).map((r) => r.record_id)).toEqual(["two", "one"]);
  });

  it("权重和相等时保持原 BM25 序（稳定，不做无谓抖动）", () => {
    const rows = [
      { record_id: "one", rank: -2.0 },
      { record_id: "two", rank: -2.0 },
    ];
    const hits = new Map<string, Set<string>>([
      ["commit", new Set(["one", "two"])], // 两者都命中
      ["中文", new Set(["one"])], // 仅 one
      ["署名", new Set(["two"])], // 仅 two
    ]);
    // one/two 的权重和完全相等 → 应按传入（BM25）序返回 one, two
    expect(rankByTokenCoverage(rows, hits, 10).map((r) => r.record_id)).toEqual(["one", "two"]);
  });

  it("回归：单点意外命中的超稀有词不得压过命中两个词的文档（2026-09-25 实测现场）", () => {
    // 现场：「ZCode 怎么备份」中「怎么」全库只出现 1 次（某条"管怎么写好"的记忆里），
    // IDF 权重 7.00，压过真正相关的 ZCode(1.81)+备份(2.99)=4.81，导致首位返回写作偏好。
    const rows = [
      { record_id: "writing-pref", rank: -3.0 }, // 只命中「怎么」
      { record_id: "backup", rank: -1.0 }, // 命中 ZCode + 备份
    ];
    const hits = new Map<string, Set<string>>([
      ["怎么", new Set(["writing-pref"])], // df=1 → 权重最高
      ["ZCode", new Set(["backup", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z"])],
      ["备份", new Set(["backup", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m"])],
    ]);
    // 覆盖度优先：backup 命中 2 个词，writing-pref 只命中 1 个 → backup 必须在前
    expect(rankByTokenCoverage(rows, hits, 26).map((r) => r.record_id)).toEqual(["backup", "writing-pref"]);
  });

  it("空 token 集 → 原样返回（不炸、不重排）", () => {
    const rows = [{ record_id: "a", rank: -1 }];
    expect(rankByTokenCoverage(rows, new Map(), 10)).toEqual(rows);
  });
});

describe("searchL1Fts：IDF 覆盖度排序接入（端到端）", () => {
  it("查询含稀有词时，真正命中该词的记忆排到前列", () => {
    // 造语料：5 条记忆都含「哪些」，只有 1 条含「commit」
    for (let i = 0; i < 5; i++) {
      store.upsertL1(mem(`m${i}`, `用户在 2026-09-0${i + 1} 要求检查哪些网页尚未迁移，并继续推进页面迁移第 ${i} 项`), undefined);
    }
    store.upsertL1(mem("commit-rule", "用户要求所有项目的 commit 一律使用中文标题与正文，署名 heweijian，不得出现内部归因"), undefined);

    const q = buildFtsQuery("commit 有哪些规矩")!;
    const hits = store.searchL1Fts(q, 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].record_id).toBe("commit-rule");
  });

  it("单 token 查询不受影响（无排序可做，退化为 BM25）", () => {
    store.upsertL1(mem("a", "青鸟项目审计表采用 PostgreSQL 分区表"), undefined);
    store.upsertL1(mem("b", "青鸟项目审批列表空白问题已修复"), undefined);
    const hits = store.searchL1Fts(buildFtsQuery("青鸟")!, 5);
    expect(hits.map((h) => h.record_id).sort()).toEqual(["a", "b"]);
  });

  it("buildFtsQuery 对全是停用词的查询返回 null（不触发无意义检索）", () => {
    expect(buildFtsQuery("的了是在和")).toBeNull();
  });
});
