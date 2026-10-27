/**
 * L1 Memory Writer: writes extracted memories to JSONL files.
 *
 * File naming: records/YYYY-MM-DD.jsonl (daily shards, all sessions merged).
 * Each record includes sessionKey for traceability.
 *
 * Write strategy:
 * - JSONL is the append-only persistent store (source of truth for backup/recovery).
 * - VectorStore (SQLite) is the primary retrieval engine.
 * - On update/merge, old records are deleted from VectorStore in real-time;
 *   JSONL is append-only and cleaned up periodically by memory-cleaner.
 *
 * Supports store (append), update, merge, and skip operations.
 *
 * v3: Aligned with Kenty's prompt output format — 3 memory types (persona/episodic/instruction),
 * numeric priority, scene_name, source_message_ids, metadata, timestamps.
 */

import crypto from "node:crypto";
import { DEFAULT_ISOLATION_ID, type IMemoryStore } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { StoragePaths } from "../storage/types.js";
import type { Logger } from "../types.js";
import { sanitizeUserAttribution } from "./attribution.js";

// ============================
// Types
// ============================

/** L1 memory types: chat-mode legacy types + code/work-mode team memory types. */
export type MemoryType =
  | "persona"
  | "episodic"
  | "instruction"
  | "work_fact"
  | "work_task"
  | "work_method"
  | "work_artifact";

/** Metadata for episodic memories (activity time range) */
export interface EpisodicMetadata {
  activity_start_time?: string; // ISO 8601
  activity_end_time?: string; // ISO 8601
}

/**
 * A persisted memory record in L1 JSONL files.
 *
 * v3 changes from v2:
 * - `importance: "high"|"medium"|"low"` → `priority: number` (0-100, -1 for strict global instructions)
 * - Added `scene_name`, `source_message_ids`, `metadata`, `timestamps`
 * - Removed `keywords` (will be rebuilt from content for search)
 * - MemoryType reduced from 4 to 3 (removed "preference", folded into "persona")
 */
export interface MemoryRecord {
  /** Unique ID for dedup updates */
  id: string;
  /** Memory content */
  content: string;
  /** Memory type: persona / episodic / instruction */
  type: MemoryType;
  /** Priority score: 0-100 (higher = more important), -1 = strict global instruction */
  priority: number;
  /** Scene name this memory belongs to */
  scene_name: string;
  /** Source message IDs that contributed to this memory */
  source_message_ids: string[];
  /** Type-specific metadata (e.g., activity_start_time for episodic) */
  metadata: EpisodicMetadata | Record<string, never>;
  /** Timestamp trail: all timestamps related to this memory (for merge history tracking) */
  timestamps: string[];
  /** Creation timestamp (ISO) */
  createdAt: string;
  /** Last update timestamp (ISO) */
  updatedAt: string;
  /** Monotonic version. New memories start at 1; update/merge increments by 1. */
  version?: number;
  /** Source session key (conversation channel identifier) */
  sessionKey: string;
  /** Source session ID (single conversation instance identifier) */
  sessionId: string;
  /** Optional task dimension for L0/L1 filtering. */
  taskId?: string;
  /**
   * Three-dim tenancy isolation (new in this branch).
   *
   * `userId` / `agentId` are mandatory for new writes once gateway-level
   * isolation enforcement is on, but kept optional on the type to avoid
   * breaking pre-isolation call sites and tests during rollout. The SQLite
   * upsert defaults them to '' if missing; the migration script backfills
   * existing rows with `__legacy__`.
   *
   * See `docs/l0l3-tenant-isolation-design.md`.
   */
  teamId?: string;
  userId?: string;
  agentId?: string;
}

/**
 * A memory as extracted by LLM (before dedup / persistence).
 * Matches the output format of Kenty's extraction prompt.
 */
export interface ExtractedMemory {
  content: string;
  type: MemoryType;
  priority: number;
  source_message_ids: string[];
  metadata: EpisodicMetadata | Record<string, never>;
  /** Scene name this memory was extracted in */
  scene_name: string;
}

export type DedupAction = "store" | "update" | "merge" | "skip";

/**
 * v3 batch dedup decision — one per new memory, aligned with Kenty's conflict detection prompt.
 *
 * Key changes:
 * - `targetId` → `target_ids` (array, supports multi-target merge/update)
 * - Added `merged_type`, `merged_priority`, `merged_timestamps` for cross-type merge
 */
