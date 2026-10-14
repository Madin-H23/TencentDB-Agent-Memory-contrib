/**
 * D2 召回轻修（2026-10-14，v2 4db48bf 移植）：词汇相似度重排 + 归一化指纹。**纯函数、可直测**。
 *
 * 背景（v2 M1 归因实验 + 一审裁定）：查重候选召回走 FTS 排序 slice topK，
 * IDF 覆盖度/BM25 序会把「同义不同词」的真重复挤出 top-5（占新增重复的
 * topK 截断 21% + 排序挤出 10%）。本模块提供：
 *
 * 1. `rerankCandidatesBySimilarity`：对超额候选按「新记忆 vs 候选」的字符
 *    4-gram Jaccard 重排，取 top-K 进候选池——把 6-10 名外的真重复捞回来。
 *    纯词汇计算（毫秒级），**不增大 LLM prompt 体积**（超额在 store 层截断），
 *    避开 step-5 系 dedup 超时链（一审风险 3）。
 * 2. `normalizeForFingerprint` / `fingerprintOf`：归一化（去空白标点）后 sha1。
 *    归一化口径与工作区审计脚本 `l1_pairs.py` 逐字一致（同文判定才可跨工具对账）。
 *
 * 不引入 embedding 供应商、不做向量 RRF（无 embedding 配置下为空操作，一审裁定）。
 */

import { createHash } from "node:crypto";

/** D2 召回轻修开关：none=旧行为（召回序 slice topK）；lexical=超额召回+词汇重排。 */
export type DedupRecallRerank = "none" | "lexical";

const NGRAM = 4;

/** 归一化：去空白与中英文标点。与 scripts/l1_pairs.py 的 normalize() 同口径。 */
export function normalizeForFingerprint(content: string): string {
  return String(content ?? "").replace(/[\s，。；：、！？!?:;,.'"（）()\-—_/·]+/g, "");
}

/** 内容指纹：归一化后 sha1 hex；归一化为空（空/纯标点）→ null（不参与直查）。 */
export function fingerprintOf(content: string): string | null {
  const norm = normalizeForFingerprint(content);
  if (!norm) return null;
  return createHash("sha1").update(norm, "utf8").digest("hex");
}

function ngrams(t: string): Set<string> {
  return t.length >= NGRAM
    ? new Set(Array.from({ length: t.length - NGRAM + 1 }, (_, i) => t.slice(i, i + NGRAM)))
    : new Set([t]);
}

export interface RecallCandidate {
  id: string;
  content: string;
}

/**
 * 按词汇相似度（字符 4-gram Jaccard）对候选重排，取前 topK。
 * 纯函数：不改输入顺序（调用方仍持有召回原序）；同分保持原序（V8 sort 稳定）。
 */
export function rerankCandidatesBySimilarity<T extends RecallCandidate>(
  newContent: string,
  candidates: T[],
  topK: number,
): T[] {
  const k = Math.max(0, topK);
  if (k === 0) return [];
  if (candidates.length <= 1) return candidates.slice(0, k);
  const q = ngrams(normalizeForFingerprint(newContent));
  const scored = candidates.map((c, i) => {
    const cg = ngrams(normalizeForFingerprint(c.content));
    let inter = 0;
    for (const g of q) if (cg.has(g)) inter++;
    const union = q.size + cg.size - inter;
    return { c, i, sim: union > 0 ? inter / union : 0 };
  });
  scored.sort((a, b) => (b.sim - a.sim) || (a.i - b.i)); // 相似度降序，同分保召回原序
  return scored.slice(0, k).map((s) => s.c);
}
