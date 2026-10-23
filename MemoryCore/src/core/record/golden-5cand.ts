/**
 * 金标 5 候选池数据集（票 01，2026-10-24「金标 5 候选复测」）：schema、加载校验、
 * 注入策略纯函数。
 *
 * 给既有 250 对金标（m1-dedup-golden fixture）逐对配一个**生产召回形态**的候选池：
 * 生产分词 buildFtsQuery(content_newer) + 生产 store.searchL1Fts 在活库快照上检索
 * top-50，记录孪生（older）真实名次。本模块只做**纯逻辑**（schema/校验/注入策略），
 * IO（快照、检索、落盘）在 scripts/golden-5cand-gen.ts。
 *
 * 注入策略（预注册，2026-10-24，不得擅改）：
 *   ① 孪生在 top-50        → twin_source="db"，pool=检索结果原序，twin_rank=池内名次；
 *   ② 孪生仍在库但不在池   → twin_source="db"、twin_beyond_recall=true、twin_rank=null，
 *                             pool 仍存 top-50（两臂都取不到孪生，进「召回缺失地板」分层）；
 *   ③ 孪生行已不在库（被历史 merge 删）→ twin_source="injected"，用 fixture 的 older
 *                             内容+type 构造合成行（scene_name 空串、priority 80、
 *                             score=0），按历史 rank_bucket 种子确定性落位
 *                             （top-5→1-5、6-10→6-10、11-50→11-50、absent/no_query→6-10），
 *                             插入该位置并挤掉池尾。
 * 附带口径（实现决定，非预注册变更，全部在生成统计中可辨）：
 *   - pool 剔除命中 newer 自身的行；twin_rank 按剔除后的池内位置计（候选池语义，
 *     恒满足 pool[twin_rank-1].record_id===twin_id 的自洽不变量）。
 *   - searchRows 按 top-50 契约截断：孪生出现在第 51 名起视为「在库但不在池」。
 *   - 态②若检索零命中（池为空）→ 退化为态③注入（空池在数据集 schema 中非法，
 *     票面验收把空池列为异常路径）；生成统计对这类退化单独计数。
 *   - rank_bucket="50+" 未在预注册映射中 → placementRangeForBucket 显式抛错
 *     （未注册情形不允许静默发明；当前 fixture 无 50+ 对）。
 *   - 合成行沿用真实 older_id 作 record_id，使 twin_id 恒等于池内行 id。
 * 隔离边界：检索不套 session 过滤（金标生成于单会话主体时期），生成统计注明。
 */

import type { GoldenBucket, GoldenFixture, GoldenPair } from "./golden-fixture.js";
import type { L1SearchResult } from "../store/types.js";

export const GOLDEN_5CAND_SCHEMA = "m1-5cand/v1" as const;

export type TwinSource = "db" | "injected";

/** 池行形状 = searchL1Fts 返回（L1SearchResult / FtsSearchResult 同字段面）。 */
export interface Golden5CandPoolRow {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  /** BM25 分（0–1）；注入合成行恒为 0（无检索打分） */
  score: number;
  timestamp_str: string;
  timestamp_start: string;
  timestamp_end: string;
  version: number;
  session_key: string;
  session_id: string;
  team_id: string;
  task_id: string;
  user_id: string;
  agent_id: string;
  metadata_json: string;
}

export interface Golden5CandPair {
  pid: string;
  /** 孪生（older 侧）record_id；注入态合成行沿用同 id */
  twin_id: string;
  twin_source: TwinSource;
  /** db 态=池内名次；beyond_recall 态=null；injected 态=落位名次 */
  twin_rank: number | null;
  twin_beyond_recall: boolean;
  /** 1..50 行，原序（检索序 + 注入插入） */
  pool: Golden5CandPoolRow[];
}

export interface Golden5CandDataset {
  schema: typeof GOLDEN_5CAND_SCHEMA;
  created_at: string;
  /** 生成环境元信息（快照路径、种子、检索口径等），自由键值 */
  source: Record<string, unknown>;
  pairs: Golden5CandPair[];
}

// ── 落位：rank_bucket → 区间 + 种子确定性 ───────────────────────────────