export interface DedupDecision {
  /** Which new memory this decision is about */
  record_id: string;
  action: DedupAction;
  /** IDs of existing records to replace/remove (for update/merge) */
  target_ids: string[];
  /** Merged/updated content text (for update/merge) */
  merged_content?: string;
  /** Best type after merge (for update/merge, may differ from original) */
  merged_type?: MemoryType;
  /** Priority after merge (for update/merge) */
  merged_priority?: number;
  /** Union of all related timestamps (for update/merge) */
  merged_timestamps?: string[];
}

const TAG = "[memory-tdai][l1-writer]";

// ============================
// Core functions
// ============================

/**
 * Generate a unique memory ID.
 */
export function generateMemoryId(): string {
  return `m_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Write a memory record according to the dedup decision.
 *
 * - store: append new record
 * - update: remove target records + append updated record
 * - merge: remove target records + append merged record
 * - skip: do nothing
 *
 * v3: supports multi-target removal for update/merge.
 * v3.1: optional VectorStore + EmbeddingService for dual-write (JSONL + vector).
 */
export async function writeMemory(params: {
  memory: ExtractedMemory;
  decision: DedupDecision;
  baseDir: string;
  sessionKey: string;
  sessionId?: string;
  taskId?: string;
  /** Tenancy isolation propagated into MemoryRecord and downstream store. */
  teamId?: string;
  userId?: string;
  agentId?: string;
  logger?: Logger;
  /** Optional vector store for dual-write (JSONL + vector DB) */
  vectorStore?: IMemoryStore;
  /** Optional embedding service (required when vectorStore is provided) */
  embeddingService?: EmbeddingService;
  /** StorageAdapter for file operations (COS/local). Falls back to fs when absent. */
  storage?: StorageAdapter;
  /**
   * 用户身份白名单（extraction.userIdentityNames）。写库前的归一护栏据此判定
   * 「用户（X）」里的 X 是用户本人还是第三方。
   */
  userIdentityNames?: string[];
}): Promise<MemoryRecord | null> {
  const { memory, decision, baseDir, sessionKey, sessionId, taskId, teamId, userId, agentId, logger, vectorStore, embeddingService, storage, userIdentityNames } = params;

  if (decision.action === "skip") {
    logger?.debug?.(`${TAG} Skipping memory: ${memory.content.slice(0, 50)}...`);
    return null;
  }

  const now = new Date().toISOString();

  let nextVersion = 0;
  // 审计串联 id（2026-10-27）：一次 merge/update 的「删目标 + 写合并版」共享同一
  // request_id，便于把多条审计行还原成一次合并操作。
  const auditRequestId = `req-audit-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const targetVersionById = new Map<string, number>();
  if ((decision.action === "update" || decision.action === "merge") && decision.target_ids.length > 0 && vectorStore) {
    try {
      const existing = await vectorStore.queryL1Records({ recordIds: decision.target_ids });
      for (const row of existing) targetVersionById.set(row.record_id, row.version ?? 0);
      const maxVersion = existing.reduce((max, row) => Math.max(max, row.version ?? 0), 0);
      nextVersion = maxVersion + 1;
    } catch (err) {
      logger?.warn?.(`${TAG} Failed to read existing memory version, defaulting to v0: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Determine final content, type, priority based on action
  let finalContent: string;
  let finalType: MemoryType;
  let finalPriority: number;
  let finalTimestamps: string[];

  if (decision.action === "merge" || decision.action === "update") {
    finalContent = decision.merged_content ?? memory.content;
    finalType = decision.merged_type ?? memory.type;
    finalPriority = decision.merged_priority ?? memory.priority;
    finalTimestamps = decision.merged_timestamps ?? [now];
  } else {
    // store
    finalContent = memory.content;
    finalType = memory.type;
    finalPriority = memory.priority;
    finalTimestamps = [now];
  }

  // ── 归一护栏下沉到写库层（2026-10-20 批次 2.1）──
  // 护栏原先只在抽取层作用于 mem.content（l1-extractor.ts:281），漏掉了两条路径：
  //   1. 去重后写库内容取 decision.merged_content（LLM 二次输出），从不经过护栏
  //      —— 实测 6 行 version>0 的记忆带未归一的「用户（X）」；
  //   2. scene_name 原样赋值（l1-extractor.ts:289），完全没被护栏覆盖
  //      —— 实测 198 行（9.83%）带非白名单标签。
  // writeMemory 是两条写路径（l1-extractor.ts:895 / :945）的唯一汇聚点，
  // 在这里统一处理才不会再有旁路。
  const safeContent = sanitizeUserAttribution(finalContent, userIdentityNames);
  const safeSceneName = memory.scene_name
    ? sanitizeUserAttribution(memory.scene_name, userIdentityNames)
    : { text: memory.scene_name, dropped: [] as string[] };
  const droppedLabels = [...safeContent.dropped, ...safeSceneName.dropped];
  if (droppedLabels.length > 0) {
    logger?.warn?.(
      `${TAG} attribution normalized on write: dropped=[${droppedLabels.join(", ")}] ` +
      `(content=${safeContent.dropped.length}, scene_name=${safeSceneName.dropped.length})`,
    );
  }

  const record: MemoryRecord = {
    id: decision.record_id || generateMemoryId(),
    content: safeContent.text,
    type: finalType,
    priority: finalPriority,
    scene_name: safeSceneName.text,
    source_message_ids: memory.source_message_ids,
    metadata: memory.metadata,
    timestamps: finalTimestamps,
    createdAt: now,
    updatedAt: now,
    version: nextVersion,
    sessionKey,
    sessionId: sessionId || DEFAULT_ISOLATION_ID,
    taskId,
    teamId,
    // Tenancy isolation — propagated end-to-end so SQLite / TCVDB upsert
    // can persist the row's owner. Empty strings preserve pre-isolation
    // behaviour for callers that haven't been updated yet.
    userId: userId || DEFAULT_ISOLATION_ID,
    agentId: agentId || DEFAULT_ISOLATION_ID,
  };

  const shardDate = formatLocalDate(new Date());
  const recordKey = StoragePaths.record(shardDate);

  // Helper: append a JSONL line
  // - standalone (no storage): write to local fs
  // - service (storage provided): write via StorageAdapter, no fs fallback
  //
  // Guard log (CR-2 fix, 2026-05-19): if storage is absent, emit a warn so any
  // missed wiring (e.g. caller forgot to pass storage in service mode) is
  // immediately visible instead of silently writing to ephemeral pod fs.
  // In standalone mode this warn is benign — the gateway auto-wires a
  // LocalStorageBackend at startup (server.ts:199-203), so storage should
  // normally be defined. Seeing this warn = caller forgot to pass it.
  const appendRecord = async (line: string) => {
    if (storage) {
      await storage.appendFile(recordKey, line);
    } else {
      logger?.warn?.(
        `${TAG} [CR-2 guard] writeMemory called without storage adapter; ` +
        `falling back to local fs at ${baseDir}/records/${shardDate}.jsonl. ` +
        `In service mode this means JSONL is written to ephemeral pod fs and ` +
        `will be lost on restart. Caller must pass 'storage' to writeMemory.`,
      );
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const recordsDir = path.default.join(baseDir, "records");
      await fs.default.mkdir(recordsDir, { recursive: true });
      await fs.default.appendFile(path.default.join(recordsDir, `${shardDate}.jsonl`), line, "utf-8");
    }
  };

  if ((decision.action === "update" || decision.action === "merge") && decision.target_ids.length > 0) {
    // Remove target records from VectorStore (real-time deletion for retrieval accuracy).
    // JSONL is append-only — old records remain in files and are cleaned up periodically
    // by memory-cleaner (which reconciles against VectorStore as source of truth).
    if (vectorStore) {
      try {
        // 票15（2026-10-24）：删除过滤收窄到租户三维（teamId/userId/agentId），
        // 与 dedup 召回读边界对齐（召回刻意跨会话，P2-④ 并行安全）。此前过滤
        // 含 sessionId/sessionKey，跨会话合并的目标删不掉（读跨会话/删不跨会话
        // 不对称）→ 合并半生效：合并版入库、目标残留、重复堆积（票12 审计实证
        // 48 目标 29 存活）。跨租户保护不变（rowMatchesIsolation 对租户字段照常拦截）。
        const deleteFilter = teamId || userId || agentId
          ? { teamId, userId, agentId }
          : undefined;
        if (deleteFilter) {
          await vectorStore.deleteL1Batch(decision.target_ids, deleteFilter);
        } else {
          await vectorStore.deleteL1Batch(decision.target_ids);
        }
        logger?.debug?.(`${TAG} VectorStore: deleted ${decision.target_ids.length} target record(s) for ${decision.action}`);
        // 审计（2026-10-27，用户令「合并/删除路径进审计表」）：被合并/更新吸收掉
        // 的目标逐条记 delete（version 取删除前的真实版本）。此前管线内部删除不进
        // memory_audit，只能靠日志锚点回溯。
        for (const targetId of decision.target_ids) {
          await appendAuditSafe(
            vectorStore,
            {
              record_id: targetId,
              action: "delete",
              version: targetVersionById.get(targetId) ?? 0,
              requestId: auditRequestId,
              iso: { teamId, userId, agentId, taskId },
            },
            logger,
          );
        }
      } catch (err) {
        logger?.warn?.(
          `${TAG} VectorStore delete failed for ${decision.action}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    try {
      await appendRecord(JSON.stringify(record) + "\n");
    } catch (err) {
      logger?.warn?.(`${TAG} JSONL append failed (non-fatal, VDB write continues): ${err instanceof Error ? err.message : String(err)}`);
    }
    logger?.debug?.(`${TAG} ${decision.action} memory: removed [${decision.target_ids.join(",")}] from VectorStore → ${record.id}: ${finalContent.slice(0, 80)}...`);
  } else {
    // store: append a new line
    try {
      await appendRecord(JSON.stringify(record) + "\n");
    } catch (err) {
      logger?.warn?.(`${TAG} JSONL append failed (non-fatal, VDB write continues): ${err instanceof Error ? err.message : String(err)}`);
    }
    logger?.debug?.(`${TAG} Stored memory ${record.id}: ${finalContent.slice(0, 80)}...`);
  }

  // === Vector Store dual-write ===
  if (vectorStore) {
    try {
      logger?.debug?.(
        `${TAG} [vec-dual-write] START id=${record.id}, contentLen=${record.content.length}, ` +
        `content="${record.content.slice(0, 80)}..."`,
      );

      let embedding: Float32Array | undefined;

      if (embeddingService) {
        try {
          embedding = await embeddingService.embed(record.content);
          logger?.debug?.(
            `${TAG} [vec-dual-write] Embedding OK: dims=${embedding.length}, ` +
            `norm=${Math.sqrt(Array.from(embedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}`,
          );
        } catch (embedErr) {
          // Embedding failed — pass undefined to upsert() which writes
          // metadata + FTS only, skipping the vec0 table.
          logger?.warn(
            `${TAG} [vec-dual-write] Embedding FAILED for id=${record.id}, ` +
            `will write metadata only: ${embedErr instanceof Error ? embedErr.message : String(embedErr)}`,
          );
        }
      }

      const upsertOk = await vectorStore.upsertL1(record, embedding);
      logger?.debug?.(`${TAG} [vec-dual-write] upsert result=${upsertOk} id=${record.id}`);
      // 审计（2026-10-27）：合并/更新产出的新版本记 update（version=nextVersion）。
      // store 是新增，不写审计——审计语义只覆盖 update/delete。
      if (upsertOk && (decision.action === "merge" || decision.action === "update")) {
        await appendAuditSafe(
          vectorStore,
          {
            record_id: record.id,
            action: "update",
            version: record.version ?? nextVersion,
            requestId: auditRequestId,
            iso: { teamId, userId, agentId, taskId },
          },
          logger,
        );
      }
    } catch (err) {
      // Vector write failure should NOT block the main JSONL write
      logger?.warn?.(
        `${TAG} [vec-dual-write] FAILED (JSONL already written) id=${record.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    logger?.debug?.(
      `${TAG} [vec-dual-write] SKIPPED id=${record.id}: vectorStore=${!!vectorStore}`,
    );
  }

  return record;
}

// ============================
// Helpers
// ============================

/**
 * 审计追加（2026-10-27）：memory_audit 此前只由 v2-router / chat-memory-handlers
 * （外部请求侧）写入，管线内部 L1 merge/update 从不落审计——当日巡检实证 27 次
 * merge 决策零对应行。此处补写 L1 的 delete（被吸收目标）与 update（合并版）。
 * 失败只 warn、不阻塞主流程（与 v2-router recordAudit 语义一致）；store 不支持
 * appendAudit 时自动跳过。
 */
async function appendAuditSafe(
  store: IMemoryStore | undefined,
  entry: {
    record_id: string;
    action: "update" | "delete";
    version: number;
    requestId: string;
    iso: { teamId?: string; userId?: string; agentId?: string; taskId?: string };
  },
  logger?: Logger,
): Promise<void> {
  if (!store?.appendAudit) return;
  try {
    await store.appendAudit({
      audit_id: `audit-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      record_id: entry.record_id,
      layer: "L1",
      action: entry.action,
      team_id: entry.iso.teamId,
      agent_id: entry.iso.agentId,
      user_id: entry.iso.userId,
      task_id: entry.iso.taskId,
      version: entry.version,
      updated_at_ms: Date.now(),
      request_id: entry.requestId,
    });
  } catch (err) {
    logger?.warn?.(
      `${TAG} audit append failed (L1/${entry.action} record=${entry.record_id}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}