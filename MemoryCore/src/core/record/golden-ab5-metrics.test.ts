/**
 * 票 02（2026-10-24 金标 5 候选复测）单测：5 候选 A/B 度量纯函数 + mock 忠实性 + 防漂移保真。
 *
 * 覆盖（票面验收）：
 * - 孪生生存复算：none 截断丢孪生 / lexical 捞回 / 同分保序；边界（池长 49、
 *   fetch=6 截断、孪生恰在第 6 名 / 第 7 名）。
 * - M1 分解分层（召回截断损失 vs 判定层失败）+ 四指标（error 不进分母）+
 *   预注册三条件判定（口径逐字沿用 scripts/golden-ab.ts）。
 * - 断点续跑跳过逻辑（resumeSkip / resumeKey）。
 * - mock 忠实性：两臂 topK 调用序列与生产 findCandidates 一致（可数假池验证）。
 * - 防漂移保真（本票关键）：stub llmRunner 捕获 batchDedup 实际发出的 userPrompt，
 *   断言孪生 id 在 prompt 中的出现/不出现与 finalPoolFor 的计算一致——
 *   mock 与生产链路一旦漂移立即红（none/lexical 各至少 1 例）。
 * 样本全部合成内容，零真实 PII（与票 01 测试同约定）。
 */
import { describe, it, expect } from "vitest";

import {
  finalPoolFor,
  build5CandMockStore,
  buildAb5Context,
  twinSurvival,
  m1Decomposition,
  stratify,
  stratumOf,
  abMetrics,
  preregConditions,
  isDegraded,
  resumeKey,
  resumeSkip,
  type Ab5Row,
} from "./golden-ab5-metrics.js";
import { validateGolden5CandPair, type Golden5CandPair, type Golden5CandPoolRow } from "./golden-5cand.js";
import type { GoldenPair } from "./golden-fixture.js";
import { batchDedup } from "./l1-dedup.js";
import type { LLMRunner } from "../types.js";

// ── 合成样本构造（零真实 PII）──────────────────────────────────────────

/** 池行：与 searchL1Fts 返回同形状（L1SearchResult 字段面）。 */
function poolRow(recordId: string, content: string, score = 0.5): Golden5CandPoolRow {
  return {
    record_id: recordId,
    content,
    type: "work_fact",
    priority: 80,
    scene_name: "测试场景",
    score,
    timestamp_str: "2026-10-24T00:00:00.000Z",
    timestamp_start: "",
    timestamp_end: "",
    version: 0,
    session_key: "",
    session_id: "",
    team_id: "",
    task_id: "",
    user_id: "",
    agent_id: "",
    metadata_json: "{}",
  };
}

/** 与查询无关的填充行内容（彼此各异，4-gram 重叠趋零）。 */
function fillerContent(i: number): string {
  return `填充行${i}：与查询主题完全无关的占位内容块编号${(i * 7919) % 1000}`;
}

/** 态①：db 池内，孪生恰在 twinRank 位（保持 pool[twinRank-1].record_id===twinId 自洽）。 */
function dbPair(pid: string, pool: Golden5CandPoolRow[], twinRank: number, twinId: string): Golden5CandPair {
  return { pid, twin_id: twinId, twin_source: "db", twin_rank: twinRank, twin_beyond_recall: false, pool };
}

/** 态②：db 超召回（孪生不在池、无名次）。 */
function beyondPair(pid: string, pool: Golden5CandPoolRow[], twinId: string): Golden5CandPair {
  return { pid, twin_id: twinId, twin_source: "db", twin_rank: null, twin_beyond_recall: true, pool };
}

/** 态③：注入落位。 */
function injectedPair(pid: string, pool: Golden5CandPoolRow[], twinRank: number, twinId: string): Golden5CandPair {
  return { pid, twin_id: twinId, twin_source: "injected", twin_rank: twinRank, twin_beyond_recall: false, pool };
}

/** 金标对（合成内容）。 */
function goldPair(pid: string, over: Partial<GoldenPair> = {}): GoldenPair {
  return {
    pid,
    band: "exact",
    subset: "high-sim",
    sim: 0.95,
    rank_older: 3,
    rank_bucket: "top-5",
    type_older: "work_fact",
    type_newer: "work_fact",
    content_older: `旧记忆-${pid}`,
    content_newer: `新记忆-${pid}`,
    answer_user: "merge",
    ...over,
  };
}

