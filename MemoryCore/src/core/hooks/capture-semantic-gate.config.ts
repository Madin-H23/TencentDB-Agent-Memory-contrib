/**
 * 票④b：捕获语义门配置（**零依赖**）。
 *
 * 单独成文件的原因：`config.ts` 需要在解析期拿到 `parseSemanticGateConfig`，
 * 而语义门 hook 模块运行时 import 了 `runLlmJudgment` / `formatBatchConflictPrompt`
 * 整条 l1-dedup 依赖链。若 config 直接 import hook 模块，等于配置解析被迫拉起
 * 蒸馏链（分层违规，且有潜在环）。本模块只依赖 TS 类型与常量，供两边共享。
 *
 * 解析语义（不变）：缺省/false → off；畸形值 **throw**（对齐
 * `parseRecallRankingConfig` 与 `extraction.dedupRecallRerank` 的拒绝先例：
 * 灰度开关静默回落会造成「以为开了实际没开」污染 shadow 观测口径）。
 */

export type SemanticGateMode = "off" | "shadow" | "on";

export interface CaptureSemanticGateConfig {
  /** off（缺省）=零 I/O；shadow=只计量不排除；on=真排除。 */
  mode: SemanticGateMode;
  /** 候选相似度阈值（score = 1 - distance），(0, 1]。 */
  threshold: number;
  /** 每条消息的 KNN 候选数。 */
  topK: number;
  /** 单条消息字符上限（码点），超限直接放行（不截断后判定）。 */
  maxMessageChars: number;
  /** 每批最多判定条数，其余放行（防提示词膨胀）。 */
  maxMessagesPerBatch: number;
  /** 判定 LLM 超时（毫秒）。 */
  judgeTimeoutMs: number;
  /** 批量 embed 超时（毫秒）。 */
  embeddingTimeoutMs: number;
}

/** 默认值（SPEC §4）。threshold 取 BGE-M3 离线标定 0.78。 */
export const CAPTURE_SEMANTIC_GATE_DEFAULTS: Readonly<CaptureSemanticGateConfig> = Object.freeze({
  mode: "off",
  threshold: 0.78,
  topK: 5,
  maxMessageChars: 2000,
  maxMessagesPerBatch: 5,
  judgeTimeoutMs: 15_000,
  embeddingTimeoutMs: 5_000,
});

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** 解析 `extraction.captureSemanticGate`（畸形值 throw，不静默回落）。 */
export function parseSemanticGateConfig(raw: unknown): CaptureSemanticGateConfig {
  if (raw === undefined || raw === false) return { ...CAPTURE_SEMANTIC_GATE_DEFAULTS };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `[config] extraction.captureSemanticGate 非法类型 ${raw === null ? "null" : typeof raw}（合法：缺省/false=off、{mode,threshold,...}）`,
    );
  }
  const o = raw as Record<string, unknown>;
  const out: CaptureSemanticGateConfig = { ...CAPTURE_SEMANTIC_GATE_DEFAULTS };

  if (o.mode !== undefined) {
    if (o.mode !== "off" && o.mode !== "shadow" && o.mode !== "on") {
      throw new Error(`[config] extraction.captureSemanticGate.mode 非法值 ${String(o.mode)}（合法：off|shadow|on）`);
    }
    out.mode = o.mode;
  }
  if (o.threshold !== undefined) {
    if (!isFiniteNumber(o.threshold) || o.threshold <= 0 || o.threshold > 1) {
      throw new Error(`[config] extraction.captureSemanticGate.threshold 非法值 ${String(o.threshold)}（须满足 0 < threshold ≤ 1）`);
    }
    out.threshold = o.threshold;
  }
  if (o.topK !== undefined) {
    if (!isFiniteNumber(o.topK) || o.topK <= 0 || !Number.isInteger(o.topK)) {
      throw new Error(`[config] extraction.captureSemanticGate.topK 非法值 ${String(o.topK)}（须为正整数）`);
    }
    out.topK = o.topK;
  }
  if (o.maxMessageChars !== undefined) {
    if (!isFiniteNumber(o.maxMessageChars) || o.maxMessageChars <= 0) {
      throw new Error(`[config] extraction.captureSemanticGate.maxMessageChars 非法值 ${String(o.maxMessageChars)}（须 > 0）`);
    }
    out.maxMessageChars = o.maxMessageChars;
  }
  if (o.maxMessagesPerBatch !== undefined) {
    if (!isFiniteNumber(o.maxMessagesPerBatch) || o.maxMessagesPerBatch <= 0 || !Number.isInteger(o.maxMessagesPerBatch)) {
      throw new Error(`[config] extraction.captureSemanticGate.maxMessagesPerBatch 非法值 ${String(o.maxMessagesPerBatch)}（须为正整数）`);
    }
    out.maxMessagesPerBatch = o.maxMessagesPerBatch;
  }
  if (o.judgeTimeoutMs !== undefined) {
    if (!isFiniteNumber(o.judgeTimeoutMs) || o.judgeTimeoutMs <= 0) {
      throw new Error(`[config] extraction.captureSemanticGate.judgeTimeoutMs 非法值 ${String(o.judgeTimeoutMs)}（须 > 0）`);
    }
    out.judgeTimeoutMs = o.judgeTimeoutMs;
  }
  if (o.embeddingTimeoutMs !== undefined) {
    if (!isFiniteNumber(o.embeddingTimeoutMs) || o.embeddingTimeoutMs <= 0) {
      throw new Error(`[config] extraction.captureSemanticGate.embeddingTimeoutMs 非法值 ${String(o.embeddingTimeoutMs)}（须 > 0）`);
    }
    out.embeddingTimeoutMs = o.embeddingTimeoutMs;
  }
  return out;
}
