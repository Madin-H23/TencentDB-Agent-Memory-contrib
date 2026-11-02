/**
 * 票④b：捕获语义门（SPEC v2 §5）。
 *
 * 目标：捕获时识别「L0 以新措辞复述在案 L1 事实」的改写型重投——票④ hash 门
 * 接不住的形态。两段式：
 *   ① 消息现算向量（不依赖 l0_vec，L0 延迟嵌入可能落后）→ `searchL1Vector` KNN；
 *   ② 只有 score = 1 - distance ≥ threshold 的候选才进 LLM 判定（复用 M1 判定链）。
 *
 * 关键约束（SPEC §2.6 / §6 / §11）：
 * - **不复用 `batchDedup`**：它会二次 embed + 二次 KNN；这里直接
 *   `formatBatchConflictPrompt` + `runLlmJudgment`。
 * - `searchL1Vector` 本身无阈值（score=1-distance、按 topK 截断），阈值过滤在本模块内做。
 * - 只消费 `action === "skip"`；store/update/merge 一律放行，且绝不落库。
 * - 任一步异常/超时/维度不符/表未建/空向量 → **整批放行 + failopen=true**。
 * - key 不进日志：所有错误串经 `redactError`。
 * - `mode=shadow`：完整执行并计数，但 `excludedMessageIds` 恒空（真排除只发生在 on）。
 */

import type { MemoryPromptMode } from "../../config.js";
import { hasClientEmbedding, type EmbeddingService } from "../store/embedding.js";
import type { IMemoryStore, IsolationFilter, L1SearchResult } from "../store/types.js";
import type { ExtractedMemory, MemoryRecord, DedupDecision, MemoryType } from "../record/l1-writer.js";
import { runLlmJudgment } from "../record/l1-dedup.js";
import { formatBatchConflictPrompt, type CandidateMatch } from "../prompts/l1-dedup.js";
import type { LLMRunner, Logger } from "../types.js";
import { redactError } from "../../utils/redact-secrets.js";

const TAG = "[memory-tdai][capture-semantic-gate]";

// ============================
// Config
// ============================

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

/**
 * 解析 `extraction.captureSemanticGate`。
 *
 * 畸形值 **throw**（对齐 `parseRecallRankingConfig` 与
 * `extraction.dedupRecallRerank` 的拒绝先例）：灰度开关静默回落会造成
 * 「以为开了实际没开」污染 shadow 观测口径。
 */
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

// ============================
// Inert（能力缺失）锚点去重
// ============================

const inertLoggedReasons = new Set<string>();

/**
 * 能力缺失（provider=none / 无 vectorStore / 无 judge / 表未建）时，
 * 每个原因每进程只打一次 inert 锚点——成功路径每次捕获都会执行，
 * 不去重会按捕获频率刷屏。
 */
export function shouldLogSemanticGateInertOnce(reason: string): boolean {
  if (inertLoggedReasons.has(reason)) return false;
  inertLoggedReasons.add(reason);
  return true;
}

/** 仅测试用：重置 inert 去重状态。 */
export function resetSemanticGateInertLogForTests(): void {
  inertLoggedReasons.clear();
}

// ============================
// Evaluate
// ============================

/** 待判定的 L0 消息（消息级，不含批次语义）。 */
export interface SemanticGateMessage {
  id: string;
  content: string;
  role?: string;
}

export interface SemanticGateDeps {
  /** shadow=只计数不排除；on=skip 进 excludedMessageIds；off 不应被调用。 */
  mode: SemanticGateMode;
  embeddingService: EmbeddingService;
  vectorStore: IMemoryStore;
  /** 判定 runner（tdai-core 既有 L1 assembly 注入，不新建 runner）。 */
  judge: LLMRunner;
  threshold: number;
  topK: number;
  maxMessageChars: number;
  maxMessagesPerBatch: number;
  judgeTimeoutMs: number;
  embeddingTimeoutMs: number;
  /** 隔离 filter（透传 searchL1Vector；单租户部署可不传）。 */
  filter?: IsolationFilter;
  logger?: Logger;
  /** 判定 prompt 家族（默认 chat）。 */
  promptMode?: MemoryPromptMode;
}

