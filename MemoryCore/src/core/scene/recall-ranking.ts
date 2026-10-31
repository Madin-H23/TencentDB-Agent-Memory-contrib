/**
 * 票⑦（exp/p1-7-recall-ranking）：召回多信号排序 —— **纯模块、零 I/O、可直测**。
 *
 * 设计（P1 票⑦，TICKETS-P1-20261031.md）：
 *
 *   score = (w1·norm(heat) + w2·2^(-age/halfLife) + w3·relevance + w4·norm(uses)) / Σw
 *
 * - 背景：召回导航此前仅热度单信号（heat 降序），无时间衰减——低热场景永远沉底、
 *   高热但陈旧的场景常驻前排。本模块给召回排序加「新近」维度（Ebbinghaus 式指数
 *   衰减）与「使用计数」维度，并把相关性作为可接入的第四信号。
 * - 灰度：`persona.recallRanking`，默认 **off**。off 时接线层不传 ranking，全部召回
 *   面输出顺序与基线逐字节一致（off 兼容钉见 scene-navigation.ranking.test.ts）。
 *
 * 信号口径（L2 场景导航面）：
 * - norm(heat)/norm(uses)：集合内 log1p 归一（log1p(v)/log1p(max)，选型依据见
 *   logNorm 注）。归一是集合相对口径——只影响同一输入集合内的相对次序，确定性由
 *   「同输入同输出」保证；max 随集合变化属设计内行为（与 off 的全局 heat 排序口径
 *   不同，on 时排序本来就是新口径）。
 * - age：距 META.updated 的天数。updated 是「最近一次被抽取/合并触达」的时间戳，
 *   是现库可得的最近激活代理。缺省/畸形 → 按 epoch 0（最老）处理，与 heat 缺省回 0
 *   的保守方向一致；未来时间戳（时钟偏斜）→ 钳 0，不产生负龄放大。
 * - relevance：纯导航场景无查询文本 → 恒 1（对所有条目等量平移，不改变相对次序，
 *   等价于把 w3 从权重里暂时移除）；有查询的召回面接线时传入真实相关性即可生效，
 *   无需改本模块（w3 已在公式与配置面就位）。
 * - uses：现库无独立使用计数字段——L2 的 heat 即「被记忆命中的累计次数」（nav footer
 *   语义），故场景导航面 uses=heat（w1/w4 同源合并生效，w4 默认小权重避免双重计入）。
 *   未来出现独立使用计数（如读触达计数）时改接线即可，纯函数已按独立信号设计。
 *
 * 默认权重与依据：w1=0.35（热度=既有主信号，保留最大权重但不过半）、w2=0.30（新近，
 * halfLifeDays=30：月级陈旧衰减一半，周级内容基本无损，与在役 L2 日-周级更新节奏
 * 匹配）、w3=0.25（相关性，导航面暂不区分，预留有查询面）、w4=0.10（使用计数，与
 * w1 同源故低配）。等价合成效果：热度主导（0.45）+ 新近次之（0.30）——新鲜度足以
 * 在「可比热度带」内重排次序，但不至于把 500× 热度鸿沟整体抹平（排序纯函数测试
 * 对两种方向都有显式断言）。
 *
 * 确定性与平票：排序键 = score 降序 → heat 降序 → 输入原序（ES2019 稳定语义显式
 * 化为次级键）。同输入数组恒同输出；全同分全同热时保持输入顺序，不抖动。
 *
 * 畸形配置语义（parseRecallRankingConfig）：负权重/NaN/±Infinity/halfLifeDays≤0/
 * 全零权重/非布尔非对象类型 → **拒绝（throw）**，不静默回落——灰度开关静默回落会让
 * 「以为开了实际没开」污染 A/B 解读（与 extraction.dedupRecallRerank 的结构化开关
 * 拒绝先例一致）。超大有限权重接受：得分按 Σw 归一，只有比例有效。
 *
 * 观测锚点：on 时由接线层经 onRanked 回调打一行（formatRecallRankAnchor 生成）：
 *   `[memory-tdai] [recall-rank] metric=l2_recall_rank value=1 scenes=<n> signals=w1:..;w2:..;w3:..;w4:..;halfLifeDays:..`
 * off 时接线层不传 ranking → 锚点零输出。
 */

import type { SceneIndexEntry } from "./scene-index.js";

const DAY_MS = 86_400_000;

export interface ResolvedRecallRanking {
  /** 热度归一权重 */
  w1: number;
  /** 指数衰减新近权重 */
  w2: number;
  /** 相关性权重（纯导航面 relevance 恒 1，不区分次序；有查询面接线后生效） */
  w3: number;
  /** 使用计数权重（场景导航面 uses=heat 同源，见模块头） */
  w4: number;
  /** 新近半衰期（天）：age=halfLifeDays 时衰减分=0.5 */
  halfLifeDays: number;
}

