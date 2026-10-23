/**
 * 内容归一化与指纹（2026-10-23 从 core/record/l1-recall-rerank.ts 外移）。
 *
 * 外移原因：store 层写路径（upsertL1 → content_fingerprint 列）需要派生指纹，
 * 而 store 对 record 此前只有 `import type`；把纯函数放 utils 由 record 与 store
 * 共享，避免 store → record 的运行时依赖成环。
 *
 * 口径不变：与 scripts/l1_pairs.py 的 normalize() 逐字一致（同文判定可跨工具对账）；
 * l1-recall-rerank.ts 保留同名再导出，既有调用方零改动。
 */
import { createHash } from "node:crypto";

/** 归一化：去空白与中英文标点。与 scripts/l1_pairs.py 的 normalize() 同口径。 */
export function normalizeForFingerprint(content: string): string {
  return String(content ?? "").replace(/[\s，。；：、！？!?:;,.'"（）()\-—_/·]+/g, "");
}

/**
 * 归一化文本 → sha1 hex 指纹；空（空/纯标点）→ null（不参与直查）。
 * 供已持有归一化结果的调用方（如 l1-extractor 写入前守卫）免二次归一化；
 * 与 fingerprintOf 恒等：fingerprintOfNormalized(normalizeForFingerprint(c)) === fingerprintOf(c)。
 */
export function fingerprintOfNormalized(norm: string): string | null {
  if (!norm) return null;
  return createHash("sha1").update(norm, "utf8").digest("hex");
}

/** 内容指纹：归一化后 sha1 hex；归一化为空（空/纯标点）→ null（不参与直查）。 */
export function fingerprintOf(content: string): string | null {
  return fingerprintOfNormalized(normalizeForFingerprint(content));
}
