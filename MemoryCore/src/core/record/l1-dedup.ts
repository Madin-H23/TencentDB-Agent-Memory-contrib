/**
 * L1 Memory Conflict Detection (Batch Mode): decides how to handle multiple new
 * memories against existing records in a single LLM call.
 *
 * Candidate recall uses the same strategy as memory_search (native hybrid, else
 * FTS ∥ client-vector + RRF). Isolation stays session-scoped via IsolationFilter;
 * search's cross-session filter is not reused.
 *
 * If neither FTS, client embedding, nor native hybrid is available, conflict
 * detection is skipped — all memories go straight to store.
 *
 * Two-phase approach:
 * 1. Candidate search per new memory (fast, no LLM)
 * 2. Batch LLM judgment on all new memories + their candidate pools (single call)
 */

import type { MemoryPromptMode } from "../../config.js";
import type { ExtractedMemory, MemoryRecord, DedupDecision, MemoryType } from "./l1-writer.js";
import { formatBatchConflictPrompt, getConflictDetectionSystemPrompt } from "../prompts/l1-dedup.js";
import type { CandidateMatch } from "../prompts/l1-dedup.js";
import { CleanContextRunner } from "../../utils/clean-context-runner.js";
import { sanitizeJsonForParse } from "../../utils/sanitize.js";
import type { IMemoryStore, IsolationFilter, L1SearchResult } from "../store/types.js";
import { hasClientEmbedding, type EmbeddingService } from "../store/embedding.js";
import type { LLMRunner, Logger, TraceContext } from "../types.js";
import { buildTraceParams } from "../types.js";
import { recallL1Candidates } from "../tools/l1-candidate-recall.js";
import { rerankCandidatesBySimilarity, type DedupRecallRerank } from "./l1-recall-rerank.js";

const TAG = "[memory-tdai][l1-dedup]";

// ============================
// Core function (batch mode)
// ============================

/**
 * Batch conflict detection: compare all new memories against existing records
 * in a single LLM call.
 *
 * Candidate recall strategy:
 * 1. Native hybrid (TCVDB dense+sparse) when the store advertises it
 * 2. Otherwise FTS ∥ client-vector in parallel, RRF-merged (same as memory_search)
 * 3. Skip conflict detection entirely — all memories go straight to "store"
 *
 * Isolation is the caller's `filter` (production extraction is session-scoped).
 * Do not reuse search's cross-session isolation here.
 *
 * @param memories - Newly extracted memories (with record_id)
 * @param config - OpenClaw config (for LLM access)
 * @param logger - Optional logger
 * @param model - Optional model override
 * @param vectorStore - Optional vector store for candidate recall
 * @param embeddingService - Optional embedding service for computing query vectors
 * @param conflictRecallTopK - Top-K candidates to recall per new memory (default: 5)
 * @returns Array of dedup decisions, one per new memory
 */
