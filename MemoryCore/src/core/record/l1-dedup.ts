/**
 * L1 Memory Conflict Detection (Batch Mode): decides how to handle multiple new
 * memories against existing records in a single LLM call.
 *
 * v4: Removed JSONL-based Jaccard fallback. Candidate recall now relies exclusively
 *     on vector search (primary) and FTS5 BM25 (degraded). If neither is available,
 *     conflict detection is skipped entirely — all memories go straight to store.
 *
 * Two-phase approach:
 * 1. Candidate search per new memory — vector recall or FTS5 keyword recall (fast, no LLM)
 * 2. Batch LLM judgment on all new memories + their candidate pools (single call)
 */

import type { MemoryPromptMode } from "../../config.js";
import type { ExtractedMemory, MemoryRecord, DedupDecision, MemoryType } from "./l1-writer.js";
import { formatBatchConflictPrompt, getConflictDetectionSystemPrompt, type DedupPromptVersion } from "../prompts/l1-dedup.js";
import { rerankCandidatesBySimilarity, type DedupRecallRerank } from "./l1-recall-rerank.js";
import type { CandidateMatch } from "../prompts/l1-dedup.js";
import { CleanContextRunner } from "../../utils/clean-context-runner.js";
import { sanitizeJsonForParse } from "../../utils/sanitize.js";
import type { IMemoryStore, IsolationFilter } from "../store/types.js";
import { buildFtsQuery } from "../store/sqlite.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { LLMRunner, Logger, TraceContext } from "../types.js";
import { buildTraceParams } from "../types.js";

const TAG = "[memory-tdai][l1-dedup]";

// ============================
// Core function (batch mode)
// ============================

