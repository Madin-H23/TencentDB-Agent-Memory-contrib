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
import { escapeStrayQuotesInStrings, extractJsonArraySpans, salvageJsonArrayTail } from "../../utils/json-repair.js";

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
  /**
   * 票19（2026-10-25）：会话键，随 fallback/digest 锚点输出——免检事件须可归因到
   * 宿主（zcode-default / deepseek-harness）与会话，否则面板审计页无法标注来源。
   * 可选：harness 直调等无会话上下文的调用方不传，锚点显示 (unknown)。
   */
  sessionKey?: string;
}): Promise<DedupDecision[]> {
  const { memories, config, logger, model, promptMode = "chat", vectorStore, embeddingService, llmRunner, filter, traceContext, dedupFailFast, dedupRecallRerank = "none", sessionKey } = params;
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
  return runLlmJudgment(matches, memories, config, logger, model, promptMode, llmRunner, traceContext, timeoutMs, dedupFailFast, sessionKey);
}

/**
 * Phase 2: Run batch LLM judgment on candidate matches.
 * 票18（2026-10-25）：解析失败不再直接整批免检——预算闸内重试一次，仍失败则按
 * salvage 前缀（truncated_partial）→ 整批 fallback 的次序收口；每步打结构摘要锚点。
 * 导出仅供测试（parse-hardening 套件直测预算闸与重试锚点）。
 */