export async function batchDedup(params: {
  memories: Array<ExtractedMemory & { record_id: string }>;
  config: unknown;
  logger?: Logger;
  model?: string;
  /** Prompt family for conflict detection (default: chat). */
  promptMode?: MemoryPromptMode;
  /** Vector store for cosine similarity candidate recall */
  vectorStore?: IMemoryStore;
  /** Embedding service for computing query vectors */
  embeddingService?: EmbeddingService;
  /** Top-K candidates per new memory (default: 5) */
  conflictRecallTopK?: number;
  /** Override embedding timeout for capture-path calls (milliseconds) */
  embeddingTimeoutMs?: number;
  /** Host-neutral LLM runner — when provided, used instead of CleanContextRunner. */
  llmRunner?: LLMRunner;
  /** Isolation filter applied to candidate recall so dedup never crosses tenants. */
  filter?: IsolationFilter;
  /** langfuse 上报身份四元组（team/user/agent/session），透传给 llmRunner。 */
  traceContext?: TraceContext;
  /**
   * 查重 LLM 判定超时（毫秒），缺省 180000。
   * 上限：Node 内置 fetch(undici) 的 headersTimeout 默认 300s，非流式补全只在
   * 生成完后发头，配到 600s 会被静默截到 ~300s（见上游 issue #1403 补充说明）。
   */
  timeoutMs?: number;
  /**
   * 查重失败 fail-closed（P0-Fix1，v2 S1 移植）：true=LLM 判定失败整批上抛
   * （延后重试，游标不动、数据不丢）；false/缺省=既有降级「免检全 store」。
   * 只覆盖「调用失败」；解析降级（LLM 返回乱文本）仍走 storeAll，由
   * l1-dedup-fallback-silent WARN 锚点观测（v2 2026-10-12 拍板语义）。
   */
  dedupFailFast?: boolean;
  /** D2 召回轻修开关：none=旧行为（默认）；lexical=超额召回+词汇相似度重排。 */
  dedupRecallRerank?: DedupRecallRerank;
}): Promise<DedupDecision[]> {
  const { memories, config, logger, model, promptMode = "chat", vectorStore, embeddingService, llmRunner, filter, traceContext, dedupFailFast, dedupRecallRerank = "none" } = params;
  const timeoutMs = params.timeoutMs ?? 180_000;
  const topK = params.conflictRecallTopK ?? 5;

  if (memories.length === 0) {
    return [];
  }

  const storeAll = () =>
    memories.map((m) => ({
      record_id: m.record_id,
      action: "store" as const,
      target_ids: [],
    }));

  // Determine what recall capabilities are available
  const hasVectorData = vectorStore && (await vectorStore.countL1()) > 0;
  const hasFts = vectorStore?.isFtsAvailable() ?? false;
  const nativeHybrid = !!(
    vectorStore &&
    typeof vectorStore.getCapabilities === "function" &&
    vectorStore.getCapabilities().nativeHybridSearch &&
    typeof vectorStore.searchL1Hybrid === "function"
  );

  // Fast path: no recall capability at all → skip dedup
  if (!hasVectorData && !hasFts && !nativeHybrid) {
    logger?.debug?.(`${TAG} No vector data and no FTS available, skipping conflict detection for ${memories.length} memories`);
    return storeAll();
  }

  // D8: a keyword-only backend (e.g. Mongo/mongot BM25) reports vectorSearch=false
  // via capabilities — don't waste embed calls on a store that cannot vector-search;
  // the shared recall helper then degrades to the FTS leg. `?? true` keeps legacy
  // stores that predate the capability surface on the vector path.
  const vectorCapable = (
    typeof vectorStore?.getCapabilities === "function"
      ? vectorStore.getCapabilities().vectorSearch
      : undefined
  ) ?? true;

  // Phase 1: Find candidates — unified hybrid recall (native-hybrid, else
  // FTS ∥ client-vector RRF via recallL1Candidates). A keyword-only store
  // (vectorCapable=false) or a Noop embedding service degrades to the FTS leg
  // inside the shared helper; vector failures are non-fatal there.
  logger?.debug?.(`${TAG} Using hybrid candidate recall (topK=${topK}, rerank=${dedupRecallRerank})`);
  const matches = await findCandidates(memories, vectorStore!, vectorCapable ? embeddingService : undefined, topK, logger, params.embeddingTimeoutMs, filter, hasVectorData, dedupRecallRerank);

  // Check if any memory has candidates
  const hasAnyCandidates = matches.some((m) => m.candidates.length > 0);

  if (!hasAnyCandidates) {
    logger?.debug?.(`${TAG} No similar records found for any memory, all will be stored`);
    return storeAll();
  }

  // Phase 2: Batch LLM judgment
  return runLlmJudgment(matches, memories, config, logger, model, promptMode, llmRunner, traceContext, timeoutMs, dedupFailFast);
}

/**
 * Phase 2: Run batch LLM judgment on candidate matches.
 */