/** 预注册映射：历史 bucket → 注入落位区间（1-based 闭区间）。 */
const PLACEMENT_RANGES: Array<[GoldenBucket, [number, number]]> = [
  ["top-5", [1, 5]],
  ["6-10", [6, 10]],
  ["11-50", [11, 50]],
  ["absent", [6, 10]],
  ["no_query", [6, 10]],
];

export function placementRangeForBucket(bucket: GoldenBucket): [number, number] {
  const hit = PLACEMENT_RANGES.find(([b]) => b === bucket);
  if (!hit) {
    // "50+" 未在预注册映射中——显式失败，不静默发明落位区间
    throw new Error(`[golden-5cand] rank_bucket="${bucket}" 无预注册落位区间（预注册仅覆盖 top-5/6-10/11-50/absent/no_query）`);
  }
  return hit[1];
}

/** FNV-1a 32 位哈希（无依赖、跨平台确定）。 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 注入落位名次：同 seed 同 pid 同 bucket → 同名次（确定性，票面验收项）。
 * 区间内均匀取模；调用方（build5CandPair）负责按池长 clamp。
 */
export function placementRank(bucket: GoldenBucket, pid: string, seed: string): number {
  const [lo, hi] = placementRangeForBucket(bucket);
  const h = fnv1a(`${seed}\u0000${pid}\u0000${bucket}`);
  return lo + (h % (hi - lo + 1));
}

// ── 注入策略纯函数（三态状态机）─────────────────────────────────────────