/** 结果行快捷构造（harness JSONL 行形状）。 */
function row(pid: string, mode: string, over: Partial<Ab5Row> = {}): Ab5Row {
  return {
    pid,
    mode,
    golden: "merge",
    action: "store",
    sim: 0.9,
    band: "exact",
    twin_source: "db",
    twin_rank: 2,
    ...over,
  };
}

// ── finalPoolFor：两臂池选择（复刻生产 findCandidates）──────────────────

describe("finalPoolFor", () => {
  const newer = "金标复测查询内容：把 harness 的临时产物统一放在固定目录下便于清理";
  // 10 行假池：孪生在第 7 名（内容与查询一致 → lexical 必捞回），其余为无关填充
  const twinContent = newer;
  const pool: Golden5CandPoolRow[] = [
    ...Array.from({ length: 6 }, (_, i) => poolRow(`filler_${i + 1}`, fillerContent(i + 1))),
    poolRow("twin_row", twinContent, 0.9),
    ...Array.from({ length: 3 }, (_, i) => poolRow(`filler_${i + 7}`, fillerContent(i + 7))),
  ];
  const pair = dbPair("gT", pool, 7, "twin_row");

  it("helper 自身通过票 01 校验（保证测试样本自洽）", () => {
    expect(() => validateGolden5CandPair(pair)).not.toThrow();
  });

  it("none 臂：fetch=topK+1=6 截断，孪生在第 7 名不入池", () => {
    const r = finalPoolFor(pair, "none", 5, { queryContent: newer });
    expect(r.pool.map((x) => x.record_id)).toEqual(["filler_1", "filler_2", "filler_3", "filler_4", "filler_5"]);
    expect(r.twinInPool).toBe(false);
    expect(r.twinFinalRank).toBeNull();
  });

  it("none 臂边界：孪生恰在第 6 名——被 fetch 但被 slice 丢弃", () => {
    const pool6 = [
      ...Array.from({ length: 5 }, (_, i) => poolRow(`filler_${i + 1}`, fillerContent(i + 1))),
      poolRow("twin_row", twinContent, 0.9),
      poolRow("filler_6", fillerContent(6)),
    ];
    const r = finalPoolFor(dbPair("gB6", pool6, 6, "twin_row"), "none", 5, { queryContent: newer });
    expect(r.pool).toHaveLength(5);
    expect(r.pool.map((x) => x.record_id)).not.toContain("twin_row");
    expect(r.twinInPool).toBe(false);
  });

  it("none 臂：孪生在第 5 名入池且最终名次不变", () => {
    const pool5 = [
      poolRow("f1", fillerContent(1)),
      poolRow("f2", fillerContent(2)),
      poolRow("f3", fillerContent(3)),
      poolRow("f4", fillerContent(4)),
      poolRow("twin_row", twinContent, 0.9),
      poolRow("f5", fillerContent(5)),
    ];
    const r = finalPoolFor(dbPair("gT5", pool5, 5, "twin_row"), "none", 5, { queryContent: newer });
    expect(r.twinInPool).toBe(true);
    expect(r.twinFinalRank).toBe(5);
    expect(r.pool[4]!.record_id).toBe("twin_row");
  });

  it("lexical 臂：fetch=50 后生产重排把孪生（与查询同文）捞回第 1 名", () => {
    const r = finalPoolFor(pair, "lexical", 5, { queryContent: newer });
    expect(r.twinInPool).toBe(true);
    expect(r.twinFinalRank).toBe(1);
    expect(r.pool[0]!.record_id).toBe("twin_row");
    expect(r.pool).toHaveLength(5);
  });

  it("lexical 臂同分保序：全部候选与查询同文 → 保持召回原序取前 5", () => {
    const same = "完全相同的内容行用于验证同分保序";
    const p: Golden5CandPoolRow[] = Array.from({ length: 8 }, (_, i) => poolRow(`s_${i + 1}`, same));
    // 孪生在第 7 名：同分下原序优先，前 5 名全是 1-5 号行 → 孪生不入池
    const r = finalPoolFor(dbPair("gSame", p, 7, "s_7"), "lexical", 5, { queryContent: same });
    expect(r.pool.map((x) => x.record_id)).toEqual(["s_1", "s_2", "s_3", "s_4", "s_5"]);
    expect(r.twinInPool).toBe(false);
  });

  it("边界：池长 49（lexical fetch=50 不越界、none 仍截 6 取 5）", () => {
    const big: Golden5CandPoolRow[] = [
      ...Array.from({ length: 6 }, (_, i) => poolRow(`filler_${i + 1}`, fillerContent(i + 1))),
      poolRow("twin_row", twinContent, 0.9),
      ...Array.from({ length: 42 }, (_, i) => poolRow(`filler_${i + 7}`, fillerContent(i + 7))),
    ];
    expect(big).toHaveLength(49);
    const p49 = dbPair("g49", big, 7, "twin_row");
    const none = finalPoolFor(p49, "none", 5, { queryContent: newer });
    expect(none.pool).toHaveLength(5);
    expect(none.twinInPool).toBe(false);
    const lex = finalPoolFor(p49, "lexical", 5, { queryContent: newer });
    expect(lex.pool).toHaveLength(5);
    expect(lex.twinInPool).toBe(true); // 49 行全量喂给生产重排，孪生同文捞回
  });

  it("self 过滤：selfIds 命中的行在截断/重排前剔除", () => {
    const r = finalPoolFor(pair, "none", 5, { queryContent: newer, selfIds: new Set(["filler_1"]) });
    // fetch 6 → 剔除 filler_1 剩 5 → slice(0,5) = filler_2..filler_6
    expect(r.pool.map((x) => x.record_id)).toEqual(["filler_2", "filler_3", "filler_4", "filler_5", "filler_6"]);
  });

  it("beyond_recall 对：两臂都取不到孪生（召回缺失地板）", () => {
    const p = beyondPair("gBeyond", pool.slice(0, 10).filter((x) => x.record_id !== "twin_row"), "twin_row");
    expect(finalPoolFor(p, "none", 5, { queryContent: newer }).twinInPool).toBe(false);
    expect(finalPoolFor(p, "lexical", 5, { queryContent: newer }).twinInPool).toBe(false);
  });

  it("lexical 缺 queryContent → 显式抛错（不允许静默错排）", () => {
    expect(() => finalPoolFor(pair, "lexical", 5)).toThrow(/queryContent/);
  });

  it("非法 mode → 显式抛错", () => {
    // @ts-expect-error 故意传非法值验证运行时防护
    expect(() => finalPoolFor(pair, "bogus", 5)).toThrow(/mode/);
  });
});

