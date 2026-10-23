/**
 * 金标 5 候选 A/B 度量纯函数集（票 02，2026-10-24「金标 5 候选复测」）。
 *
 * 与既有单候选 harness（scripts/golden-ab.ts，原样保留供历史对照）的分工：
 * 该 harness 候选池恒为 [older]，测不出「5 候选池下孪生能否进 prompt」；本模块
 * 在票 01 数据集（Golden5CandPair，池 1..50 行、孪生带真实名次）之上补齐
 * 召回层度量。组成：
 *
 * 1. `finalPoolFor`：复刻生产两臂池选择（findCandidates@l1-dedup.ts 的 1-memory
 *    特例）——self 过滤后 none=召回序截断 slice(0,topK) / lexical=**生产**
 *    rerankCandidatesBySimilarity 重排取 top-K；返回最终池 + 孪生是否入池 +
 *    最终名次。必须引用生产重排纯函数，禁止复制实现。
 * 2. `build5CandMockStore`：harness 与单测**共用**的 mock store（countL1=池长、
 *    isFtsAvailable=true、searchL1Fts 按池序截 topK 前缀返回），并记录 FTS 调用
 *    序列，供「两臂 topK 语义与生产 findCandidates 一致」的可数假池验证。
 * 3. 孪生生存度量（twinSurvival）、M1 分解（m1Decomposition）、分层表（stratify，
 *    twin_source 三态 × db 名次带 1-5/6-10/11+）。
 * 4. 四指标（abMetrics，公式沿用 scripts/golden-ab.ts；error 行按票面约束
 *    「不进指标分母」剔出分母，仅计入 errors 计数）+ 预注册三条件判定
 *    （preregConditions，逐字沿用 golden-ab.ts）+ degraded 标记（isDegraded）。
 * 5. 断点续跑（resumeKey / resumeSkip，票 05 起跳过键扩为
 *    (pid,mode,topk,thinking,promptVariant)，两参旧形态保持向后兼容）。
 *
 * 全部纯函数、零 IO，可直测（golden-ab5-metrics.test.ts / golden-ab5-knobs.test.ts）。
 */

import type { IMemoryStore } from "../store/types.js";
import type { Golden5CandPair, Golden5CandPoolRow } from "./golden-5cand.js";
import type { GoldenPair } from "./golden-fixture.js";
import { rerankCandidatesBySimilarity, type DedupRecallRerank } from "./l1-recall-rerank.js";

/** A/B 两臂（= 生产 dedupRecallRerank 开关值）。 */
export type Arm = DedupRecallRerank;

/** harness JSONL 结果行（一行一个 (pid,mode,topk,thinking,promptVariant) 判定）。 */
export interface Ab5Row {
  pid: string;
  mode: string;
  /** 金标答案（answer_user，沿用 golden-ab.ts 口径） */
  golden: string;
  action: string;
  sim: number | null;
  band: string;
  twin_source: string;
  twin_rank: number | null;
  error?: string;
  // ── 票 05 消融旋钮（harness 写行恒携带；旧行缺字段由 rowKnobs 回落默认）──
  /** 判定候选数（batchDedup conflictRecallTopK 实际生效值） */
  topk?: number;
  /** 注入的 thinking 档位；未注入 = "" */
  thinking?: string;
  /** prompt 变体名；生产 prompt = "base" */
  promptVariant?: string;
}

/** 消融旋钮三元组（归一化形状：thinking 空串=不注入；promptVariant "base"=生产 prompt）。 */
export interface Ab5Knobs {
  topk: number;
  thinking: string;
  promptVariant: string;
}

/** 缺省旋钮 = 票 02 基线复刻（topk=5、无 thinking 注入、生产 prompt）。 */
export const AB5_DEFAULT_KNOBS: Ab5Knobs = { topk: 5, thinking: "", promptVariant: "base" };

/** 旋钮分组键（resumeKey 后缀与聚合 (arm×变体) 分组共用同一口径）。 */
export function knobKey(knobs: Ab5Knobs): string {
  return `topk=${knobs.topk}|thinking=${knobs.thinking || "none"}|variant=${knobs.promptVariant}`;
}