export async function runLlmJudgment(
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
  /** 票19：会话键（锚点来源标注用，可选）。 */
  sessionKey?: string,
): Promise<DedupDecision[]> {
  const llmTimeoutMs = timeoutMs ?? 180_000;
  logger?.debug?.(`${TAG} Running batch conflict detection for ${memories.length} memories (promptMode=${promptMode})`);
  // 票19：锚点来源三元组（会话归属 + 生效模型）。model 未显式覆盖时为层默认。
  const srcCtx = {
    sessionKey,
    sessionId: traceContext?.sessionId,
    model,
  };

  const userPrompt = formatBatchConflictPrompt(matches);
  const systemPrompt = getConflictDetectionSystemPrompt(promptMode);
  // langfuse trace 语义：见 l1-extractor.ts 里的说明。dedup 是 L1 的子步骤，
  // 用独立 name 便于在 UI 上区分 "抽取阶段" vs "去重判定阶段"。
  const traceParams = buildTraceParams("memory.l1-dedup", traceContext);

  const callOnce = (taskId: string): Promise<string> => {
    if (llmRunner) {
      // Use the host-neutral LLMRunner interface
      return llmRunner.run({
        prompt: userPrompt,
        systemPrompt,
        taskId,
        timeoutMs: llmTimeoutMs,
        ...traceParams,
      });
    }
    // Fallback: create CleanContextRunner (OpenClaw path)
    const runner = new CleanContextRunner({
      config,
      modelRef: model,
      enableTools: false,
      logger,
    });
    return runner.run({
      prompt: userPrompt,
      systemPrompt,
      taskId,
      timeoutMs: llmTimeoutMs,
      ...traceParams,
    });
  };

  try {
    const t0 = Date.now();
    const result = await callOnce("l1-conflict-detection");
    let outcome = parseBatchResult(result, memories, logger, "first", srcCtx);

    // 票18 B：解析失败（非调用失败——调用失败走下方 catch 的 fail-fast 语义）且首调用
    // 耗时 ≤ timeoutMs/2 时重试一次。口径：callDeadline 每次 run 独享，重试不撞首调
    // deadline；本闸的真实作用是相位延迟上界（有闸 ≤timeoutMs/2 + callDeadline）。
    if (!outcome.ok) {
      const elapsed = Date.now() - t0;
      if (elapsed <= llmTimeoutMs / 2) {
        logger?.warn?.(
          `${TAG} l1-dedup-retry elapsed=${elapsed}ms sessionKey=${srcCtx.sessionKey ?? "(unknown)"} sessionId=${srcCtx.sessionId ?? "(unknown)"} model=${srcCtx.model ?? "(default)"} — 判定解析失败（${outcome.reason}），预算内重试一次`,
        );
        let retryOutcome: DedupParseOutcome | null = null;
        try {
          const retryResult = await callOnce("l1-conflict-detection-retry");
          retryOutcome = parseBatchResult(retryResult, memories, logger, "second", srcCtx);
        } catch (retryErr) {
          // 重试调用失败没有重试响应文本——回退首次响应的 salvage（审查 P1-3）
          logger?.warn?.(
            `${TAG} l1-dedup-retry call-failed sessionKey=${srcCtx.sessionKey ?? "(unknown)"} sessionId=${srcCtx.sessionId ?? "(unknown)"} model=${srcCtx.model ?? "(default)"}: ${retryErr instanceof Error ? retryErr.message : String(retryErr)} — 回退首次响应`,
          );
        }
        if (retryOutcome?.ok) return retryOutcome.decisions;
      } else {
        logger?.warn?.(
          `${TAG} l1-dedup-retry skipped elapsed=${elapsed}ms sessionKey=${srcCtx.sessionKey ?? "(unknown)"} sessionId=${srcCtx.sessionId ?? "(unknown)"} model=${srcCtx.model ?? "(default)"} — 超预算（>timeoutMs/2），不重试`,
        );
      }
    }

    // 收口次序：truncated_partial（前缀已判定、尾部按条免检）→ 整批 fallback。
    // 免检锚点在此按最终事实打（审查 P1-1：重试可能整批救回 truncated_partial，
    // 在 parse 内先打会出假 kill-switch 与双计）。
    if (!outcome.ok) {
      if (outcome.reason === "truncated_partial" && outcome.decisions) {
        logger?.warn?.(
          `${TAG} l1-dedup-fallback-silent reason=truncated_partial sessionKey=${srcCtx.sessionKey ?? "(unknown)"} sessionId=${srcCtx.sessionId ?? "(unknown)"} model=${srcCtx.model ?? "(default)"} — ${outcome.tailCount ?? 0} memory(ies) stored without dedup judgment`,
        );
        return outcome.decisions;
      }
      return fallbackStoreAll(
        memories,
        outcome.reason as "no_json_array" | "not_array" | "parse_error",
        logger,
        srcCtx,
      );
    }
    return outcome.decisions;
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
 *
 * 票18（2026-10-25）：产出语义改为 DedupParseOutcome（失败不再在函数内整批免检，
 * 由 runLlmJudgment 按 salvage→retry→fallback 次序收口）。处理链：
 * think-strip → 围栏剥离 → A1 多候选均衡扫描（utils/json-repair）→ sanitize →
 * B1' 裸引号修复（失败时）→ JSON.parse → 全失败则 A2 截断 salvage → 仍无则
 * no_json_array/parse_error。每个失败转折点打 `l1-dedup-parse-digest` 结构摘要
 * （仅长度/布尔/计数，零内容字符——PII-free；对照：抽取侧 [l1-debug] PARSE_FAIL
 * 的 rawFull 全文转储是既有 PII-in-logs 问题，本锚点刻意不复制该形态）。
 */
export type DedupParseOutcome =
  | { ok: true; decisions: DedupDecision[] }
  | {
      ok: false;
      reason: "no_json_array" | "not_array" | "parse_error" | "truncated_partial";
      /** truncated_partial：前缀 salvage 的判定 + 尾部按条 store（尾部免检锚点已在函数内打） */
      decisions?: DedupDecision[];
      tailCount?: number;
    };

export function parseBatchResult(
  raw: string,
  memories: Array<ExtractedMemory & { record_id: string }>,
  logger?: Logger,
  /** A3 摘要的重试相位标记（first/second），由 runLlmJudgment 传入 */
  attemptTag: "first" | "second" = "first",
  /** 票19：锚点来源三元组（sessionKey/sessionId/model，可选——harness 直调不传） */
  srcCtx?: { sessionKey?: string; sessionId?: string; model?: string },
): DedupParseOutcome {
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>\s*/g, "");

  // Strip markdown code block wrappers
  let cleaned = stripped.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  const logDigest = (spanCount: number, errPos: number): void => {
    let braceBalance = 0;
    for (const ch of cleaned) {
      if (ch === "{" || ch === "[") braceBalance++;
      else if (ch === "}" || ch === "]") braceBalance--;
    }
    const endsWith = cleaned.length > 0 ? cleaned[cleaned.length - 1]! : "";
    logger?.warn?.(
      `${TAG} l1-dedup-parse-digest rawLen=${raw.length} strippedLen=${cleaned.length} spanFound=${spanCount > 0} spanCount=${spanCount} braceBalance=${braceBalance} endsWith=${JSON.stringify(endsWith)} errPos=${errPos} retry=${attemptTag} sessionKey=${srcCtx?.sessionKey ?? "(unknown)"} sessionId=${srcCtx?.sessionId ?? "(unknown)"} model=${srcCtx?.model ?? "(default)"} — 无正文`,
    );
  };

  const errPosOf = (msg: string): number => {
    const m = msg.match(/position (\d+)/);
    return m ? Number(m[1]) : -1;
  };

  // A1：多候选均衡扫描——行文括号/多预览/字符串内括号不再带偏；截断 think 含
  // 真数组时多候选举到可解析者（审查 P1-1：单候选语义取不到，已改多候选）。
  const spans = extractJsonArraySpans(cleaned, 8);
  const allowed = new Set(memories.map((m) => m.record_id));
  let lastErrPos = -1;
  for (const span of spans) {
    const candidate = cleaned.slice(span.start, span.end + 1);
    const sanitized = sanitizeJsonForParse(candidate);
    let parsed: unknown;
    try {
      parsed = JSON.parse(sanitized);
    } catch (err) {
      lastErrPos = errPosOf(err instanceof Error ? err.message : String(err));
      // B1'：裸引号修复（与抽取链同源核心，utils/json-repair 共享）——合法 JSON 幂等原样
      const repaired = escapeStrayQuotesInStrings(sanitized);
      if (repaired === sanitized) continue;
      try {
        parsed = JSON.parse(repaired);
        logger?.warn?.(
          `${TAG} Repaired non-strict dedup response JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      } catch (err2) {
        lastErrPos = errPosOf(err2 instanceof Error ? err2.message : String(err2));
        continue;
      }
    }
    // 接受判据（票18 实测补）：解析成功 ≠ 判定数组——截断响应的内层字段数组
    // （如 target_ids 的 ["m_0"]）也合法可解析，必须要求至少一个对象携带批内
    // record_id 才接受，否则继续下一候选。
    const looksLikeDecisions =
      Array.isArray(parsed) &&
      parsed.some(
        (it) =>
          it &&
          typeof it === "object" &&
          typeof (it as Record<string, unknown>).record_id === "string" &&
          allowed.has(String((it as Record<string, unknown>).record_id)),
      );
    if (!looksLikeDecisions) continue;
    if (!Array.isArray(parsed)) continue; // 防御：looksLikeDecisions 已含数组判定
    return { ok: true, decisions: buildDecisions(parsed, memories, logger) };
  }

  // A2：截断 salvage——覆盖两个失败分支（span 全失败 / no_json_array 即未闭合数组形态）；
  // 输入=cleaned 全文（salvage 自带多候选 `[` 行走，行文噪声容错）。产出按批内
  // record_id 白名单过滤（顺带封 LLM 幻觉条目，审查 P1-3）。
  const salvaged = salvageJsonArrayTail(cleaned);
  if (salvaged && salvaged.length > 0) {
    // 注意：salvage 路径不走 buildDecisions 的 fill-missing——尾部缺失记忆必须留到
    // 这里按条计免检（truncated_partial 的 tailCount 语义），否则尾部免检会被静默
    // 藏进「defaulting to store」。
    const salvagedDecisions = buildDecisions(salvaged, memories, logger, { fillMissing: false });
    const decided = new Set(salvagedDecisions.map((d) => d.record_id));
    const tail = memories.filter((m) => !decided.has(m.record_id));
    // 免检锚点不在 parse 内打（审查 P1-1）：truncated_partial 可被 B 重试整批救回，
    // 锚点须在 runLlmJudgment 收口处按最终事实打——否则「重试全成」会打假
    // kill-switch、「双截断」会双计。本函数只返回 tailCount。
    logDigest(spans.length, lastErrPos);
    return {
      ok: false,
      reason: "truncated_partial",
      decisions: [
        ...salvagedDecisions,
        ...tail.map((m) => ({
          record_id: m.record_id,
          action: "store" as const,
          target_ids: [],
        })),
      ],
      tailCount: tail.length,
    };
  }

  logDigest(spans.length, lastErrPos);
  return { ok: false, reason: spans.length === 0 ? "no_json_array" : "parse_error" };
}

/**
 * 按解析出的数组构建决策（票18 抽出共享：正常路径与 salvage 路径同构）。
 * 白名单过滤：record_id 不在批内的条目是 LLM 幻觉，直接跳过（审查 P1-3——原实现
 * 不滤，salvage 路径会把行文噪声对象当决策带入）。
 */
function buildDecisions(
  parsed: unknown[],
  memories: Array<ExtractedMemory & { record_id: string }>,
  logger?: Logger,
  opts?: { fillMissing?: boolean },
): DedupDecision[] {
  const decisions: DedupDecision[] = [];
  const validActions = ["store", "update", "merge", "skip"];
  const allowed = new Set(memories.map((m) => m.record_id));

  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const d = item as Record<string, unknown>;

    const recordId = String(d.record_id ?? "");
    // Skip entries with empty/missing record_id — they are LLM hallucinations
    if (!recordId) {
      logger?.debug?.(`${TAG} Skipping decision with empty record_id`);
      continue;
    }
    if (!allowed.has(recordId)) {
      // 票18：批外 id = 幻觉条目（正常路径本就查不到它们，salvage 路径则会误带入）
      logger?.debug?.(`${TAG} Skipping decision for unknown record_id ${recordId}`);
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
  // （票18：salvage 路径关掉 fill-missing——尾部免检由 truncated_partial 分支按条计数）
  if (opts?.fillMissing === false) return decisions;
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
}

/**
 * Fallback: store all memories when parsing fails.
 *
 * reason 闭集对应 parseBatchResult 的终态失败路径（票18：truncated_partial 不走此
 * 函数——其前缀判定+尾部按条免检在 parse 内完成并打独立锚点）。WARN 锚点（P0-Fix1
 * 随迁，v2 f0ad3cc 语义）：「全 store」这个动作必须有独立可 grep 的日志行——parse
 * 失败静默免检入库是 L1 重复的历史新增源，切回 think 类厂商时重复暴涨会被误记为
 * 其它原因。此锚点即 kill-switch：出现即该轮查重对整批空转。
 */
function fallbackStoreAll(
  memories: Array<ExtractedMemory & { record_id: string }>,
  reason: "no_json_array" | "not_array" | "parse_error",
  logger?: Logger,
  /** 票19：来源三元组——免检事件必须可归因到宿主/会话/模型（缺省 (unknown)/(default)）。 */
  srcCtx?: { sessionKey?: string; sessionId?: string; model?: string },
): DedupDecision[] {
  logger?.warn?.(
    `${TAG} l1-dedup-fallback-silent reason=${reason} sessionKey=${srcCtx?.sessionKey ?? "(unknown)"} sessionId=${srcCtx?.sessionId ?? "(unknown)"} model=${srcCtx?.model ?? "(default)"} — ${memories.length} memory(ies) stored without dedup judgment`,
  );
  return memories.map((m) => ({
    record_id: m.record_id,
    action: "store" as const,
    target_ids: [],
  }));
}