// ── build5CandMockStore：mock 忠实性（可数假池验证调用序列）─────────────

describe("build5CandMockStore", () => {
  const newer = "金标复测 mock 忠实性查询内容";
  const pool: Golden5CandPoolRow[] = [
    ...Array.from({ length: 6 }, (_, i) => poolRow(`filler_${i + 1}`, fillerContent(i + 1))),
    poolRow("twin_row", newer, 0.9),
    ...Array.from({ length: 3 }, (_, i) => poolRow(`filler_${i + 7}`, fillerContent(i + 7))),
  ];
  const pair = dbPair("gM", pool, 7, "twin_row");

  it("none 臂调用序列：searchL1Fts 恰调 1 次、topK=6（=topK 5 + memories.length 1）", async () => {
    const { store, ftsCalls } = build5CandMockStore(pair);
    const runner: LLMRunner = { run: async () => "[]" };
    await batchDedup({
      memories: [{ record_id: `ab_${pair.pid}`, content: newer, type: "work_fact" as never, priority: 80, source_message_ids: [], metadata: {}, scene_name: "" }],
      config: {},
      llmRunner: runner,
      vectorStore: store,
      dedupFailFast: true,
      dedupRecallRerank: "none",
      timeoutMs: 240_000,
    });
    expect(ftsCalls).toHaveLength(1);
    expect(ftsCalls[0]!.topK).toBe(6);
    expect(ftsCalls[0]!.query.length).toBeGreaterThan(0); // 生产 buildFtsQuery 产物非空
  });

  it("lexical 臂调用序列：topK=50（=max(topK*10,50)）", async () => {
    const { store, ftsCalls } = build5CandMockStore(pair);
    const runner: LLMRunner = { run: async () => "[]" };
    await batchDedup({
      memories: [{ record_id: `ab_${pair.pid}`, content: newer, type: "work_fact" as never, priority: 80, source_message_ids: [], metadata: {}, scene_name: "" }],
      config: {},
      llmRunner: runner,
      vectorStore: store,
      dedupFailFast: true,
      dedupRecallRerank: "lexical",
      timeoutMs: 240_000,
    });
    expect(ftsCalls).toHaveLength(1);
    expect(ftsCalls[0]!.topK).toBe(50);
  });

  it("mock 面：countL1=池长、isFtsAvailable=true、按 topK 截断返回", async () => {
    const { store } = build5CandMockStore(pair);
    await expect(store.countL1()).resolves.toBe(10);
    expect(store.isFtsAvailable()).toBe(true);
    // searchL1Fts 未在 build5CandMockStore 之外被记录——直接经 ftsCalls 间接验证
    const { store: s2, ftsCalls } = build5CandMockStore(pair);
    const hits = await s2.searchL1Fts("q", 6);
    expect(hits).toHaveLength(6);
    expect(ftsCalls[0]!.topK).toBe(6);
  });
});