async function runLlmJudgment(
  matches: CandidateMatch[],
  memories: Array<ExtractedMemory & { record_id: string }>,
  config: unknown,
  logger: Logger | undefined,
  model: string | undefined,
  promptMode: MemoryPromptMode,
  llmRunner?: LLMRunner,
  traceContext?: TraceContext,
  /** 查重判定超时；未显式配置时仍是 180_000。 */
  timeoutMs?: number,
  /** fail-closed 开关（P0-Fix1）：true=判定失败上抛给调用方走延后；false=既有降级全 store */
  dedupFailFast?: boolean,
): Promise<DedupDecision[]> {
  const llmTimeoutMs = timeoutMs ?? 180_000;
  logger?.debug?.(`${TAG} Running batch conflict detection for ${memories.length} memories (promptMode=${promptMode})`);

  try {
    const userPrompt = formatBatchConflictPrompt(matches);
    const systemPrompt = getConflictDetectionSystemPrompt(promptMode);
    let result: string;

    // langfuse trace 语义：见 l1-extractor.ts 里的说明。dedup 是 L1 的子步骤，
    // 用独立 name 便于在 UI 上区分 "抽取阶段" vs "去重判定阶段"。
    const traceParams = buildTraceParams("memory.l1-dedup", traceContext);

    if (llmRunner) {
      // Use the host-neutral LLMRunner interface
      result = await llmRunner.run({
        prompt: userPrompt,
        systemPrompt,
        taskId: "l1-conflict-detection",
        timeoutMs: llmTimeoutMs,
        ...traceParams,
      });
    } else {
      // Fallback: create CleanContextRunner (OpenClaw path)
      const runner = new CleanContextRunner({
        config,
        modelRef: model,
        enableTools: false,
        logger,
      });

      result = await runner.run({
        prompt: userPrompt,
        systemPrompt,
        taskId: "l1-conflict-detection",
        timeoutMs: llmTimeoutMs,
        ...traceParams,
      });
    }

    const decisions = parseBatchResult(result, memories, logger);
    return decisions;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (dedupFailFast) {
      // fail-closed（P0-Fix1）：查重失败≠免检入库——整批上抛走延后重试（游标不动、
      // 数据不丢）。注意：不得打 "defaulting all to store" 字样（那是
      // fail-closed 关闭时的可观测锚点，出现即代表开关未生效）。
      logger?.warn?.(`${TAG} Batch conflict detection failed (fail-fast, batch deferred): ${msg}`);
      throw err instanceof Error ? err : new Error(msg);
    }
    logger?.warn?.(
      `${TAG} Batch conflict detection failed, defaulting all to store: ${msg}`,
    );
    return memories.map((m) => ({
      record_id: m.record_id,
      action: "store" as const,
      target_ids: [],
    }));
  }
}

// ============================
// Candidate recall
// ============================

function hitToMemoryRecord(r: L1SearchResult): MemoryRecord {
  return {
    id: r.record_id,
    content: r.content,
    type: r.type as MemoryRecord["type"],
    priority: r.priority,
    scene_name: r.scene_name,
    source_message_ids: [],
    metadata: r.metadata_json
      ? (() => { try { return JSON.parse(r.metadata_json); } catch { return {}; } })()
      : {},
    timestamps: [r.timestamp_str].filter(Boolean),
    createdAt: "",
    updatedAt: "",
    sessionKey: r.session_key,
    sessionId: r.session_id,
  };
}

/**
 * Hybrid candidate recall (aligned with memory_search):
 * batch-embed when a client embedder exists, then per-memory recallL1Candidates
 * (native hybrid, else FTS ∥ vector + RRF). Exclude self-batch IDs afterwards.
 */