/**
 * JSONL 行字段 → 归一化旋钮：旧行（票 02 时代，无新字段）逐字段回落默认——
 * 因此默认旋钮（topk=5/不注入/base）的 --resume 能无缝续跑历史基线行。
 */
export function rowKnobs(row: Pick<Ab5Row, "topk" | "thinking" | "promptVariant">): Ab5Knobs {
  return {
    topk: typeof row.topk === "number" ? row.topk : AB5_DEFAULT_KNOBS.topk,
    thinking: typeof row.thinking === "string" ? row.thinking : AB5_DEFAULT_KNOBS.thinking,
    promptVariant: typeof row.promptVariant === "string" ? row.promptVariant : AB5_DEFAULT_KNOBS.promptVariant,
  };
}

// ── finalPoolFor：两臂最终池选择（复刻生产 findCandidates）──────────────

export interface FinalPoolResult {
  /** 最终池（≤topK 行；池序 = 进 prompt 的关联候选序） */
  pool: Golden5CandPoolRow[];
  twinInPool: boolean;
  /** 孪生最终名次（1-based）；不在池 = null */
  twinFinalRank: number | null;
}

export interface FinalPoolOptions {
  /** 重排查询内容（lexical 臂必填；生产语义为金标 content_newer，与 mem.content 一致） */
  queryContent?: string;
  /** self 排除集（生产 newRecordIds；harness 的 memory id 不在池内，恒为 no-op，保留以复刻链路） */
  selfIds?: ReadonlySet<string>;
}

/**
 * 复刻 findCandidates@l1-dedup.ts:302-323 的两臂池选择（harness 恒 1 对
 * 1 memory 判定，memories.length=1）：
 *   none    臂 fetch = topK + 1 = 6 → self 过滤 → filtered.slice(0, topK)；
 *   lexical 臂 fetch = max(topK*10, 50) = 50 → self 过滤 → 生产重排取 topK。
 * 非法 mode / lexical 缺 queryContent 显式抛错（不允许静默错排）。
 */
export function finalPoolFor(
  pair: Golden5CandPair,
  mode: Arm,
  topK = 5,
  opts: FinalPoolOptions = {},
): FinalPoolResult {
  if (mode !== "none" && mode !== "lexical") {
    throw new Error(`[golden-ab5] mode 非法: ${JSON.stringify(mode)}（合法: none|lexical）`);
  }
  const k = Math.max(0, topK);
  const recallFetch = mode === "lexical" ? Math.max(k * 10, 50) : k + 1;
  const fetched = pair.pool.slice(0, recallFetch);
  const selfIds = opts.selfIds;
  const filtered = selfIds ? fetched.filter((r) => !selfIds.has(r.record_id)) : fetched;

  let finalPool: Golden5CandPoolRow[];
  if (mode === "lexical") {
    const query = opts.queryContent;
    if (typeof query !== "string") {
      throw new Error("[golden-ab5] finalPoolFor lexical 臂缺 queryContent（生产语义为金标 content_newer），拒绝静默错排");
    }
    // 生产调用面（l1-dedup.ts:321）把 L1SearchResult[] 直接喂给
    // rerankCandidatesBySimilarity<T extends RecallCandidate>（该结构不匹配是
    // typecheck 基线 230 中的既有错误）。此处以 {id, content} 包装行调用**同一
    // 生产函数**：重排只读 content、按对象身份返回原对象，包装不改行为，
    // 且不新增 typecheck 错误。
    const wrapped = filtered.map((r) => ({ id: r.record_id, content: r.content, row: r }));
    finalPool = rerankCandidatesBySimilarity(query, wrapped, k).map((w) => w.row);
  } else {
    finalPool = filtered.slice(0, k);
  }
  const idx = finalPool.findIndex((r) => r.record_id === pair.twin_id);
  return { pool: finalPool, twinInPool: idx >= 0, twinFinalRank: idx >= 0 ? idx + 1 : null };
}

// ── build5CandMockStore：harness/单测共用的 mock store ──────────────────

export interface FtsCall {
  query: string;
  topK: number;
}

export interface Mock5CandStore {
  store: IMemoryStore;
  /** searchL1Fts 调用序列（可数假池验证两臂 topK 语义与生产一致） */
  ftsCalls: FtsCall[];
}

