/**
 * M1 D3 小金标 fixture 加载与校验（golden set loader）。
 *
 * fixture 由 `scripts/golden-gen.py` + `scripts/golden-attribute.ts` 生成候选对，
 * 用户一判 + 子代理二判标注后合入 `__fixtures__/m1-dedup-golden.json`（schema v1）。
 * 用途：D1 提示词 A/B 回放（只评端到端判定：召回+判定）、precision/recall 度量、
 * κ 一致性度量。**不得**用于单独评召回排序（二审设计）。
 *
 * 标注口径（一句话）：「同一事实/规则/偏好/事件的不同措辞或互补阶段 = 应合并；
 * 同主题不同事实/对象/时间点的独立事件 = 不应合并；信息演进 = 应 update」。
 * answer_* 取值：merge | store | update | skip（skip=无法判断，不进 κ 统计）。
 */

export type GoldenAnswer = "merge" | "store" | "update" | "skip";
export type GoldenBand = "exact" | "0.85+" | "0.70-0.85" | "0.60-0.70" | "neg";
export type GoldenSubset = "high-sim" | "neg-same-scene" | "neg-random";
export type GoldenBucket = "top-5" | "6-10" | "11-50" | "50+" | "absent" | "no_query";

export interface GoldenPair {
  pid: string;
  band: GoldenBand;
  subset: GoldenSubset;
  /** 词汇相似度（neg 子集允许 null——未精算） */
  sim: number | null;
  /** older 在 newer 内容的生产 FTS 链中的名次（-1=absent） */
  rank_older: number;
  rank_bucket: GoldenBucket;
  type_older: string;
  type_newer: string;
  content_older: string;
  content_newer: string;
  /** 用户一判（标注责任人） */
  answer_user: GoldenAnswer;
  /** 子代理二判（盲于来源分布） */
  answer_judge2?: GoldenAnswer;
  /** 终裁（两判分歧时由用户定）；缺省时按 answer_user */
  final?: GoldenAnswer;
}

export interface GoldenFixture {
  schema: "m1-dedup-golden/v1";
  created_at: string;
  source: Record<string, unknown>;
  pairs: GoldenPair[];
}

const BANDS: GoldenBand[] = ["exact", "0.85+", "0.70-0.85", "0.60-0.70", "neg"];
const SUBSETS: GoldenSubset[] = ["high-sim", "neg-same-scene", "neg-random"];
const BUCKETS: GoldenBucket[] = ["top-5", "6-10", "11-50", "50+", "absent", "no_query"];
const ANSWERS: GoldenAnswer[] = ["merge", "store", "update", "skip"];

function enumErr(field: string, value: unknown, allowed: readonly string[]): Error {
  return new Error(`[golden] ${field} 非法: ${JSON.stringify(value)}（合法: ${allowed.join("|")}）`);
}