async function findCandidates(
  memories: Array<ExtractedMemory & { record_id: string }>,
  vectorStore: IMemoryStore,
  embeddingService: EmbeddingService | undefined,
  topK: number,
  logger: Logger | undefined,
  embeddingTimeoutMs: number | undefined,
  filter: IsolationFilter | undefined,
  hasVectorData: boolean,
  /** D2 召回轻修：lexical=超额召回喂词汇重排（真重复被召回序挤出时捞回）；none=旧行为 */
  rerank: DedupRecallRerank = "none",
): Promise<CandidateMatch[]> {
  const newRecordIds = new Set(memories.map((m) => m.record_id));
  const nativeHybrid = !!(
    typeof vectorStore.getCapabilities === "function" &&
    vectorStore.getCapabilities().nativeHybridSearch &&
    typeof vectorStore.searchL1Hybrid === "function"
  );

  let queryEmbeddings: Float32Array[] | undefined;
  let vectorSvc = embeddingService;
  if (hasClientEmbedding(embeddingService) && !nativeHybrid) {
    if (hasVectorData) {
      try {
        queryEmbeddings = await embeddingService.embedBatch(
          memories.map((m) => m.content),
          embeddingTimeoutMs ? { timeoutMs: embeddingTimeoutMs } : undefined,
        );
      } catch (err) {
        logger?.warn?.(
          `${TAG} embedBatch failed (non-fatal, FTS may still run): ${err instanceof Error ? err.message : String(err)}`,
        );
        vectorSvc = undefined;
      }
    } else {
      vectorSvc = undefined;
    }
  }

  // D2（v2 4db48bf 移植）：lexical 模式超额召回（5+1 → 50）给重排供料，把
  // 「6-10 名外/被召回序挤出」的真重复捞回 top-K；重排是纯词汇计算（毫秒级），
  // 在 store 层截断、不增大 LLM prompt。none 模式逐字保持旧行为。
  const recallFetch = rerank === "lexical" ? Math.max(topK * 10, 50) : topK + memories.length;
  const matches: CandidateMatch[] = [];

  for (let i = 0; i < memories.length; i++) {
    const mem = memories[i];
    const recalled = await recallL1Candidates({
      query: mem.content,
      topK: recallFetch,
      vectorStore,
      embeddingService: vectorSvc,
      logger,
      filter,
      queryEmbedding: queryEmbeddings?.[i],
      embeddingTimeoutMs,
      logTag: TAG,
    });

    const filtered = recalled.hits.filter((r) => !newRecordIds.has(r.record_id));
    const topHits = rerank === "lexical"
      ? rerankCandidatesBySimilarity(mem.content, filtered, topK)
      : filtered.slice(0, topK);
    const candidates: MemoryRecord[] = topHits.map(hitToMemoryRecord);

    matches.push({ newMemory: mem, candidates });
  }

  logger?.debug?.(
    `${TAG} Candidate recall: ${matches.map((m) => `${m.newMemory.record_id}→${m.candidates.length}`).join(", ")}`,
  );

  return matches;
}

// ============================
// Result parsing
// ============================

const VALID_TYPES: MemoryType[] = ["persona", "episodic", "instruction", "work_fact", "work_task", "work_method", "work_artifact"];

/**
 * Parse the LLM's batch conflict detection JSON response.
 *
 * Expected format: [{record_id, action, target_ids, merged_content, merged_type, merged_priority, merged_timestamps}]
 */