// ── 防漂移保真（本票关键）：prompt 中孪生 id 出现性与 finalPoolFor 一致 ──

describe("防漂移保真：batchDedup 实发 prompt × finalPoolFor", () => {
  const newer = "金标复测防漂移查询内容：把 harness 的临时产物统一放在固定目录下便于清理";
  const pool: Golden5CandPoolRow[] = [
    ...Array.from({ length: 6 }, (_, i) => poolRow(`filler_${i + 1}`, fillerContent(i + 1))),
    poolRow("twin_row", newer, 0.9), // 孪生 db 名次第 7，内容与查询同文
    ...Array.from({ length: 3 }, (_, i) => poolRow(`filler_${i + 7}`, fillerContent(i + 7))),
  ];
  const pair = dbPair("gD", pool, 7, "twin_row");

  function stubRunner(prompts: string[]): LLMRunner {
    return {
      run: async (p) => {
        prompts.push(p.prompt);
        return JSON.stringify([{ record_id: `ab_${pair.pid}`, action: "store" }]);
      },
    };
  }

  async function runArm(mode: "none" | "lexical"): Promise<string[]> {
    const { store } = build5CandMockStore(pair);
    const prompts: string[] = [];
    const decisions = await batchDedup({
      memories: [{ record_id: `ab_${pair.pid}`, content: newer, type: "work_fact" as never, priority: 80, source_message_ids: [], metadata: {}, scene_name: "" }],
      config: {},
      llmRunner: stubRunner(prompts),
      vectorStore: store,
      dedupFailFast: true,
      dedupRecallRerank: mode,
      timeoutMs: 240_000,
    });
    // 链路完整性：stub 回复被 parseBatchResult 正确消费（mock→batchDedup→parse 全通）
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe("store");
    expect(prompts).toHaveLength(1);
    return prompts;
  }

  it("none 臂：孪生 db 名次第 7 → prompt 不含孪生 id，与 finalPoolFor 一致", async () => {
    const prompts = await runArm("none");
    const computed = finalPoolFor(pair, "none", 5, { queryContent: newer });
    expect(computed.twinInPool).toBe(false);
    expect(prompts[0]!.includes("twin_row")).toBe(false);
    // 一致性断言本身（保真契约）：prompt 出现性 === 计算入池性
    expect(prompts[0]!.includes("twin_row")).toBe(computed.twinInPool);
  });

  it("lexical 臂：孪生同文被重排捞回 → prompt 含孪生 id，与 finalPoolFor 一致", async () => {
    const prompts = await runArm("lexical");
    const computed = finalPoolFor(pair, "lexical", 5, { queryContent: newer });
    expect(computed.twinInPool).toBe(true);
    expect(computed.twinFinalRank).toBe(1);
    expect(prompts[0]!.includes("twin_row")).toBe(true);
    expect(prompts[0]!.includes("twin_row")).toBe(computed.twinInPool);
  });
});

// ── buildAb5Context / stratumOf / stratify ─────────────────────────────