export const RECALL_RANKING_DEFAULTS: ResolvedRecallRanking = {
  w1: 0.35,
  w2: 0.3,
  w3: 0.25,
  w4: 0.1,
  halfLifeDays: 30,
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * 解析 `persona.recallRanking` 原始配置：
 * - undefined / false → undefined（off）
 * - true → 默认权重
 * - 对象 → 缺省字段回落默认值，非法字段值 throw（报文含 recallRanking.<字段>）
 * - 其余类型 → throw（拒绝，不静默回落）
 */
export function parseRecallRankingConfig(raw: unknown): ResolvedRecallRanking | undefined {
  if (raw === undefined || raw === false) return undefined;
  if (raw === true) return { ...RECALL_RANKING_DEFAULTS };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `[config] persona.recallRanking 非法类型 ${typeof raw}（合法：缺省/false=off、true=默认权重、{w1,w2,w3,w4,halfLifeDays}）`,
    );
  }
  const obj = raw as Record<string, unknown>;
  const out: ResolvedRecallRanking = { ...RECALL_RANKING_DEFAULTS };
  for (const key of ["w1", "w2", "w3", "w4"] as const) {
    const v = obj[key];
    if (v === undefined) continue;
    if (!isFiniteNumber(v) || v < 0) {
      throw new Error(`[config] persona.recallRanking.${key} 非法值 ${String(v)}（须为非负有限数）`);
    }
    out[key] = v;
  }
  const hl = obj.halfLifeDays;
  if (hl !== undefined) {
    if (!isFiniteNumber(hl) || hl <= 0) {
      throw new Error(`[config] persona.recallRanking.halfLifeDays 非法值 ${String(hl)}（须为正有限数）`);
    }
    out.halfLifeDays = hl;
  }
  if (out.w1 + out.w2 + out.w3 + out.w4 <= 0) {
    throw new Error("[config] persona.recallRanking 全零权重无排序意义（至少一个权重须 > 0）");
  }
  return out;
}

/** Ebbinghaus 式指数衰减新近分：2^(-age/halfLife)——age=0 → 1，age=halfLife → 0.5；负龄钳 0。 */
export function recallRecency(ageDays: number, halfLifeDays: number): number {
  return Math.exp(-(Math.LN2 * Math.max(0, ageDays)) / halfLifeDays);
}

/**
 * log1p 归一：log1p(v)/log1p(max) ∈ [0,1]（max≤0 → 全 0）。
 *
 * 选 log1p 而非 min-max 的依据（设计取舍）：heat 是「每次命中 +1」的指数增长累计
 * 计数，长寿命场景自然积累出量级差——min-max 会把 14× 的线性量级差铺满 [0,1]，
 * 且产生「集合最小者 norm 恒 0、永不可越最大者」的地板伪影（w1+w4>0 结构性封死
 * 新近信号的可达性）；log1p 压缩量级（数量级差≈线性小差）、保单调、无地板，
 * 新近信号在全部热度带可达。集合相对口径（max 随输入集合变化）=确定性由
 * 「同输入同输出」保证，见模块头。
 */
export function logNorm(value: number, maxValue: number): number {
  if (maxValue <= 0) return 0;
  const v = Math.log1p(Math.max(0, value)) / Math.log1p(maxValue);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** META.updated（ISO 字符串）→ 天龄；缺省/畸形 → epoch 0（最老）；未来 → 0。 */
export function updatedToAgeDays(updated: string | undefined, nowMs: number): number {
  const ms = updated ? Date.parse(updated) : Number.NaN;
  const base = Number.isFinite(ms) ? ms : 0;
  return Math.max(0, (nowMs - base) / DAY_MS);
}

/** 归一化后的四信号分部。 */
export interface NormedRecallParts {
  normHeat: number;
  recency: number;
  relevance: number;
  normUses: number;
}

/** 加权合成（按 Σw 归一——权重整体缩放不改变得分）。 */
export function scoreRecallParts(parts: NormedRecallParts, ranking: ResolvedRecallRanking): number {
  const sum = ranking.w1 + ranking.w2 + ranking.w3 + ranking.w4;
  return (
    (ranking.w1 * parts.normHeat +
      ranking.w2 * parts.recency +
      ranking.w3 * parts.relevance +
      ranking.w4 * parts.normUses) /
    sum
  );
}

/**
 * 场景导航多信号排序（纯函数：不改输入数组、不产生 I/O）。
 *
 * - uses=heat（现库无独立使用计数字段，见模块头）；relevance=1（纯导航无查询）。
 * - 非有限 heat → 按 0 参与归一（parseSceneBlock 的 `parseInt||0` 已兜一层，这里
 *   防御 NaN/Infinity 毒化比较——NaN 参与比较会使排序结果实现相关，违反确定性）。
 * - 排序键：score 降序 → heat 降序 → 输入原序（平票确定性，见模块头）。
 */
export function rankSceneEntries(
  entries: SceneIndexEntry[],
  ranking: ResolvedRecallRanking,
  nowMs: number,
): SceneIndexEntry[] {
  if (entries.length === 0) return [];
  const sanitized = entries.map((e) => (Number.isFinite(e.heat) ? e.heat : 0));
  let hMax = sanitized[0]!;
  for (const h of sanitized) {
    if (h > hMax) hMax = h;
  }
  const scored = entries.map((e, i) => {
    const heat = sanitized[i]!;
    const parts: NormedRecallParts = {
      normHeat: logNorm(heat, hMax),
      recency: recallRecency(updatedToAgeDays(e.updated, nowMs), ranking.halfLifeDays),
      // 纯导航场景无查询文本 → relevance 恒 1（等量平移不改次序）；有查询面接线时
      // 在此传入真实相关性即可。
      relevance: 1,
      normUses: logNorm(heat, hMax),
    };
    return { e, i, heat, score: scoreRecallParts(parts, ranking) };
  });
  scored.sort((a, b) => (b.score - a.score) || (b.heat - a.heat) || (a.i - b.i));
  return scored.map((s) => s.e);
}

/**
 * 观测锚点行（不含日志前缀；接线层补 `[memory-tdai] [recall-rank] `）：
 * `metric=l2_recall_rank value=1 scenes=<n> signals=w1:..;w2:..;w3:..;w4:..;halfLifeDays:..`
 */
export function formatRecallRankAnchor(ranking: ResolvedRecallRanking, sceneCount: number): string {
  return (
    `metric=l2_recall_rank value=1 scenes=${sceneCount} ` +
    `signals=w1:${ranking.w1};w2:${ranking.w2};w3:${ranking.w3};w4:${ranking.w4};halfLifeDays:${ranking.halfLifeDays}`
  );
}