/** 构造注入合成行（预注册字段口径：older 内容+type、scene_name 空、priority 80）。 */
function syntheticTwinRow(olderId: string, golden: GoldenPair): Golden5CandPoolRow {
  return {
    record_id: olderId,
    content: golden.content_older,
    type: golden.type_older,
    priority: 80,
    scene_name: "",
    score: 0,
    timestamp_str: "",
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

export interface Build5CandInput {
  golden: GoldenPair;
  olderId: string;
  newerId: string;
  /** 生产 searchL1Fts 的检索结果原序（调用方限 50；>50 按 top-50 契约截断） */
  searchRows: L1SearchResult[];
  /** 孪生行是否仍在库（l1_records 存在性检查，与是否被召回无关） */
  twinInDb: boolean;
  seed: string;
}

/**
 * 三态状态机：检索结果 + 孪生在库标记 → 数据集对（见文件头预注册语义）。
 * 纯函数，可直测；IO 由生成脚本承担。
 */
export function build5CandPair(input: Build5CandInput): Golden5CandPair {
  const { golden, olderId, newerId, searchRows, twinInDb, seed } = input;
  // top-50 契约：第 51 名起不属于池（边界：孪生恰在 51 名 → beyond_recall）
  const top = searchRows.slice(0, 50);
  // 剔除 newer 自身（预注册）；twin_rank 按剔除后池内位置计
  const pool: Golden5CandPoolRow[] = top
    .filter((r) => r.record_id !== newerId)
    .map((r) => ({ ...r }));

  const twinIdx = pool.findIndex((r) => r.record_id === olderId);
  if (twinIdx >= 0) {
    // 态①：孪生在池内（池内可观测到即在池内，优先于 twinInDb 标记）
    return { pid: golden.pid, twin_id: olderId, twin_source: "db", twin_rank: twinIdx + 1, twin_beyond_recall: false, pool };
  }
  if (twinInDb && pool.length > 0) {
    // 态②：在库但不在池（含第 51 名边界）；零命中空池退化为态③（见文件头）
    return { pid: golden.pid, twin_id: olderId, twin_source: "db", twin_rank: null, twin_beyond_recall: true, pool };
  }
  // 态③：孪生已删（或空池退化）——按 bucket 种子落位插入并挤掉池尾
  const target = placementRank(golden.rank_bucket, golden.pid, seed);
  const at = Math.min(target, pool.length + 1); // 池短于区间时 clamp 到池尾后一位
  const next = [...pool.slice(0, at - 1), syntheticTwinRow(olderId, golden), ...pool.slice(at - 1)];
  return {
    pid: golden.pid,
    twin_id: olderId,
    twin_source: "injected",
    twin_rank: at,
    twin_beyond_recall: false,
    pool: next.slice(0, 50),
  };
}

// ── 校验与加载（风格对齐 golden-fixture.ts）─────────────────────────────

const POOL_STR_FIELDS = [
  "record_id", "content", "type", "scene_name", "timestamp_str", "timestamp_start",
  "timestamp_end", "session_key", "session_id", "team_id", "task_id", "user_id", "agent_id", "metadata_json",
] as const;

function validatePoolRow(r: unknown): Golden5CandPoolRow {
  if (!r || typeof r !== "object") throw new Error("[golden-5cand] pool 行不是对象");
  const o = r as Record<string, unknown>;
  for (const f of POOL_STR_FIELDS) {
    if (typeof o[f] !== "string") throw new Error(`[golden-5cand] pool 行缺字段或类型非法: ${f}`);
  }
  if (typeof o.priority !== "number" || !Number.isFinite(o.priority)) {
    throw new Error(`[golden-5cand] pool 行 priority 必须为有限数字，收到 ${JSON.stringify(o.priority)}`);
  }
  if (typeof o.score !== "number" || !Number.isFinite(o.score) || o.score < 0 || o.score > 1) {
    throw new Error(`[golden-5cand] pool 行 score 必须为 [0,1]，收到 ${JSON.stringify(o.score)}`);
  }
  if (typeof o.version !== "number" || !Number.isInteger(o.version) || o.version < 0) {
    throw new Error(`[golden-5cand] pool 行 version 必须为 >=0 整数，收到 ${JSON.stringify(o.version)}`);
  }
  return o as unknown as Golden5CandPoolRow;
}

/** 校验并归一化单对（抛错带字段名；纯函数可直测）。 */
export function validateGolden5CandPair(p: unknown): Golden5CandPair {
  if (!p || typeof p !== "object") throw new Error("[golden-5cand] pair 不是对象");
  const o = p as Record<string, unknown>;
  for (const f of ["pid", "twin_id"]) {
    if (typeof o[f] !== "string" || !(o[f] as string).trim()) throw new Error(`[golden-5cand] 缺字段或为空: ${f}`);
  }
  if (o.twin_source !== "db" && o.twin_source !== "injected") {
    throw new Error(`[golden-5cand] twin_source 非法: ${JSON.stringify(o.twin_source)}（合法: db|injected）`);
  }
  if (typeof o.twin_beyond_recall !== "boolean") {
    throw new Error(`[golden-5cand] twin_beyond_recall 必须为 boolean，收到 ${JSON.stringify(o.twin_beyond_recall)}`);
  }
  const rankOk =
    o.twin_rank === null ||
    (typeof o.twin_rank === "number" && Number.isInteger(o.twin_rank) && (o.twin_rank as number) >= 1);
  if (!rankOk) {
    throw new Error(`[golden-5cand] twin_rank 必须为 null 或 >=1 整数，收到 ${JSON.stringify(o.twin_rank)}`);
  }
  if (!Array.isArray(o.pool)) throw new Error("[golden-5cand] pool 必须为数组");
  if (o.pool.length === 0) throw new Error(`[golden-5cand] ${String(o.pid)}: pool 必须非空`);
  if (o.pool.length > 50) throw new Error(`[golden-5cand] ${String(o.pid)}: pool 长度必须为 1..50，收到 ${o.pool.length}`);
  const pool = o.pool.map(validatePoolRow);
  const seen = new Set<string>();
  for (const r of pool) {
    if (seen.has(r.record_id)) throw new Error(`[golden-5cand] ${String(o.pid)}: pool 内 record_id 重复: ${r.record_id}`);
    seen.add(r.record_id);
  }
  const containsTwin = seen.has(o.twin_id as string);
  const rank = o.twin_rank as number | null;

  if (o.twin_source === "db") {
    if (o.twin_beyond_recall) {
      // 态②：孪生不在池里、无名次
      if (rank !== null) throw new Error(`[golden-5cand] ${String(o.pid)}: beyond_recall=true 但 twin_rank=${JSON.stringify(rank)}`);
      if (containsTwin) throw new Error(`[golden-5cand] ${String(o.pid)}: beyond_recall=true 但 pool 含孪生 ${String(o.twin_id)}`);
    } else {
      // 态①：孪生在池内且名次自洽
      if (rank === null) throw new Error(`[golden-5cand] ${String(o.pid)}: beyond_recall=false 但 twin_rank=null`);
      if (rank > pool.length) throw new Error(`[golden-5cand] ${String(o.pid)}: twin_rank=${rank} 超出池长 ${pool.length}`);
      if (!containsTwin) throw new Error(`[golden-5cand] ${String(o.pid)}: twin_source=db 非 beyond 但 pool 不含孪生 ${String(o.twin_id)}`);
      if (pool[rank - 1]!.record_id !== o.twin_id) {
        throw new Error(`[golden-5cand] ${String(o.pid)}: twin_rank=${rank} 与池内容不符（该位置是 ${pool[rank - 1]!.record_id}）`);
      }
    }
  } else {
    // 态③：注入行必在池内落位处
    if (o.twin_beyond_recall) throw new Error(`[golden-5cand] ${String(o.pid)}: twin_source=injected 但 twin_beyond_recall=true`);
    if (rank === null) throw new Error(`[golden-5cand] ${String(o.pid)}: injected 态 twin_rank 不可为 null`);
    if (rank > pool.length) throw new Error(`[golden-5cand] ${String(o.pid)}: twin_rank=${rank} 超出池长 ${pool.length}`);
    if (pool[rank - 1]!.record_id !== o.twin_id) {
      throw new Error(`[golden-5cand] ${String(o.pid)}: injected 落位 ${rank} 与池内容不符（该位置是 ${pool[rank - 1]!.record_id}）`);
    }
  }
  return { pid: o.pid as string, twin_id: o.twin_id as string, twin_source: o.twin_source, twin_rank: o.twin_rank as number | null, twin_beyond_recall: o.twin_beyond_recall as boolean, pool };
}

/**
 * 加载并校验整个数据集：
 * - schema 版本、created_at、pairs 非空；
 * - pid 与金标 fixture **全量对齐**（无缺失、无多余、无重复）；
 * - 逐对结构 + twin 标记一致性校验（见 validateGolden5CandPair）。
 */
export function loadGolden5CandDataset(raw: unknown, golden: GoldenFixture): Golden5CandDataset {
  if (!raw || typeof raw !== "object") throw new Error("[golden-5cand] dataset 不是对象");
  const f = raw as Record<string, unknown>;
  if (f.schema !== GOLDEN_5CAND_SCHEMA) {
    throw new Error(`[golden-5cand] schema 必须为 "${GOLDEN_5CAND_SCHEMA}"，收到 ${JSON.stringify(f.schema)}`);
  }
  if (typeof f.created_at !== "string" || !f.created_at) throw new Error("[golden-5cand] 缺 created_at");
  if (!Array.isArray(f.pairs) || f.pairs.length === 0) throw new Error("[golden-5cand] pairs 必须为非空数组");
  const pairs = f.pairs.map(validateGolden5CandPair);
  const seen = new Set<string>();
  for (const p of pairs) {
    if (seen.has(p.pid)) throw new Error(`[golden-5cand] pid 重复: ${p.pid}`);
    seen.add(p.pid);
  }
  const goldenPids = new Set(golden.pairs.map((p) => p.pid));
  const missing = [...goldenPids].filter((pid) => !seen.has(pid));
  if (missing.length > 0) throw new Error(`[golden-5cand] 数据集缺少金标 pid: ${missing.slice(0, 5).join(",")}${missing.length > 5 ? ` 等 ${missing.length} 个` : ""}`);
  const extra = [...seen].filter((pid) => !goldenPids.has(pid));
  if (extra.length > 0) throw new Error(`[golden-5cand] 数据集多余 pid（金标之外）: ${extra.slice(0, 5).join(",")}${extra.length > 5 ? ` 等 ${extra.length} 个` : ""}`);
  return {
    schema: GOLDEN_5CAND_SCHEMA,
    created_at: f.created_at,
    source: (f.source ?? {}) as Record<string, unknown>,
    pairs,
  };
}