describe("buildAb5Context 与分层", () => {
  const newer = "分层测试查询内容";
  const twinAt = (rank: number) => {
    const pool: Golden5CandPoolRow[] = [];
    for (let i = 1; i <= 11; i++) {
      if (i === rank) pool.push(poolRow("twin_row", newer, 0.9));
      else pool.push(poolRow(`filler_${i}`, fillerContent(i)));
    }
    return pool;
  };

  it("stratumOf：db 按名次带三段 + beyond + injected 五层", () => {
    expect(stratumOf(dbPair("x", twinAt(3), 3, "twin_row"))).toBe("db:1-5");
    expect(stratumOf(dbPair("x", twinAt(7), 7, "twin_row"))).toBe("db:6-10");
    expect(stratumOf(dbPair("x", twinAt(11), 11, "twin_row"))).toBe("db:11+");
    expect(stratumOf(beyondPair("x", twinAt(3).filter((r) => r.record_id !== "twin_row"), "twin_row"))).toBe("db:beyond");
    expect(stratumOf(injectedPair("x", twinAt(8), 8, "twin_row"))).toBe("injected");
  });

  it("stratify：行按孪生态 × 名次带分组，各层带入池率与 M1", () => {
    const pairs = [
      dbPair("p15", twinAt(3), 3, "twin_row"),
      dbPair("p610", twinAt(7), 7, "twin_row"),
      dbPair("p11", twinAt(11), 11, "twin_row"),
      beyondPair("pB", twinAt(3).filter((r) => r.record_id !== "twin_row"), "twin_row"),
      injectedPair("pI", twinAt(8), 8, "twin_row"),
    ];
    const golds = pairs.map((p) => goldPair(p.pid));
    const ctx = buildAb5Context(pairs, golds);
    const rows: Ab5Row[] = [
      row("p15", "none", { twin_source: "db", twin_rank: 3, action: "store" }),
      row("p610", "none", { twin_source: "db", twin_rank: 7, action: "store" }),
      row("p11", "none", { twin_source: "db", twin_rank: 11, action: "store" }),
      row("pB", "none", { twin_source: "db", twin_rank: null, action: "store" }),
      row("pI", "none", { twin_source: "injected", twin_rank: 8, action: "store" }),
    ];
    const strata = stratify(rows, ctx);
    expect(strata.map((s) => s.stratum)).toEqual(["db:1-5", "db:6-10", "db:11+", "db:beyond", "injected"]);
    const by = new Map(strata.map((s) => [s.stratum, s]));
    expect(by.get("db:1-5")).toMatchObject({ n: 1, twinInPool: 1, judgedStore: 1 });
    expect(by.get("db:6-10")).toMatchObject({ n: 1, twinInPool: 0, judgedStore: 1 });
    expect(by.get("db:11+")).toMatchObject({ n: 1, twinInPool: 0 });
    expect(by.get("db:beyond")).toMatchObject({ n: 1, twinInPool: 0 });
    expect(by.get("injected")).toMatchObject({ n: 1, twinInPool: 0 });
    // M1 分层：除 db:1-5 外，其余层孪生未入池 → store 全记召回截断损失
    expect(by.get("db:1-5")!.judgmentFailure).toBe(1);
    expect(by.get("db:6-10")!.recallTruncationLoss).toBe(1);
  });

  it("twinSurvival：入池率 + 最终名次分布（1..5 精确名次）", () => {
    const pairs = [
      dbPair("p15", twinAt(3), 3, "twin_row"),
      dbPair("p610", twinAt(7), 7, "twin_row"),
      beyondPair("pB", twinAt(3).filter((r) => r.record_id !== "twin_row"), "twin_row"),
    ];
    // 金标 content_newer 与孪生同文（twinAt 的孪生内容即 newer）→ lexical 重排查询与生产一致
    const ctx = buildAb5Context(pairs, pairs.map((p) => goldPair(p.pid, { content_newer: newer, content_older: newer })));
    const noneRows: Ab5Row[] = [
      row("p15", "none", { twin_rank: 3 }),
      row("p610", "none", { twin_rank: 7 }),
      row("pB", "none", { twin_rank: null }),
    ];
    const s = twinSurvival(noneRows, ctx);
    expect(s.n).toBe(3);
    expect(s.twinInPool).toBe(1);
    expect(s.twinInPoolPct).toBeCloseTo(100 / 3, 9);
    expect(s.finalRankHist).toEqual({ "3": 1, "not-in-pool": 2 });

    // lexical：孪生与查询同文 → db:6-10 行被捞回第 1 名
    const lexRows: Ab5Row[] = [
      row("p15", "lexical", { twin_rank: 3 }),
      row("p610", "lexical", { twin_rank: 7 }),
      row("pB", "lexical", { twin_rank: null }),
    ];
    const sLex = twinSurvival(lexRows, ctx);
    expect(sLex.twinInPool).toBe(2);
    expect(sLex.finalRankHist).toEqual({ "1": 2, "not-in-pool": 1 });
  });

  it("buildAb5Context：数据集对缺金标对 → 显式抛错", () => {
    const pairs = [dbPair("pA", twinAt(3), 3, "twin_row")];
    expect(() => buildAb5Context(pairs, [])).toThrow(/pA/);
  });
});