/** 校验并归一化单对（抛错带字段名；纯函数可直测）。 */
export function validateGoldenPair(p: unknown): GoldenPair {
  if (!p || typeof p !== "object") throw new Error("[golden] pair 不是对象");
  const o = p as Record<string, unknown>;
  for (const f of ["pid", "band", "subset", "type_older", "type_newer", "content_older", "content_newer", "answer_user"]) {
    if (typeof o[f] !== "string" || !(o[f] as string).trim()) {
      throw new Error(`[golden] 缺字段或为空: ${f}`);
    }
  }
  if (!BANDS.includes(o.band as GoldenBand)) throw enumErr("band", o.band, BANDS);
  if (!SUBSETS.includes(o.subset as GoldenSubset)) throw enumErr("subset", o.subset, SUBSETS);
  if (!BUCKETS.includes(o.rank_bucket as GoldenBucket)) throw enumErr("rank_bucket", o.rank_bucket, BUCKETS);
  if (!ANSWERS.includes(o.answer_user as GoldenAnswer)) throw enumErr("answer_user", o.answer_user, ANSWERS);
  if (o.answer_judge2 !== undefined && !ANSWERS.includes(o.answer_judge2 as GoldenAnswer)) {
    throw enumErr("answer_judge2", o.answer_judge2, ANSWERS);
  }
  if (o.final !== undefined && !ANSWERS.includes(o.final as GoldenAnswer)) throw enumErr("final", o.final, ANSWERS);
  // 名次语义：-1=absent，>=1=真实名次；0 无意义，拒
  if (typeof o.rank_older !== "number" || !Number.isInteger(o.rank_older) || o.rank_older < -1 || o.rank_older === 0) {
    throw new Error(`[golden] rank_older 必须为 -1 或 >=1 的整数，收到 ${JSON.stringify(o.rank_older)}`);
  }
  if (o.sim !== null && (typeof o.sim !== "number" || !Number.isFinite(o.sim) || o.sim < 0 || o.sim > 1)) {
    throw new Error(`[golden] sim 必须为 [0,1] 或 null，收到 ${JSON.stringify(o.sim)}`);
  }
  // rank_older 与 bucket 一致性（-1 必须 absent；>0 必须非 absent）
  if (o.rank_older === -1 && o.rank_bucket !== "absent") {
    throw new Error(`[golden] ${o.pid}: rank_older=-1 但 bucket=${String(o.rank_bucket)}`);
  }
  if (o.rank_older > 0 && o.rank_bucket === "absent") {
    throw new Error(`[golden] ${o.pid}: rank_older=${o.rank_older} 但 bucket=absent`);
  }
  return o as unknown as GoldenPair;
}

/** 加载并校验整个 fixture（pid 唯一性 + schema 版本）。 */
export function loadGoldenFixture(raw: unknown): GoldenFixture {
  if (!raw || typeof raw !== "object") throw new Error("[golden] fixture 不是对象");
  const f = raw as Record<string, unknown>;
  if (f.schema !== "m1-dedup-golden/v1") {
    throw new Error(`[golden] schema 必须为 "m1-dedup-golden/v1"，收到 ${JSON.stringify(f.schema)}`);
  }
  if (typeof f.created_at !== "string" || !f.created_at) throw new Error("[golden] 缺 created_at");
  if (!Array.isArray(f.pairs) || f.pairs.length === 0) throw new Error("[golden] pairs 必须为非空数组");
  const pairs = f.pairs.map(validateGoldenPair);
  const seen = new Set<string>();
  for (const p of pairs) {
    if (seen.has(p.pid)) throw new Error(`[golden] pid 重复: ${p.pid}`);
    seen.add(p.pid);
  }
  return { schema: "m1-dedup-golden/v1", created_at: f.created_at, source: (f.source ?? {}) as Record<string, unknown>, pairs };
}

/** 双判重叠子集（两判都有且非 skip 的对）——κ 的统计基础。 */
export function agreementSubset(pairs: GoldenPair[]): GoldenPair[] {
  return pairs.filter(
    (p) => p.answer_user !== "skip" && p.answer_judge2 !== undefined && p.answer_judge2 !== "skip",
  );
}

/** 终裁答案（缺省 final 时按 answer_user）。 */
export function finalAnswer(p: GoldenPair): GoldenAnswer {
  return p.final ?? p.answer_user;
}

/**
 * Cohen's kappa（二分类：应合并[merge/update] vs 不应合并[store]；skip 已由
 * agreementSubset 剔除）。观测一致率极低（<0.2 或 >0.8）时返回 null（κ 在此区间
 * 对边际分布过度敏感，报一致率更诚实）。
 */
export function cohensKappa(pairs: GoldenPair[]): number | null {
  const n = pairs.length;
  if (n === 0) return null;
  const bin = (a: GoldenAnswer) => (a === "merge" || a === "update" ? "M" : "S");
  let both = 0;
  let uM = 0;
  let jM = 0;
  for (const p of pairs) {
    const u = bin(p.answer_user);
    const j = bin(p.answer_judge2!);
    if (u === "M") uM++;
    if (j === "M") jM++;
    if (u === j) both++;
  }
  const po = both / n;
  const pe = ((uM / n) * (jM / n)) + (((n - uM) / n) * ((n - jM) / n));
  if (pe >= 0.8 || pe <= 0.2) return null;
  return (po - pe) / (1 - pe);
}