/**
 * mock 面（票面约定）：countL1=池长、isFtsAvailable=true、
 * searchL1Fts(q, topK) => pool.slice(0, topK)。
 * query 为生产 buildFtsQuery(content_newer) 产物，候选池已是检索序，故忽略；
 * 记录调用序列供忠实性断言。
 */
export function build5CandMockStore(pair: Golden5CandPair): Mock5CandStore {
  const ftsCalls: FtsCall[] = [];
  const store = {
    countL1: async () => pair.pool.length,
    isFtsAvailable: () => true,
    searchL1Fts: async (query: string, topK: number) => {
      ftsCalls.push({ query, topK });
      return pair.pool.slice(0, Math.max(0, topK));
    },
  } as unknown as IMemoryStore;
  return { store, ftsCalls };
}

// ── 上下文：数据集对 × 金标对（重排查询内容来源）───────────────────────

export interface Ab5Context {
  pairById: ReadonlyMap<string, Golden5CandPair>;
  /** pid → 金标 content_newer（lexical 臂 finalPoolFor 的生产同款查询内容） */
  contentNewerByPid: ReadonlyMap<string, string>;
}

/** 数据集对 + 金标对 → 度量上下文；缺对显式抛错（对齐由 loadGolden5CandDataset 保证）。 */
export function buildAb5Context(
  pairs: readonly Golden5CandPair[],
  goldenPairs: readonly GoldenPair[],
): Ab5Context {
  const contentNewerByPid = new Map(goldenPairs.map((g) => [g.pid, g.content_newer]));
  for (const p of pairs) {
    if (!contentNewerByPid.has(p.pid)) {
      throw new Error(`[golden-ab5] 数据集对 ${p.pid} 在金标 fixture 中无对应（loadGolden5CandDataset 已保证全量对齐，此处不应发生）`);
    }
  }
  return { pairById: new Map(pairs.map((p) => [p.pid, p])), contentNewerByPid };
}

/** 内部：按 pid 取生产同款查询内容复算最终池。 */
function finalOutcome(pair: Golden5CandPair, mode: Arm, ctx: Ab5Context, topK: number): FinalPoolResult {
  return finalPoolFor(pair, mode, topK, { queryContent: ctx.contentNewerByPid.get(pair.pid) });
}

// ── 孪生生存度量 ────────────────────────────────────────────────────────

export interface TwinSurvivalStats {
  n: number;
  twinInPool: number;
  twinInPoolPct: number | null;
  /** 最终名次分布（最终池 ≤topK → 1..5 精确名次键）；不在池记 "not-in-pool" */
  finalRankHist: Record<string, number>;
}

/** 每行按其 mode 复算最终池，统计孪生入池率与最终名次分布（召回层收益直接度量）。 */
export function twinSurvival(rows: readonly Ab5Row[], ctx: Ab5Context, topK = 5): TwinSurvivalStats {
  let inPool = 0;
  const hist: Record<string, number> = {};
  for (const r of rows) {
    const pair = ctx.pairById.get(r.pid);
    if (!pair) throw new Error(`[golden-ab5] 结果行 pid=${r.pid} 在数据集中不存在`);
    const out = finalOutcome(pair, r.mode as Arm, ctx, topK);
    const key = out.twinFinalRank === null ? "not-in-pool" : String(out.twinFinalRank);
    hist[key] = (hist[key] ?? 0) + 1;
    if (out.twinInPool) inPool++;
  }
  return {
    n: rows.length,
    twinInPool: inPool,
    twinInPoolPct: rows.length === 0 ? null : (inPool / rows.length) * 100,
    finalRankHist: hist,
  };
}

// ── 分层：twin_source 三态 × db 名次带 ──────────────────────────────────

export type Stratum = "db:1-5" | "db:6-10" | "db:11+" | "db:beyond" | "injected";

/** 分层固定输出顺序（仅 stratify 内部消费，非导出）。 */
const STRATA_ORDER: readonly Stratum[] = ["db:1-5", "db:6-10", "db:11+", "db:beyond", "injected"];

/** 孪生态分层：db 按数据集名次带三段 + 超召回地板 + 注入。 */
export function stratumOf(pair: Golden5CandPair): Stratum {
  if (pair.twin_source === "injected") return "injected";
  if (pair.twin_beyond_recall || pair.twin_rank === null) return "db:beyond";
  if (pair.twin_rank <= 5) return "db:1-5";
  if (pair.twin_rank <= 10) return "db:6-10";
  return "db:11+";
}