// ── M1 分解 + 四指标 + 预注册三条件 ─────────────────────────────────────

describe("m1Decomposition 与 abMetrics", () => {
  const newer = "M1 分解测试查询内容";
  const twinAt = (rank: number) => {
    const pool: Golden5CandPoolRow[] = [];
    for (let i = 1; i <= 6; i++) {
      if (i === rank) pool.push(poolRow("twin_row", newer, 0.9));
      else pool.push(poolRow(`filler_${i}`, fillerContent(i)));
    }
    return pool;
  };
  const pairs = [
    dbPair("pIn", twinAt(2), 2, "twin_row"),    // none 臂孪生入池
    beyondPair("pOut", twinAt(2).filter((r) => r.record_id !== "twin_row"), "twin_row"), // 恒不入池
    dbPair("pStore", twinAt(3), 3, "twin_row"), // golden=store 对
    dbPair("pSkip", twinAt(4), 4, "twin_row"),
    dbPair("pErr", twinAt(5), 5, "twin_row"),
  ];
  const ctx = buildAb5Context(
    pairs,
    pairs.map((p) => goldPair(p.pid, { answer_user: p.pid === "pStore" ? "store" : "merge" })),
  );

  it("M1 分解：孪生未入池=召回截断损失、入池判 store=判定层失败；error 不进分母", () => {
    const rows: Ab5Row[] = [
      row("pOut", "none", { action: "store" }), // 召回截断损失
      row("pIn", "none", { action: "store" }),  // 判定层失败
      row("pStore", "none", { golden: "store", action: "merge" }), // M2，不进 M1
      row("pSkip", "none", { action: "skip" }), // skip 不进 M1 分子
      row("pErr", "none", { action: "error", error: "boom" }), // error 剔出分母
    ];
    const d = m1Decomposition(rows, ctx);
    expect(d.mergeGolden).toBe(3); // pOut/pIn/pSkip（pErr 被 error 剔除）
    expect(d.judgedStore).toBe(2);
    expect(d.recallTruncationLoss).toBe(1);
    expect(d.judgmentFailure).toBe(1);
    expect(d.M1pct).toBeCloseTo((2 / 3) * 100, 6);
    expect(d.shares).toEqual({ recallPct: 50, judgmentPct: 50 });
  });

  it("abMetrics：四指标口径 + error 只计数不进分母", () => {
    const rows: Ab5Row[] = [
      row("a", "none", { golden: "merge", action: "store", sim: 0.9, band: "exact" }),
      row("b", "none", { golden: "store", action: "merge", sim: 0.5, band: "0.70-0.85" }),
      row("c", "none", { golden: "merge", action: "skip", sim: 0.6, band: "0.60-0.70" }),
      row("d", "none", { golden: "store", action: "error", error: "x", sim: 0.5, band: "neg" }),
    ];
    const m = abMetrics(rows);
    expect(m.n).toBe(3); // error 行剔出分母
    expect(m.errors).toBe(1);
    expect(m.M1_该合未合).toBe(50); // merge 分母 2（a,c），判 store 1（a）
    expect(m.M2_不该合误合).toBe(100); // store 分母 1（b），判 merge 1
    expect(m.M4_漏记skip).toBeCloseTo(100 / 3, 6); // skip 1 / n 3
    expect(m.M3_明确应合并子集_M1).toBe(100); // 明确子集仅 a（sim 0.9），判 store → 1/1
    expect(m.action_dist).toEqual({ store: 1, merge: 1, skip: 1, error: 1 });
  });

  it("abMetrics：M3 子集边界（sim>=0.85 含边界、null+exact 计入、null+低带不计）", () => {
    const mk = (sim: number | null, band: string): Ab5Row => row("x", "none", { golden: "merge", action: "skip", sim, band });
    const m = abMetrics([mk(0.85, "0.85+"), mk(null, "exact"), mk(null, "0.70-0.85")]);
    // 分母 = 明确子集 2（0.85 边界 + null+exact）；skip 均非 store → M3 = 0
    expect(m.M3_明确应合并子集_M1).toBe(0);
    const m2 = abMetrics([mk(0.84, "0.70-0.85")]);
    expect(m2.M3_明确应合并子集_M1).toBeNull(); // 子集为空 → null
  });

  it("abMetrics：空行集 → 全 null", () => {
    const m = abMetrics([]);
    expect(m).toMatchObject({ n: 0, errors: 0, M1_该合未合: null, M2_不该合误合: null, M3_明确应合并子集_M1: null, M4_漏记skip: null });
    expect(m.action_dist).toEqual({});
  });

  it("preregConditions：三条件逐字沿用 golden-ab.ts（含边界与 null 短路）", () => {
    const base = { n: 10, errors: 0, M4_漏记skip: 0, action_dist: {} };
    const none = { ...base, M1_该合未合: 30, M2_不该合误合: 10, M3_明确应合并子集_M1: 20 };
    expect(preregConditions(none, { ...base, M1_该合未合: 24, M2_不该合误合: 13, M3_明确应合并子集_M1: 10 })).toEqual({
      M1_drop_5pct: true, M2_rise_3pct: true, M3_halved: true, allMet: true,
    });
    // 边界外各差一点 → 全 false
    expect(preregConditions(none, { ...base, M1_该合未合: 26, M2_不该合误合: 14, M3_明确应合并子集_M1: 11 })).toEqual({
      M1_drop_5pct: false, M2_rise_3pct: false, M3_halved: false, allMet: false,
    });
    // null 短路 → false
    expect(preregConditions({ ...none, M1_该合未合: null }, { ...base, M1_该合未合: 0, M2_不该合误合: 0, M3_明确应合并子集_M1: 0 }).M1_drop_5pct).toBe(false);
  });

  it("isDegraded：error 率 >10% 标 degraded（10% 边界不标）", () => {
    const errRow = () => row("e", "none", { action: "error", error: "x" });
    expect(isDegraded([errRow(), ...Array.from({ length: 4 }, () => row("ok", "none"))])).toBe(true); // 20%
    expect(isDegraded([errRow(), ...Array.from({ length: 19 }, () => row("ok", "none"))])).toBe(false); // 5%
    expect(isDegraded([errRow(), ...Array.from({ length: 9 }, () => row("ok", "none"))])).toBe(false); // 恰 10%
    expect(isDegraded([])).toBe(false);
  });
});