/**
 * Batch conflict detection: compare all new memories against existing records
 * in a single LLM call.
 *
 * Candidate recall strategy (3-tier degradation):
 * 1. Vector recall (vectorStore + embeddingService) — cosine similarity (best)
 * 2. FTS5 keyword recall (vectorStore with FTS available) — BM25 ranking (degraded)
 * 3. Skip conflict detection entirely — all memories go straight to "store"
 *
 * The old JSONL-based Jaccard fallback has been removed. If neither vector search
 * nor FTS is available, we skip dedup rather than paying the O(N) full-file-scan cost.
 *
 * @param memories - Newly extracted memories (with record_id)
 * @param config - OpenClaw config (for LLM access)
 * @param logger - Optional logger
 * @param model - Optional model override
 * @param vectorStore - Optional vector store for cosine similarity search
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
  /** LLM 调用超时（毫秒，默认 180_000 = 改动前行为）。
   *  2026-09-25 改为可配置：第三方生产实测 L1 去重 14 天失败 143/464（31%），
   *  其中 66 次即因 180s 超时（issue #1403）。
   *  上限提醒：Node 内置 fetch(undici) 的 headersTimeout 默认 300s，非流式补全
   *  只在生成完成后才发响应头，配到 600s 会被静默截到 ~300s。 */
  timeoutMs?: number;
  /** Host-neutral LLM runner — when provided, used instead of CleanContextRunner. */
  llmRunner?: LLMRunner;
  /** Isolation filter applied to candidate recall so dedup never crosses tenants. */
  filter?: IsolationFilter;
  /** 查重失败 fail-closed（2026-10-12 S1）：true=LLM 判定失败整批上抛（延后重试，
   *  游标不动、数据不丢）；false/缺省=既有降级「免检全 store」（重复入库风险）。 */
  dedupFailFast?: boolean;
  /** 查重判定提示词版本（D1：v2 含三条款，默认 v1；无效值在 prompt 函数 fail-fast） */
  dedupPromptVersion?: DedupPromptVersion;
  /** D2 召回轻修开关：none=旧行为（默认）；lexical=FTS 超额+词汇相似度重排 */
  dedupRecallRerank?: DedupRecallRerank;
  /** langfuse 上报身份四元组（team/user/agent/session），透传给 llmRunner。 */
  traceContext?: TraceContext;
}): Promise<DedupDecision[]> {
  const { memories, config, logger, model, promptMode = "chat", vectorStore, embeddingService, llmRunner, filter, traceContext, dedupFailFast, dedupPromptVersion = "v1", dedupRecallRerank = "none" } = params;
  // 保持与改动前一致：未显式配置时仍是 180_000。
  // 注意上限：Node 内置 fetch(undici) 的 headersTimeout 默认 300s，非流式补全只在生成完后发头，
  // 配到 600s 会被静默截到 ~300s（见 issue #1403 的第三方补充说明）。
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

  // Fast path: no recall capability at all → skip dedup
  if (!hasVectorData && !hasFts) {
    logger?.debug?.(`${TAG} No vector data and no FTS available, skipping conflict detection for ${memories.length} memories`);
    return storeAll();
  }

  // Phase 1: Find candidates
  //
  // Decision tree (after the fast-path guard above, vectorStore is guaranteed non-null):
  //   hasVectorData + embeddingService → Tier 1 vector recall (FTS fallback on error)
  //   otherwise hasFts                → Tier 2 FTS keyword recall
  //   otherwise                       → skip dedup (defensive; shouldn't reach here)
  let matches: CandidateMatch[];

  if (hasVectorData && embeddingService) {
    // === Tier 1: Vector recall mode ===
    logger?.debug?.(`${TAG} Using vector recall mode (topK=${topK})`);
    matches = await findCandidatesByVector(memories, vectorStore!, embeddingService, topK, logger, params.embeddingTimeoutMs, filter);
    // Tier 1 候选全空时降级 Tier 2 FTS 重召一次。countL1() 统计的是 l1_records
    // 而非 l1_vec：embedding.provider=none 的部署向量表恒为空，向量召回必返回
    // 0 候选，若就此判「无相似记录」会把 FTS 路径整个短路（生产实证：vector
    // recall 446 次 / FTS recall 0 次，update/merge/skip 恒为 0，去重失效六周）。
    // 向量表有数据的部署中 Tier 1 空即真无相似，此处多查一次 FTS 属无害兜底。
    if (!matches.some((m) => m.candidates.length > 0) && hasFts) {
      logger?.debug?.(`${TAG} Vector recall returned no candidates, falling back to FTS keyword recall`);
      matches = await findCandidatesByFts(memories, vectorStore!, logger, filter);
    }
  } else if (hasFts) {
    // === Tier 2: FTS keyword recall ===
    logger?.debug?.(`${TAG} Using FTS keyword recall mode (no embedding service or no vector data)`);
    matches = await findCandidatesByFts(memories, vectorStore!, logger, filter);
  } else {
    // Shouldn't reach here given the fast-path check above, but be defensive
    logger?.debug?.(`${TAG} No usable recall path, skipping conflict detection`);
    return storeAll();
  }

  // Check if any memory has candidates
  const hasAnyCandidates = matches.some((m) => m.candidates.length > 0);

  if (!hasAnyCandidates) {
    logger?.debug?.(`${TAG} No similar records found for any memory, all will be stored`);
    return storeAll();
  }

  // Phase 2: Batch LLM judgment
  return runLlmJudgment(matches, memories, config, logger, model, promptMode, llmRunner, traceContext, timeoutMs, dedupFailFast, dedupPromptVersion);
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
  /** LLM 调用超时（毫秒）。由 batchDedup 传入（缺省 180_000）。
   *  2026-09-29 修复：此前该值未透传，函数体内引用未定义变量，凡走到
   *  LLM 判定的调用全部 ReferenceError → fallback storeAll——去重判定
   *  形同虚设。旧短路 bug 使这条路径六周未被执行，修复降级后才暴露。 */
  timeoutMs?: number,
  /** fail-closed 开关（S1）：true=判定失败上抛给调用方走延后；false=既有降级全 store */
  dedupFailFast?: boolean,
  /** 提示词版本（D1）：透传至 getConflictDetectionSystemPrompt */
  dedupPromptVersion?: DedupPromptVersion,
): Promise<DedupDecision[]> {
  const llmTimeoutMs = timeoutMs ?? 180_000;
  logger?.debug?.(`${TAG} Running batch conflict detection for ${memories.length} memories (promptMode=${promptMode})`);

  try {
    const userPrompt = formatBatchConflictPrompt(matches);
    const systemPrompt = getConflictDetectionSystemPrompt(promptMode, dedupPromptVersion ?? "v1");
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
      // fail-closed（S1）：查重失败≠免检入库——整批上抛走延后重试（游标不动、
      // 数据不丢）。注意：不得打 "defaulting all to store" 字样（那是面板
      // kill-switch 指标，出现即代表 fail-closed 未生效）。
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
// Candidate recall strategies
// ============================

/**
 * Vector-based candidate recall (aligned with prototype):
 * batch-embed new memories → cosine search in VectorStore → exclude self-batch → return candidates.
 */
async function findCandidatesByVector(
  memories: Array<ExtractedMemory & { record_id: string }>,
  vectorStore: IMemoryStore,
  embeddingService: EmbeddingService,
  topK: number,
  logger?: Logger,
  embeddingTimeoutMs?: number,
  filter?: IsolationFilter,
): Promise<CandidateMatch[]> {
  const newRecordIds = new Set(memories.map((m) => m.record_id));

  // Batch-compute embeddings for all new memories
  const texts = memories.map((m) => m.content);
  const embeddings = await embeddingService.embedBatch(texts, embeddingTimeoutMs ? { timeoutMs: embeddingTimeoutMs } : undefined);

  const matches: CandidateMatch[] = [];

  for (let i = 0; i < memories.length; i++) {
    const mem = memories[i];
    const queryVec = embeddings[i];

    // Vector search top-K (request extra to account for self-batch filtering)
    const searchResults = filter
      ? await vectorStore.searchL1Vector(queryVec, topK + memories.length, mem.content, filter)
      : await vectorStore.searchL1Vector(queryVec, topK + memories.length, mem.content);

    // Exclude records from current batch, convert to MemoryRecord format
    const candidates: MemoryRecord[] = searchResults
      .filter((r) => !newRecordIds.has(r.record_id))
      .slice(0, topK)
      .map((r) => ({
        id: r.record_id,
        content: r.content,
        type: r.type as MemoryRecord["type"],
        priority: r.priority,
        scene_name: r.scene_name,
        source_message_ids: [],
        metadata: {},
        timestamps: [r.timestamp_str].filter(Boolean),
        createdAt: "",
        updatedAt: "",
        sessionKey: r.session_key,
        sessionId: r.session_id,
      }));

    matches.push({ newMemory: mem, candidates });
  }

  logger?.debug?.(
    `${TAG} Vector recall: ${matches.map((m) => `${m.newMemory.record_id}→${m.candidates.length}`).join(", ")}`,
  );

  return matches;
}

/**
 * FTS5-based candidate recall:
 * Uses the FTS index for efficient BM25-ranked keyword matching.
 * This replaces the old Jaccard word-overlap fallback entirely.
 */
async function findCandidatesByFts(
  memories: Array<ExtractedMemory & { record_id: string }>,
  vectorStore: IMemoryStore,
  _logger?: Logger,
  filter?: IsolationFilter,
  /** D2 召回轻修开关：none=旧行为（slice topK）；lexical=超额召回+词汇相似度重排 */
  rerank: DedupRecallRerank = "none",
  topK = 5,
): Promise<CandidateMatch[]> {
  const newRecordIds = new Set(memories.map((m) => m.record_id));
  const matches: CandidateMatch[] = [];

  for (const mem of memories) {
    const ftsQuery = buildFtsQuery(mem.content);
    if (ftsQuery) {
      // D2（2026-10-14）：lexical 模式超额召回（limit 10→50；sqlite 内部本已超额
      // 50 取，改 limit 近乎零成本）给重排供料，把「6-10 名外/被 IDF 序挤出」的真
      // 重复捞回 top-K；none 模式逐字保持旧行为。重排在 store 层截断，不增大 prompt。
      const recallLimit = rerank === "lexical" ? 50 : 10;
      const ftsResults = filter
        ? await vectorStore.searchL1Fts(ftsQuery, recallLimit, filter)
        : await vectorStore.searchL1Fts(ftsQuery, recallLimit);
      // Filter out records from the current batch
      const mapped: MemoryRecord[] = ftsResults
        .filter((r) => !newRecordIds.has(r.record_id))
        .map((r) => ({
          id: r.record_id,
          content: r.content,
          type: r.type as MemoryRecord["type"],
          priority: r.priority,
          scene_name: r.scene_name,
          source_message_ids: [],
          metadata: r.metadata_json ? (() => { try { return JSON.parse(r.metadata_json); } catch { return {}; } })() : {},
          timestamps: [r.timestamp_str].filter(Boolean),
          createdAt: "",
          updatedAt: "",
          sessionKey: r.session_key,
          sessionId: r.session_id,
        }));
      const candidates: MemoryRecord[] =
        rerank === "lexical"
          ? rerankCandidatesBySimilarity(mem.content, mapped, topK)
          : mapped.slice(0, topK);
      matches.push({ newMemory: mem, candidates });
    } else {
      matches.push({ newMemory: mem, candidates: [] });
    }
  }

  _logger?.debug?.(`${TAG} FTS keyword recall: ${matches.map((m) => `${m.newMemory.record_id}→${m.candidates.length}`).join(", ")}`);
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
    // think 内联剥离（P0 2026-10-13，对齐上游 l1-dedup.ts:316-339）：think 类模型
    // （step-5「永远推理」/ GLM thinking / R1 系）把推理内联进 content，其散文里的
    // `[rec_x]` 候选引用会锚定下方贪婪数组匹配，令判定 parse 失败→静默全 store。
    // 非贪婪 + 显式闭合标签：截断的 think（max_tokens 打满）原样透传，不吞其余响应。
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
 * reason 三值对应 parseBatchResult 的三条路径。WARN 锚点（S1 评审修正 4，
 * 2026-10-13 M1 前置）：此前只 warn 条件本身，「全 store」这个动作无独立日志，
 * 指标上不可观测——parse 失败静默免检入库是 L1 重复的历史新增源，切回 think 类
 * 厂商时重复暴涨会被误记为其它原因。此锚点即 kill-switch：出现即该轮查重空转。
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