export interface StratumStat {
  stratum: Stratum;
  n: number;
  twinInPool: number;
  twinInPoolPct: number | null;
  mergeGolden: number;
  judgedStore: number;
  M1pct: number | null;
  recallTruncationLoss: number;
  judgmentFailure: number;
}

/** 分层表：行按 stratumOf 分组，各层出孪生生存 + M1 分解。 */
export function stratify(rows: readonly Ab5Row[], ctx: Ab5Context, topK = 5): StratumStat[] {
  const buckets = new Map<Stratum, Ab5Row[]>();
  for (const r of rows) {
    const pair = ctx.pairById.get(r.pid);
    if (!pair) throw new Error(`[golden-ab5] 结果行 pid=${r.pid} 在数据集中不存在`);
    const s = stratumOf(pair);
    const list = buckets.get(s);
    if (list) list.push(r);
    else buckets.set(s, [r]);
  }
  return STRATA_ORDER.filter((s) => buckets.has(s)).map((s) => {
    const list = buckets.get(s)!;
    const survival = twinSurvival(list, ctx, topK);
    const m1 = m1Decomposition(list, ctx, topK);
    return {
      stratum: s,
      n: list.length,
      twinInPool: survival.twinInPool,
      twinInPoolPct: survival.twinInPoolPct,
      mergeGolden: m1.mergeGolden,
      judgedStore: m1.judgedStore,
      M1pct: m1.M1pct,
      recallTruncationLoss: m1.recallTruncationLoss,
      judgmentFailure: m1.judgmentFailure,
    };
  });
}

// ── M1 分解 ─────────────────────────────────────────────────────────────

export interface M1Decomposition {
  /** golden=merge 的非 error 行数（M1 分母） */
  mergeGolden: number;
  /** 其中判 store 的行数（M1 分子，口径沿用 golden-ab.ts：只看 action=store） */
  judgedStore: number;
  M1pct: number | null;
  /** M1 分子中孪生未入最终池（必 store）→ 召回截断损失 */
  recallTruncationLoss: number;
  /** M1 分子中孪生入最终池但判 store → 判定层失败 */
  judgmentFailure: number;
  /** 两类损失各占 M1 分子的比例（judgedStore=0 → null） */
  shares: { recallPct: number | null; judgmentPct: number | null };
}

/**
 * M1 分解（票 02 What-to-build #2）：golden=merge 对中判 store 的行，按孪生
 * 是否入最终池拆成「召回截断损失」与「判定层失败」。
 */
export function m1Decomposition(rows: readonly Ab5Row[], ctx: Ab5Context, topK = 5): M1Decomposition {
  let mergeGolden = 0;
  let judgedStore = 0;
  let recall = 0;
  let judgment = 0;
  for (const r of rows) {
    if (r.action === "error") continue; // 票面：error 不进指标分母
    if (r.golden !== "merge") continue;
    mergeGolden++;
    if (r.action !== "store") continue;
    judgedStore++;
    const pair = ctx.pairById.get(r.pid);
    if (!pair) throw new Error(`[golden-ab5] 结果行 pid=${r.pid} 在数据集中不存在`);
    if (finalOutcome(pair, r.mode as Arm, ctx, topK).twinInPool) judgment++;
    else recall++;
  }
  const pct = (a: number, b: number) => (b === 0 ? null : (a / b) * 100);
  return {
    mergeGolden,
    judgedStore,
    M1pct: pct(judgedStore, mergeGolden),
    recallTruncationLoss: recall,
    judgmentFailure: judgment,
    shares: { recallPct: pct(recall, judgedStore), judgmentPct: pct(judgment, judgedStore) },
  };
}

// ── 四指标 + 预注册三条件 + degraded ────────────────────────────────────

export interface AbMetrics {
  /** 非 error 行数（四指标分母口径） */
  n: number;
  errors: number;
  M1_该合未合: number | null;
  M2_不该合误合: number | null;
  M3_明确应合并子集_M1: number | null;
  M4_漏记skip: number | null;
  action_dist: Record<string, number>;
}