// ── 断点续跑 ────────────────────────────────────────────────────────────

describe("resumeSkip / resumeKey", () => {
  it("resumeKey：pid|mode 键格式", () => {
    expect(resumeKey("g001", "none")).toBe("g001|none");
  });

  it("resumeSkip：已判 (pid,mode) 跳过，未判进 pending", () => {
    const tasks = [
      { pid: "p1", mode: "none" }, { pid: "p1", mode: "lexical" },
      { pid: "p2", mode: "none" }, { pid: "p2", mode: "lexical" },
    ];
    const judged = new Set([resumeKey("p1", "none"), resumeKey("p1", "lexical")]);
    const r = resumeSkip(judged, tasks);
    expect(r.skipped).toBe(2);
    expect(r.pending).toEqual([{ pid: "p2", mode: "none" }, { pid: "p2", mode: "lexical" }]);
  });

  it("resumeSkip：同 pid 异 mode 只跳已判那臂", () => {
    const tasks = [{ pid: "p1", mode: "none" }, { pid: "p1", mode: "lexical" }];
    const r = resumeSkip(new Set([resumeKey("p1", "none")]), tasks);
    expect(r.skipped).toBe(1);
    expect(r.pending).toEqual([{ pid: "p1", mode: "lexical" }]);
  });

  it("resumeSkip：空已判集 → 全部 pending", () => {
    const tasks = [{ pid: "p1", mode: "none" }];
    expect(resumeSkip(new Set(), tasks)).toEqual({ pending: tasks, skipped: 0 });
  });
});
