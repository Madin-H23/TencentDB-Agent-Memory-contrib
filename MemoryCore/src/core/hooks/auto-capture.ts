/**
 * auto-capture hook (v3): records conversation messages locally (L0),
 * then notifies the MemoryPipelineManager for L1/L2/L3 scheduling.
 *
 * Key design decisions:
 * - Always write L0 locally via l0-recorder.
 * - When VectorStore + EmbeddingService are available, also write L0 vector index.
 * - Notify MemoryPipelineManager for L1/L2/L3 trigger evaluation.
 * - L1 Runner reads from VectorStore DB (primary) or L0 JSONL files (fallback).
 * - Extraction is NOT triggered here. The pipeline manager decides when.
 */

import crypto from "node:crypto";
import type { MemoryTdaiConfig } from "../../config.js";
import { CheckpointManager } from "../../utils/checkpoint.js";
import type { MemoryPipelineManager } from "../../utils/pipeline-manager.js";
import { captureGateForStore } from "../../utils/capture-dedup-gate.js";
import { recordConversation } from "../conversation/l0-recorder.js";
import type { ConversationMessage } from "../conversation/l0-recorder.js";
import { DEFAULT_ISOLATION_ID, type IMemoryStore, type L0Record } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import { hasClientEmbedding } from "../store/embedding.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { report } from "../report/reporter.js";
import {
  evaluateSemanticGate,
  shouldLogSemanticGateInertOnce,
  type SemanticGateMessage,
} from "./capture-semantic-gate.js";
import { redactError } from "../../utils/redact-secrets.js";
import { createCredentialMasker } from "../../utils/credential-mask.js";

import type { LLMRunner, Logger } from "../types.js";

const TAG = "[memory-tdai] [capture]";

/** shadow 锚点：by_action 固定键序（便于 grep/面板解析；全 0 也输出）。 */
function formatSemanticGateByAction(a: Record<string, number>): string {
  return `skip=${a.skip ?? 0},store=${a.store ?? 0},update=${a.update ?? 0},merge=${a.merge ?? 0},none=${a.none ?? 0}`;
}

/** shadow 锚点：by_role=<role>=<candidates>/<hits>（无判定消息时为空串）。 */
function formatSemanticGateByRole(r: Record<string, { candidates: number; hits: number }>): string {
  return Object.keys(r)
    .map((role) => `${role}=${r[role]!.candidates}/${r[role]!.hits}`)
    .join(",");
}

/** shadow 锚点：by_len 固定键序（避免 < > 字符影响 grep/日志解析）。 */
function formatSemanticGateByLen(l: { lt200: number; mid: number; gt1000: number }): string {
  return `lt200:${l.lt200},mid:${l.mid},gt1000:${l.gt1000}`;
}

/** shadow 锚点：样本 id|top1|action|target_ids（id 内可含 ':'，故不用 ':' 分隔；无正文）。 */
function formatSemanticGateSamples(
  samples: Array<{ id: string; top1: number; action: string; targetIds: string[] }>,
): string {
  return samples
    .map((s) => `${s.id}|${s.top1.toFixed(3)}|${s.action}|${s.targetIds.join("+")}`)
    .join(",");
}

export interface AutoCaptureResult {
  /** Whether the scheduler was notified (conversation count incremented) */
  schedulerNotified: boolean;
  /** Number of messages recorded to L0 */
  l0RecordedCount: number;
  /** Number of L0 message vectors written */
  l0VectorsWritten: number;
  /** Filtered messages for L1 immediate use */
  filteredMessages: ConversationMessage[];
  /**
   * [P1 票④ capture-dedup-gate] 同源重投短路：本批内容指纹命中在案近期记忆，
   * 免蒸馏（不触发 scheduler notify）、只推热度时间戳。仅短路路径携带；
   * 正常路径不含此键（off/未命中返回形状与基线逐字节一致）。
   */
  shortcircuited?: boolean;
  /** 短路命中的在案记忆 id（真实 record_id 或本进程 pending 占位）。 */
  matchedId?: string;
  /**
   * [P1 票④修复·消息级闸] 部分命中时被排除消息数：命中项（已在案/已在 L0 近窗）
   * 跳过向量写入，其余照常。仅 >0 时携带（返回形状与基线一致）。
   */
  gateExcludedCount?: number;
}