/**
 * 四指标（公式逐字沿用 scripts/golden-ab.ts:97-114）：M1=golden=merge 判 store；
 * M2=golden=store 判 merge/update；M3=M1 在「明确应合并」子集（sim>=0.85 或
 * exact）；M4=skip 占比。差异（票面约束）：error 行剔出四指标分母，仅计入
 * errors（golden-ab.ts 原版 error 留在分母，等价于其 error 恒不命中的现状）。
 * action_dist 含 error 行（沿用原版全量 reduce）。
 */
export function abMetrics(rows: readonly Ab5Row[]): AbMetrics {
  const action_dist = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.action] = (acc[r.action] ?? 0) + 1;
    return acc;
  }, {});
  const valid = rows.filter((r) => r.action !== "error");
  const mergeG = valid.filter((r) => r.golden === "merge");
  const storeG = valid.filter((r) => r.golden === "store");
  const clearSub = valid.filter((r) => r.golden === "merge" && ((r.sim ?? 0) >= 0.85 || r.band === "exact"));
  const pct = (a: number, b: number) => (b === 0 ? null : (a / b) * 100);
  return {
    n: valid.length,
    errors: rows.length - valid.length,
    M1_该合未合: pct(mergeG.filter((r) => r.action === "store").length, mergeG.length),
    M2_不该合误合: pct(storeG.filter((r) => r.action === "merge" || r.action === "update").length, storeG.length),
    M3_明确应合并子集_M1: pct(clearSub.filter((r) => r.action === "store").length, clearSub.length),
    M4_漏记skip: pct(valid.filter((r) => r.action === "skip").length, valid.length),
    action_dist,
  };
}

export interface PreregConditions {
  M1_drop_5pct: boolean;
  M2_rise_3pct: boolean;
  M3_halved: boolean;
  allMet: boolean;
}

/** 预注册三条件（逐字沿用 scripts/golden-ab.ts:164-166；任一侧 null 短路为 false）。 */
export function preregConditions(none: AbMetrics, lexical: AbMetrics): PreregConditions {
  const cond1 = none.M1_该合未合 !== null && lexical.M1_该合未合 !== null && lexical.M1_该合未合 <= none.M1_该合未合 - 5;
  const cond2 = none.M2_不该合误合 !== null && lexical.M2_不该合误合 !== null && lexical.M2_不该合误合 <= none.M2_不该合误合 + 3;
  const cond3 = none.M3_明确应合并子集_M1 !== null && lexical.M3_明确应合并子集_M1 !== null && lexical.M3_明确应合并子集_M1 <= none.M3_明确应合并子集_M1 / 2;
  return { M1_drop_5pct: cond1, M2_rise_3pct: cond2, M3_halved: cond3, allMet: cond1 && cond2 && cond3 };
}

/** error 率 >10% → degraded（票面约束；恰 10% 不标）。 */
export function isDegraded(rows: readonly Ab5Row[]): boolean {
  if (rows.length === 0) return false;
  return rows.filter((r) => r.action === "error").length / rows.length > 0.1;
}

// ── 断点续跑 ────────────────────────────────────────────────────────────

/**
 * 已判记录键：pid|mode（票 02 形态，两参调用保持不变）；带旋钮时扩为
 * pid|mode|topk=N|thinking=X|variant=Y（票 05：不同消融臂互不误跳）。
 */
export function resumeKey(pid: string, mode: string, knobs?: Ab5Knobs): string {
  return knobs ? `${pid}|${mode}|${knobKey(knobs)}` : `${pid}|${mode}`;
}

export interface ResumeSkipResult<T> {
  pending: T[];
  skipped: number;
}

/** 已判 (pid,mode,旋钮) 集合 × 任务队列 → 待跑任务（跳过已判；任务不带旋钮沿用旧键）。 */
export function resumeSkip<T extends { pid: string; mode: string; knobs?: Ab5Knobs }>(
  judged: ReadonlySet<string>,
  tasks: readonly T[],
): ResumeSkipResult<T> {
  const pending: T[] = [];
  let skipped = 0;
  for (const t of tasks) {
    if (judged.has(resumeKey(t.pid, t.mode, t.knobs))) skipped++;
    else pending.push(t);
  }
  return { pending, skipped };
}