export interface SemanticGateResult {
  /** 命中 skip 且 mode=on 的消息 id；shadow 恒空。 */
  excludedMessageIds: Set<string>;
  /** 有 ≥1 个达阈值候选的消息数。 */
  candidates: number;
  /** 判定为 skip 的消息数（shadow 也计数）。 */
  hits: number;
  /** 超长直接放行的消息数。 */
  oversize: number;
  /** 因每批上限未判定的消息数。 */
  capped: number;
  /** 本批检索到的最高相似度（未过阈值也计入）。 */
  topScore: number;
  /** 任一环节失败 → true（该批全部放行）。 */
  failopen: boolean;
}

/**
 * 构造判定链所需的伪记忆（仅提示词消费字段，不落库）。
 * 字段对齐 `ExtractedMemory & {record_id}`；`record_id` 前缀 `sem_` 供回映射。
 */
export function toPseudoMemory(msg: SemanticGateMessage): ExtractedMemory & { record_id: string } {
  return {
    record_id: `sem_${msg.id}`,
    content: msg.content,
    type: "episodic",
    priority: 0,
    source_message_ids: [msg.id],
    metadata: {},
    scene_name: "",
  };
}

/** L1 向量检索结果 → 判定 prompt 的候选记忆形状。 */
function toMemoryRecord(hit: L1SearchResult): MemoryRecord {
  let metadata: MemoryRecord["metadata"] = {};
  if (hit.metadata_json) {
    try {
      metadata = JSON.parse(hit.metadata_json) as MemoryRecord["metadata"];
    } catch {
      metadata = {};
    }
  }
  return {
    id: hit.record_id,
    content: hit.content,
    type: hit.type as MemoryType,
    priority: hit.priority,
    scene_name: hit.scene_name,
    source_message_ids: [],
    metadata,
    timestamps: [hit.timestamp_str].filter(Boolean),
    createdAt: "",
    updatedAt: "",
    sessionKey: hit.session_key,
    sessionId: hit.session_id,
  };
}

/** 码点长度（emoji 按 1 计，与 JS UTF-16 .length 区分）。 */
function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** 给 promise 加硬超时；同时吞掉超时后原 promise 的迟到拒绝（防 unhandled）。 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 标记迟到拒绝为已处理
  void promise.catch(() => {});
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * 执行一次语义门判定（纯编排，无全局可变状态；并发批次互不影响）。
 *
 * @returns 结构化结果；失败时 `failopen=true` 且排除集合为空。
 */