/**
 * Generate a unique L0 record ID for vector indexing.
 * Includes an index to distinguish multiple messages within the same round.
 */
function generateL0RecordId(sessionKey: string, index: number): string {
  return `l0_${sessionKey}_${Date.now()}_${index}_${crypto.randomBytes(3).toString("hex")}`;
}

export async function performAutoCapture(params: {
  messages: unknown[];
  sessionKey: string;
  sessionId?: string;
  cfg: MemoryTdaiConfig;
  pluginDataDir: string;
  logger?: Logger;
  scheduler?: MemoryPipelineManager;
  /** Clean original user prompt from before_prompt_build cache (pre-prependContext). */
  originalUserText?: string;
  /**
   * Number of messages in the session at before_prompt_build time.
   * Used by l0-recorder to locate the exact user message that originalUserText
   * corresponds to: rawMessages[originalUserMessageCount] is the polluted user message.
   */
  originalUserMessageCount?: number;
  /** Epoch ms when the plugin was registered (cold-start time).
   *  Used as fallback cursor when checkpoint has no prior timestamp —
   *  prevents the first agent_end from dumping all session history into L0. */
  pluginStartTimestamp?: number;
  /** VectorStore for L0 vector indexing (optional). */
  vectorStore?: IMemoryStore;
  /** EmbeddingService for L0 vector indexing (optional). */
  embeddingService?: EmbeddingService;
  /**
   * Tracks in-flight fire-and-forget background tasks started by this
   * capture (currently: deferred L0 embedding for SQLite-style stores).
   *
   * When provided, each background task's Promise is added to the set
   * on creation and removed on completion.  This lets the owning
   * ``TdaiCore`` instance await all pending background work before
   * closing ``vectorStore`` / ``embeddingService`` in ``destroy()``,
   * so we never hit an already-closed DB connection with a late
   * ``updateL0Embedding`` call.
   *
   * Optional for backwards compatibility — callers that don't care
   * (tests, short-lived CLI invocations) can omit it and accept the
   * pre-fix behaviour (background task may outlive its owner).
   */
  bgTaskRegistry?: Set<Promise<void>>;
  /** StorageAdapter for file operations (COS/local). Falls back to fs when absent. */
  storage?: StorageAdapter;
  /**
   * [P1 票④b] 捕获语义门判定 runner（tdai-core 的 L1 既有装配点注入，不新建）。
   * 缺失（host runner 路径）→ 语义门 inert，捕获路径不变。
   */
  semanticGateJudge?: LLMRunner;
}): Promise<AutoCaptureResult> {
  const {
    messages, sessionKey, sessionId, cfg, pluginDataDir, logger, scheduler,
    originalUserText, originalUserMessageCount, pluginStartTimestamp,
    vectorStore, embeddingService, bgTaskRegistry, storage, semanticGateJudge,
  } = params;
  const tCaptureStart = performance.now();

  const checkpoint = new CheckpointManager(pluginDataDir, logger, storage);

  // ============================
  // Step 1 + 2: L0 recording + checkpoint update (ATOMIC)
  // ============================
  // These steps are combined inside captureAtomically() to prevent the race
  // condition where two concurrent agent_end events both read the same stale
  // cursor and produce duplicate L0 records. The file lock is held for the
  // entire read-cursor → recordConversation → advance-cursor sequence.
  const tL0RecordStart = performance.now();
  let filteredMessages: ConversationMessage[] = [];
  try {
    await checkpoint.captureAtomically(
      sessionKey,
      pluginStartTimestamp,
      async (afterTimestamp) => {
        logger?.debug?.(`${TAG} L0 capture cursor (per-session, atomic): afterTimestamp=${afterTimestamp} session=${sessionKey}`);

        if (afterTimestamp === pluginStartTimestamp && pluginStartTimestamp && pluginStartTimestamp > 0) {
          logger?.debug?.(
            `${TAG} No per-session checkpoint cursor found for session=${sessionKey} — ` +
            `using pluginStartTimestamp as floor: ` +
            `${afterTimestamp} (${new Date(afterTimestamp).toISOString()})`,
          );
        }

        filteredMessages = await recordConversation({
          sessionKey,
          sessionId,
          rawMessages: messages,
          baseDir: pluginDataDir,
          logger,
          originalUserText,
          afterTimestamp,
          originalUserMessageCount,
          storage,
          // [origin#28] 写入侧凭据掩码：off/缺省=undefined（不接线·行为逐字节不变）
          credentialMasker: createCredentialMasker(cfg.extraction?.captureCredentialMask, logger),
        });

        if (filteredMessages.length === 0) {
          return null; // Nothing captured — cursor stays unchanged
        }

        logger?.debug?.(`${TAG} L0 recorded: ${filteredMessages.length} messages for session ${sessionKey}`);
        const maxTs = Math.max(...filteredMessages.map((m) => m.timestamp));
        return { maxTimestamp: maxTs, messageCount: filteredMessages.length };
      },
    );
  } catch (err) {
    logger?.error(`${TAG} L0 recording failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const tL0RecordEnd = performance.now();

  // ============================
  // Step 1.2: 同源重投捕获闸（extraction.captureDedupGate，默认 off）
  // ============================
  // 票④：L0 原始日志已留痕（上方 recordConversation），此处对**可指纹化**消息
  // 做指纹预检——全部命中 → 整批短路：不写向量、不触发 scheduler（免蒸馏），
  // 只推在案命中记忆热度时间戳；部分命中 → 消息级排除（v2：命中项跳过向量写入，
  // 其内容已在案/已在 L0 近窗，信息零丢失；其余照常走原路径）。off/未命中/畸形
  // 输入 → 原路径放行。gate 内部 lookup+记账无 await（同步临界区）：并发/连发
  // 同文恰好一个放行。种子经 seedFromStore（全量一次+水位增量，P1-1/P2 修复）。
  let gateExcludedIdx: Set<number> | null = null;
  let gateExcludedCount = 0;
  if (cfg.extraction?.captureDedupGate === true && filteredMessages.length > 0 && vectorStore) {
    try {
      const gate = captureGateForStore(vectorStore);
      await gate.seedFromStore(vectorStore);
      const decision = gate.evaluate(filteredMessages);
      if (decision.shortcircuited) {
        // 仅在案（archive）命中推 L1 热度；pending/持久近窗命中非 L1 id，不推
        if (decision.heatId && vectorStore.touchL1Heat) {
          try {
            await vectorStore.touchL1Heat(decision.heatId, new Date().toISOString());
          } catch (touchErr) {
            logger?.warn(
              `${TAG} [capture-gate] touchL1Heat failed (non-fatal): ${touchErr instanceof Error ? touchErr.message : String(touchErr)}`,
            );
          }
        }
        logger?.info(
          `${TAG} metric=capture_dedup_shortcircuit value=1 matched=${decision.matchedId} session=${sessionKey} msgs=${filteredMessages.length}`,
        );
        report("capture_dedup_shortcircuit", {
          sessionKey,
          matched: decision.matchedId,
          value: 1,
          msgs: filteredMessages.length,
        });
        return {
          schedulerNotified: false,
          l0RecordedCount: filteredMessages.length,
          l0VectorsWritten: 0,
          filteredMessages,
          shortcircuited: true,
          matchedId: decision.matchedId,
        };
      }
      if (decision.excluded && decision.excluded.length > 0) {
        gateExcludedIdx = new Set(decision.excluded);
        gateExcludedCount = decision.excluded.length;
        logger?.info(
          `${TAG} metric=capture_dedup_excluded value=${gateExcludedCount} session=${sessionKey} msgs=${filteredMessages.length}`,
        );
        report("capture_dedup_excluded", {
          sessionKey,
          value: gateExcludedCount,
          msgs: filteredMessages.length,
        });
      }
    } catch (gateErr) {
      // 闸任何异常（如在案读取失败）→ 降级放行，绝不阻塞捕获主路径
      gateExcludedIdx = null;
      gateExcludedCount = 0;
      logger?.warn(
        `${TAG} [capture-gate] gate error (non-fatal, pass-through): ${gateErr instanceof Error ? gateErr.message : String(gateErr)}`,
      );
    }
  }

  // ============================
  // Step 1.3: ④b 捕获语义门（extraction.captureSemanticGate，默认 off）
  // ============================
  // 票④b：识别「L0 以新措辞复述在案 L1 事实」的改写型重投（④ hash 门接不住的
  // 形态）。输入只取 ④ 未排除的消息（④ 已排除的不进 ④b，两门计数不重叠）。
  //   mode=off   → 零额外 I/O、零锚点，逐字节同基线；
  //   mode=shadow→ 完整跑候选+判定并打锚点，排除集合恒空（零风险计量）；
  //   mode=on    → 仅 LLM 判 skip 的消息并入 gateExcludedIdx（跳过 upsertL0 =
  //                不进蒸馏源；L0 JSONL 已在上方留痕）。
  // 门内任何失败/超时 → 整批放行（failopen），绝不阻塞捕获。
  const semGateCfg = cfg.extraction?.captureSemanticGate;
  const semGateMode = semGateCfg?.mode ?? "off";
  if (semGateMode !== "off" && filteredMessages.length > 0) {
    const capsVectorReady = (() => {
      if (!vectorStore) return false;
      try {
        const caps = typeof vectorStore.getCapabilities === "function"
          ? vectorStore.getCapabilities()
          : undefined;
        return !caps || caps.vectorSearch !== false;
      } catch {
        return false;
      }
    })();
    const inertReason =
      !embeddingService || !hasClientEmbedding(embeddingService) ? "no_embedding"
      : !vectorStore ? "no_vector_store"
      : !capsVectorReady ? "no_vec_table"
      : !semanticGateJudge ? "no_judge"
      : undefined;

    if (inertReason) {
      // 每进程每原因只打一次（成功路径按捕获频率执行，不去重会刷屏）
      if (shouldLogSemanticGateInertOnce(inertReason)) {
        logger?.info(
          `${TAG} metric=capture_semantic_gate mode=${semGateMode} skipped=inert ` +
          `reason=${inertReason} session=${sessionKey}`,
        );
        report("capture_semantic_gate", {
          sessionKey, mode: semGateMode, skipped: "inert", reason: inertReason,
        });
      }
    } else {
      const gateInput: SemanticGateMessage[] = [];
      const indexById = new Map<string, number>();
      for (let i = 0; i < filteredMessages.length; i++) {
        if (gateExcludedIdx?.has(i)) continue; // ④ 已排除 → 不进 ④b
        const msg = filteredMessages[i]!;
        const id = `${sessionKey}:${msg.timestamp}:${i}`;
        gateInput.push({ id, content: msg.content, role: msg.role });
        indexById.set(id, i);
      }

      if (gateInput.length > 0) {
        const runGateAndAnchor = async (): Promise<void> => {
          try {
            const tSemStart = performance.now();
            const semResult = await evaluateSemanticGate(gateInput, {
              mode: semGateMode,
              embeddingService: embeddingService!,
              vectorStore: vectorStore!,
              judge: semanticGateJudge!,
              threshold: semGateCfg!.threshold,
              topK: semGateCfg!.topK,
              maxMessageChars: semGateCfg!.maxMessageChars,
              maxMessagesPerBatch: semGateCfg!.maxMessagesPerBatch,
              judgeTimeoutMs: semGateCfg!.judgeTimeoutMs,
              embeddingTimeoutMs: semGateCfg!.embeddingTimeoutMs,
              logger,
            });

            let semanticSkipped = 0;
            if (semGateMode === "on" && semResult.excludedMessageIds.size > 0) {
              const next = new Set<number>(gateExcludedIdx ?? []);
              for (const id of semResult.excludedMessageIds) {
                const idx = indexById.get(id);
                if (idx !== undefined) {
                  next.add(idx);
                  semanticSkipped++;
                }
              }
              gateExcludedIdx = next;
            }
            const skippedAnchor = semGateMode === "shadow" ? 0 : semanticSkipped;

            logger?.info(
              `${TAG} metric=capture_semantic_gate mode=${semGateMode} value=${semResult.candidates} ` +
              `hits=${semResult.hits} skipped=${skippedAnchor} oversize=${semResult.oversize} ` +
              `capped=${semResult.capped} top=${semResult.topScore.toFixed(2)} ` +
              `failopen=${semResult.failopen ? 1 : 0} hash_excluded=${gateExcludedCount} ` +
              `by_action=${formatSemanticGateByAction(semResult.byAction)} ` +
              `by_role=${formatSemanticGateByRole(semResult.byRole)} ` +
              `by_len=${formatSemanticGateByLen(semResult.byLen)} ` +
              `top1_hist=${semResult.top1Buckets.join(",")} ` +
              `samples=${formatSemanticGateSamples(semResult.samples)} session=${sessionKey} ` +
              `ms=${(performance.now() - tSemStart).toFixed(0)}`,
            );
            report("capture_semantic_gate", {
              sessionKey,
              mode: semGateMode,
              candidates: semResult.candidates,
              hits: semResult.hits,
              skipped: skippedAnchor,
              oversize: semResult.oversize,
              capped: semResult.capped,
              topScore: Number(semResult.topScore.toFixed(2)),
              failopen: semResult.failopen ? 1 : 0,
              hashExcluded: gateExcludedCount,
              byAction: semResult.byAction,
              byRole: semResult.byRole,
              byLen: semResult.byLen,
              top1Hist: semResult.top1Buckets,
              samples: semResult.samples,
              ms: Number((performance.now() - tSemStart).toFixed(0)),
            });
          } catch (semErr) {
            // 模块内已满 fail-open；此处仅兜底「绝不影响捕获主路径」
            logger?.warn(
              `${TAG} [semantic-gate] unexpected error (non-fatal, pass-through): ${redactError(semErr)}`,
            );
          }
        };

        if (semGateMode === "shadow") {
          // shadow 只计量：fire-and-forget，绝不阻塞 /capture 响应路径。
          // 约定：registry 缺省时也不回退成内联（`void` + catch 兜底即可）。
          const gatePromise: Promise<void> = runGateAndAnchor().catch((semErr) => {
            logger?.warn(
              `${TAG} [semantic-gate] background task failed (non-fatal): ${redactError(semErr)}`,
            );
          });
          if (bgTaskRegistry) {
            bgTaskRegistry.add(gatePromise);
            void gatePromise.finally(() => {
              bgTaskRegistry.delete(gatePromise);
            });
          }
        } else {
          // on：排除必须发生在 L0 向量写入 / 蒸馏源之前 → 内联等待。
          await runGateAndAnchor();
        }
      }
    }
  }

  // ============================
  // Step 1.5: L0 vector indexing
  // ============================
  // Two paths depending on store capabilities:
  //
  // A) Store supports updateL0Embedding (sqlite):
  //    - Write metadata + FTS immediately WITHOUT embedding (~ms)
  //    - Fire-and-forget background task: embedBatch + updateL0Embedding
  //    - PERF: avoids blocking agent_end with 2-3s embedding calls
  //
  // B) Store does NOT support updateL0Embedding (VDB / remote):
  //    - Embed synchronously, then upsertL0 with embedding in one call
  //    - VDB backends handle embedding server-side or need it upfront
  const tL0VecStart = performance.now();
  let l0VectorsWritten = 0;
  let l0EmbedTotalMs = 0;
  let l0UpsertTotalMs = 0;
  logger?.debug?.(
    `${TAG} [L0-vec-index] Check: filteredMessages=${filteredMessages.length}, ` +
    `vectorStore=${vectorStore ? "available" : "UNAVAILABLE"}, ` +
    `embeddingService=${embeddingService ? "available" : "UNAVAILABLE"}`,
  );

  const supportsBgEmbed = vectorStore?.supportsDeferredEmbedding === true;

  if (filteredMessages.length > 0 && vectorStore) {
    const now = new Date().toISOString();
    const bgRecords: Array<{ recordId: string; content: string }> = [];
    logger?.debug?.(
      `${TAG} [L0-vec-index] START indexing ${filteredMessages.length} message(s) for session ${sessionKey} ` +
      `(mode=${supportsBgEmbed ? "async-bg" : "sync"})`,
    );

    for (let i = 0; i < filteredMessages.length; i++) {
      if (gateExcludedIdx?.has(i)) continue; // 消息级闸（v2）：命中项已在案/已在 L0 近窗，跳过向量写入
      const msg = filteredMessages[i];
      try {
        const l0Record: L0Record = {
          id: generateL0RecordId(sessionKey, i),
          sessionKey,
          sessionId: sessionId || DEFAULT_ISOLATION_ID,
          role: msg.role,
          messageText: msg.content,
          recordedAt: now,
          timestamp: msg.timestamp,
        };

        let embedding: Float32Array | undefined;

        if (!supportsBgEmbed && embeddingService) {
          // Path B (VDB): embed synchronously — needed for upsertL0
          // Skip local embed when using server-side embedding (NoopEmbeddingService, dims=0)
          if (embeddingService.getDimensions() === 0) {
            logger?.debug?.(
              `${TAG} [L0-vec-index] Server-side embedding (dims=0), skipping local embed for message ${i}`,
            );
          } else {
            const tEmbedStart = performance.now();
            try {
              embedding = await embeddingService.embed(msg.content);
              l0EmbedTotalMs += performance.now() - tEmbedStart;
              logger?.debug?.(
                `${TAG} [L0-vec-index] Embedding OK: dims=${embedding.length}, ` +
                `norm=${Math.sqrt(Array.from(embedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}`,
              );
            } catch (embedErr) {
              l0EmbedTotalMs += performance.now() - tEmbedStart;
              logger?.warn(
                `${TAG} [L0-vec-index] Embedding FAILED for message ${i}, ` +
                `will write metadata only: ${embedErr instanceof Error ? embedErr.message : String(embedErr)}`,
              );
            }
          }
        }

        // Path A (sqlite): pass undefined embedding — metadata + FTS only
        // Path B (VDB): pass embedding (may be undefined on failure)
        const tUpsertStart = performance.now();
        const upsertOk = await vectorStore.upsertL0(l0Record, supportsBgEmbed ? undefined : embedding);
        l0UpsertTotalMs += performance.now() - tUpsertStart;

        if (upsertOk) {
          l0VectorsWritten++;
          if (supportsBgEmbed) {
            bgRecords.push({ recordId: l0Record.id, content: msg.content });
          }
        } else {
          logger?.warn(`${TAG} [L0-vec-index] upsertL0 returned false for message ${i}`);
        }
      } catch (err) {
        logger?.warn?.(`${TAG} [L0-vec-index] FAILED for message ${i} (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const modeLabel = supportsBgEmbed ? "metadata-only, embed=background" : `embed=${l0EmbedTotalMs.toFixed(0)}ms, upsert=${l0UpsertTotalMs.toFixed(0)}ms`;
    logger?.debug?.(`${TAG} [L0-vec-index] DONE: ${l0VectorsWritten}/${filteredMessages.length} records written (${modeLabel})`);

    // Path A only: fire-and-forget background embedding for sqlite stores
    if (supportsBgEmbed && bgRecords.length > 0 && embeddingService) {
      const bgVectorStore = vectorStore;
      const bgEmbeddingService = embeddingService;
      const bgSnapshot = [...bgRecords];
      const bgLogger = logger;

      // Do NOT await — runs in background after response is sent.
      //
      // Register the task in bgTaskRegistry (if provided) so TdaiCore.destroy()
      // can await it before closing vectorStore / embeddingService.  The
      // ``.finally`` clean-up ensures the entry is removed on both success
      // and failure; without that the set would leak and eventually block
      // shutdown indefinitely.
      const bgPromise: Promise<void> = (async () => {
        const tBgStart = performance.now();
        try {
          const texts = bgSnapshot.map((r) => r.content);
          const embeddings = await bgEmbeddingService.embedBatch(texts);

          let bgUpdated = 0;
          for (let i = 0; i < bgSnapshot.length; i++) {
            try {
              const ok = await bgVectorStore.updateL0Embedding!(bgSnapshot[i].recordId, embeddings[i]);
              if (ok) bgUpdated++;
            } catch (err) {
              bgLogger?.warn?.(
                `${TAG} [L0-vec-index-bg] Failed to update embedding for ${bgSnapshot[i].recordId}: ` +
                `${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          const bgMs = performance.now() - tBgStart;
          bgLogger?.debug?.(
            `${TAG} [L0-vec-index-bg] Background embedding complete: ${bgUpdated}/${bgSnapshot.length} vectors updated (${bgMs.toFixed(0)}ms)`,
          );
        } catch (err) {
          const bgMs = performance.now() - tBgStart;
          bgLogger?.warn?.(
            `${TAG} [L0-vec-index-bg] Background embedding failed (${bgMs.toFixed(0)}ms, non-fatal): ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();

      if (bgTaskRegistry) {
        bgTaskRegistry.add(bgPromise);
        void bgPromise.finally(() => {
          bgTaskRegistry.delete(bgPromise);
        });
      }
    }
  } else if (filteredMessages.length > 0) {
    logger?.warn(`${TAG} [L0-vec-index] SKIPPED: vectorStore not available`);
  }
  const tL0VecEnd = performance.now();

  // ============================
  // Step 3: Notify scheduler of this conversation round
  // ============================
  const tNotifyStart = performance.now();
  // Pass empty array: L1 Runner reads from VectorStore DB (or L0 JSONL fallback), not from in-memory buffers.
  if (scheduler) {
    await scheduler.notifyConversation(sessionKey, []);
    logger?.debug?.(`${TAG} Scheduler notified of conversation round (sessionKey=${sessionKey})`);

    const totalMs = performance.now() - tCaptureStart;
    const vecDetail = supportsBgEmbed
      ? `metadata-only, embed=background, msgs=${filteredMessages.length}`
      : `embed=${l0EmbedTotalMs.toFixed(0)}ms, upsert=${l0UpsertTotalMs.toFixed(0)}ms, msgs=${filteredMessages.length}`;
    logger?.info(
      `${TAG} ⏱ Capture timing: total=${totalMs.toFixed(0)}ms, ` +
      `l0Record+checkpoint=${(tL0RecordEnd - tL0RecordStart).toFixed(0)}ms, ` +
      `l0VecIndex=${(tL0VecEnd - tL0VecStart).toFixed(0)}ms (${vecDetail}), ` +
      `notify=${(performance.now() - tNotifyStart).toFixed(0)}ms`,
    );

    return {
      schedulerNotified: true,
      l0RecordedCount: filteredMessages.length,
      l0VectorsWritten,
      filteredMessages,
      ...(gateExcludedCount > 0 ? { gateExcludedCount } : {}),
    };
  }

  const totalMs = performance.now() - tCaptureStart;
  const vecDetail = supportsBgEmbed
    ? `metadata-only, embed=background, msgs=${filteredMessages.length}`
    : `embed=${l0EmbedTotalMs.toFixed(0)}ms, upsert=${l0UpsertTotalMs.toFixed(0)}ms, msgs=${filteredMessages.length}`;
  logger?.info(
    `${TAG} ⏱ Capture timing: total=${totalMs.toFixed(0)}ms, ` +
    `l0Record+checkpoint=${(tL0RecordEnd - tL0RecordStart).toFixed(0)}ms, ` +
    `l0VecIndex=${(tL0VecEnd - tL0VecStart).toFixed(0)}ms (${vecDetail}), ` +
    `notify=${(performance.now() - tNotifyStart).toFixed(0)}ms`,
  );

  logger?.debug?.(`${TAG} No scheduler provided, skipping notification`);
  return {
    schedulerNotified: false,
    l0RecordedCount: filteredMessages.length,
    l0VectorsWritten,
    filteredMessages,
    ...(gateExcludedCount > 0 ? { gateExcludedCount } : {}),
  };
}