function parseBatchResult(
  raw: string,
  memories: Array<ExtractedMemory & { record_id: string }>,
  logger?: Logger,
): DedupDecision[] {
  try {
    // ── Strip inline reasoning wrappers (A₂-style thinking models) ───────
    // Mirror of l1-extractor.ts@ccaa5dc3: A₂ models (minimax-m3 / GLM-4-
    // thinking / qwq-32b / some vLLM DeepSeek-R1) inline reasoning as
    // `<think>…</think>` inside `content`. Their think prose here frequently
    // contains stray `[` (candidate id refs like `[rec_a1]`, JSON preview
    // sketches, priority tags), which fatally derails the greedy
    // `/\[[\s\S]*\]/` array-match below by anchoring it inside the think
    // section. So we peel `<think>` blocks BEFORE the array-match fires.
    //
    // Same safeguards as l1-extractor:
    //   • non-greedy `*?` + explicit `</think>` requirement — truncated
    //     think tags (max_tokens cap) fall through as-is instead of eating
    //     the rest of the response, and the fallbackStoreAll safety net in
    //     the caller then quietly stores everything (dedup no-op).
    //   • `g` flag — multi-segment thinking is fully stripped.
    //   • Preserve untouched `raw` for the [l1-dedup-debug] log path so
    //     ops can still see original wire content when they need to debug
    //     a novel A₂ variant.
    //
    // A₁ models (minimax-m2.7 / deepseek-v4-pro / o1 / o3 / Claude thinking
    // API) put reasoning in a separate reasoning_content field, so `content`
    // never has <think> here — the replace is a no-op (backward-compatible,
    // per [[default-no-config-backward-compat]]).
    const stripped = raw.replace(/<think>[\s\S]*?<\/think>\s*/g, "");

    // Strip markdown code block wrappers
    let cleaned = stripped.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }

    // Extract JSON array
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      logger?.warn?.(`${TAG} No JSON array found in conflict detection response`);
      return fallbackStoreAll(memories, "no_json_array", logger);
    }

    // Sanitize control characters inside JSON string literals that LLM may produce
    const sanitized = sanitizeJsonForParse(arrayMatch[0]);
    const parsed = JSON.parse(sanitized) as unknown[];

    if (!Array.isArray(parsed)) {
      logger?.warn?.(`${TAG} Conflict detection response is not an array`);
      return fallbackStoreAll(memories, "not_array", logger);
    }

    // Build decisions from LLM output
    const decisions: DedupDecision[] = [];
    const validActions = ["store", "update", "merge", "skip"];

    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const d = item as Record<string, unknown>;

      const recordId = String(d.record_id ?? "");
      // Skip entries with empty/missing record_id — they are LLM hallucinations
      if (!recordId) {
        logger?.debug?.(`${TAG} Skipping decision with empty record_id`);
        continue;
      }
      const action = String(d.action ?? "store");

      if (!validActions.includes(action)) {
        logger?.warn?.(`${TAG} Invalid action "${action}" for record ${recordId}, defaulting to store`);
      }

      decisions.push({
        record_id: recordId,
        action: validActions.includes(action) ? (action as DedupDecision["action"]) : "store",
        target_ids: Array.isArray(d.target_ids) ? d.target_ids.map(String) : [],
        merged_content: typeof d.merged_content === "string" ? d.merged_content : undefined,
        merged_type: VALID_TYPES.includes(d.merged_type as MemoryType) ? (d.merged_type as MemoryType) : undefined,
        merged_priority: typeof d.merged_priority === "number" ? d.merged_priority : undefined,
        merged_timestamps: Array.isArray(d.merged_timestamps) ? d.merged_timestamps.map(String) : undefined,
      });
    }

    // Ensure all memories have a decision (fill missing with "store")
    const decidedIds = new Set(decisions.map((d) => d.record_id));
    for (const mem of memories) {
      if (!decidedIds.has(mem.record_id)) {
        logger?.debug?.(`${TAG} No decision for record ${mem.record_id}, defaulting to store`);
        decisions.push({
          record_id: mem.record_id,
          action: "store",
          target_ids: [],
        });
      }
    }

    return decisions;
  } catch (err) {
    logger?.warn?.(`${TAG} Failed to parse conflict detection result: ${err instanceof Error ? err.message : String(err)}`);
    return fallbackStoreAll(memories, "parse_error", logger);
  }
}

/**
 * Fallback: store all memories when parsing fails.
 *
 * reason 三值对应 parseBatchResult 的三条路径。WARN 锚点（P0-Fix1 随迁，
 * v2 f0ad3cc 语义）：「全 store」这个动作必须有独立可 grep 的日志行——
 * parse 失败静默免检入库是 L1 重复的历史新增源，切回 think 类厂商时重复
 * 暴涨会被误记为其它原因。此锚点即 kill-switch：出现即该轮查重空转。
 */
function fallbackStoreAll(
  memories: Array<ExtractedMemory & { record_id: string }>,
  reason: "no_json_array" | "not_array" | "parse_error",
  logger?: Logger,
): DedupDecision[] {
  logger?.warn?.(
    `${TAG} l1-dedup-fallback-silent reason=${reason} — ${memories.length} memory(ies) stored without dedup judgment`,
  );
  return memories.map((m) => ({
    record_id: m.record_id,
    action: "store" as const,
    target_ids: [],
  }));
}