export async function evaluateSemanticGate(
  messages: SemanticGateMessage[],
  deps: SemanticGateDeps,
): Promise<SemanticGateResult> {
  const result: SemanticGateResult = {
    excludedMessageIds: new Set<string>(),
    candidates: 0,
    hits: 0,
    oversize: 0,
    capped: 0,
    topScore: 0,
    failopen: false,
  };
  const logger = deps.logger;

  const failopen = (reason: string, err?: unknown): SemanticGateResult => {
    result.failopen = true;
    result.excludedMessageIds.clear();
    result.hits = 0;
    const detail = err === undefined ? "" : ` err=${redactError(err)}`;
    logger?.warn?.(`${TAG} metric=capture_semantic_gate status=failopen reason=${reason}${detail}`);
    return result;
  };

  // ① 长度守卫：超长直接放行（不截断后判定）
  const eligible: SemanticGateMessage[] = [];
  for (const m of messages) {
    if (typeof m?.content !== "string" || m.content.length === 0) continue;
    if (codePointLength(m.content) > deps.maxMessageChars) {
      result.oversize++;
      continue;
    }
    eligible.push(m);
  }
  if (eligible.length === 0) return result;

  // ② 每批上限：其余放行
  const judged = eligible.slice(0, deps.maxMessagesPerBatch);
  result.capped = eligible.length - judged.length;

  // 前置能力闸：无客户端 embedder / 向量表未建 → inert（整批放行）
  if (!hasClientEmbedding(deps.embeddingService)) return failopen("no_client_embedding");
  try {
    const caps = typeof deps.vectorStore.getCapabilities === "function"
      ? deps.vectorStore.getCapabilities()
      : undefined;
    if (caps && caps.vectorSearch === false) return failopen("no_vec_table");
  } catch (err) {
    return failopen("capabilities_error", err);
  }

  // ③ 批量 embed（带超时）
  let vectors: Float32Array[];
  try {
    vectors = await withTimeout(
      deps.embeddingService.embedBatch(judged.map((m) => m.content), { timeoutMs: deps.embeddingTimeoutMs }),
      deps.embeddingTimeoutMs,
      "semantic-gate embedding",
    );
  } catch (err) {
    return failopen("embedding_failed", err);
  }

  // 维度/空向量校验（服务端返 1023 维、Noop 返空数组等）
  const expectedDims = typeof deps.embeddingService.getDimensions === "function"
    ? deps.embeddingService.getDimensions()
    : 0;
  if (!Array.isArray(vectors) || vectors.length !== judged.length) {
    return failopen("embedding_count_mismatch");
  }
  for (const vec of vectors) {
    if (!(vec instanceof Float32Array) || vec.length === 0) return failopen("empty_vector");
    if (expectedDims > 0 && vec.length !== expectedDims) {
      return failopen(`dim_mismatch expected=${expectedDims} got=${vec.length}`);
    }
  }

  // ④ KNN + 模块内阈值过滤（searchL1Vector 无内建阈值）
  const matches: CandidateMatch[] = [];
  for (let i = 0; i < judged.length; i++) {
    let hits: L1SearchResult[];
    try {
      hits = await deps.vectorStore.searchL1Vector(
        vectors[i]!,
        deps.topK,
        judged[i]!.content,
        deps.filter,
      );
    } catch (err) {
      return failopen("vector_search_failed", err);
    }
    if (!Array.isArray(hits)) return failopen("vector_search_bad_result");

    for (const h of hits) {
      if (typeof h?.score === "number" && Number.isFinite(h.score) && h.score > result.topScore) {
        result.topScore = h.score;
      }
    }
    const above = hits.filter((h) => typeof h?.score === "number" && h.score >= deps.threshold);
    if (above.length === 0) continue;
    result.candidates++;
    matches.push({ newMemory: toPseudoMemory(judged[i]!), candidates: above.map(toMemoryRecord) });
  }

  // 无候选 → 不调 LLM（SPEC §5：候选非空才判定）
  if (matches.length === 0) return result;

  // ⑤ 判定链：formatBatchConflictPrompt + runLlmJudgment（不调 batchDedup）
  //
  // 判定 runner 包一层脱敏：runLlmJudgment 内部的失败日志直接打印原始 err.message，
  // 若上游把 key 片段带进错误串会泄进日志；这里先擦除再让它冒泡（SPEC §6）。
  const safeJudge: LLMRunner = {
    run: async (params) => {
      try {
        return await deps.judge.run(params);
      } catch (err) {
        throw new Error(redactError(err));
      }
    },
  };
  let decisions: DedupDecision[];
  try {
    decisions = await withTimeout(
      runLlmJudgment(
        matches,
        matches.map((m) => m.newMemory),
        undefined,
        logger,
        undefined,
        deps.promptMode ?? "chat",
        safeJudge,
        undefined,
        deps.judgeTimeoutMs,
        // fail-fast=true：判定**调用失败**上抛（而非 runLlmJudgment 默认的静默
        // storeAll），语义门才能观测到并记 failopen=1；解析降级仍走 storeAll
        // （=放行），与「非法/缺失 action 一律放行」口径一致。
        true,
      ),
      deps.judgeTimeoutMs,
      "semantic-gate judge",
    );
  } catch (err) {
    return failopen("judge_failed", err);
  }
  if (!Array.isArray(decisions)) return failopen("judge_bad_result");

  // ⑥ 只消费 skip；其余动作一律放行
  const judgedIds = new Set(judged.map((m) => m.id));
  const skipped = new Set<string>();
  for (const d of decisions) {
    if (!d || d.action !== "skip" || typeof d.record_id !== "string") continue;
    if (!d.record_id.startsWith("sem_")) continue;
    const msgId = d.record_id.slice(4);
    if (judgedIds.has(msgId)) skipped.add(msgId);
  }
  result.hits = skipped.size;
  if (deps.mode === "on") {
    for (const id of skipped) result.excludedMessageIds.add(id);
  }
  // mode=shadow：完整计数但不排除（排除集合保持空）
  return result;
}
