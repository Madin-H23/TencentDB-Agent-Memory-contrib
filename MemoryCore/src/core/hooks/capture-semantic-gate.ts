/**
 * 票④b：捕获语义门（SPEC v2 §5）。
 *
 * 目标：捕获时识别「L0 以新措辞复述在案 L1 事实」的改写型重投——票④ hash 门
 * 接不住的形态。两段式：
 *   ① 消息现算向量（不依赖 l0_vec，L0 延迟嵌入可能落后）→ `searchL1Vector` KNN；
 *   ② 只有 score = 1 - distance ≥ threshold 的候选才进 LLM 判定（复用 M1 判定链）。
 *
 * 关键约束（SPEC §2.6 / §6 / §11）：
 * - **不复用 `batchDedup`**：它会二次 embed + 二次 KNN；这里直接复用 M1 判定链
 *   （`runLlmJudgment` 内部即 `formatBatchConflictPrompt` + LLM 调用）。
 * - `searchL1Vector` 本身无阈值（score=1-distance、按 topK 截断），阈值过滤在本模块内做。
 * - 只消费 `action === "skip"`；store/update/merge 一律放行，且绝不落库。
 * - 任一步异常/超时/维度不符/表未建/空向量 → **整批放行 + failopen=true**。
 * - key 不进日志：所有错误串经 `redactError`。
 * - `mode=shadow`：完整执行并计数，但 `excludedMessageIds` 恒空（真排除只发生在 on）；
 *   接线层对 shadow 走后台 fire-and-forget（纯计量，不阻塞捕获响应）。
 * - 配置解析在零依赖的 `capture-semantic-gate.config.ts`（config.ts 解析期不拉起
 *   l1-dedup 依赖链），本模块 re-export 保持既有 import 路径。
 */

import type { MemoryPromptMode } from "../../config.js";
import { hasClientEmbedding, type EmbeddingService } from "../store/embedding.js";
import type { IMemoryStore, IsolationFilter, L1SearchResult } from "../store/types.js";
import type { ExtractedMemory, MemoryRecord, DedupDecision, DedupAction, MemoryType } from "../record/l1-writer.js";
import { runLlmJudgment } from "../record/l1-dedup.js";
import type { CandidateMatch } from "../prompts/l1-dedup.js";
import type { LLMRunner, Logger } from "../types.js";
import { redactError } from "../../utils/redact-secrets.js";
import {
  CAPTURE_SEMANTIC_GATE_DEFAULTS,
  parseSemanticGateConfig,
  type CaptureSemanticGateConfig,
  type SemanticGateMode,
} from "./capture-semantic-gate.config.js";

const TAG = "[memory-tdai][capture-semantic-gate]";

// ============================
// Config（拆到零依赖模块：config.ts 解析期不拉起 l1-dedup 依赖链）
// ============================

export { CAPTURE_SEMANTIC_GATE_DEFAULTS, parseSemanticGateConfig };
export type { CaptureSemanticGateConfig, SemanticGateMode };

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
  /**
   * 每条已判定消息的 top1 相似度直方图（20 桶，下标 = floor(top1/0.05)，
   * 1.0 归入 19）。REVIEW §shadow 要求：仅记批次 top（最大值）无法事后回算
   * 其它阈值下的候选率，必须留每条消息的 top1 分布。
   */
  top1Buckets: number[];
  /** 按 role 的候选/命中计数（role 缺省归 unknown）。 */
  byRole: Record<string, { candidates: number; hits: number }>;
  /** 按判定动作计数（未达阈值 = none）。 */
  byAction: Record<DedupAction | "none", number>;
  /** 按消息码点长度分桶（REVIEW §shadow：长提示词/代码块误判风险观测）。 */
  byLen: { lt200: number; mid: number; gt1000: number };
  /**
   * 候选消息的判定样本（id/role/top1/action/target_ids），**不含正文**：
   * shadow 期抽检误杀时可按 id 回查 L0 JSONL / L1 记录。
   */
  samples: SemanticGateSample[];
}

/** 单条候选消息的 shadow 抽检样本（无正文，key 不进日志）。 */
export interface SemanticGateSample {
  id: string;
  role: string;
  top1: number;
  action: DedupAction | "none";
  targetIds: string[];
}

/** 20 桶 top1 直方图下标（0.0~1.0，1.0 归入最后一桶）。 */
export function top1BucketIndex(score: number): number {
  if (!Number.isFinite(score) || score <= 0) return 0;
  return Math.min(19, Math.floor(score / 0.05));
}

function emptyByAction(): Record<DedupAction | "none", number> {
  return { store: 0, update: 0, merge: 0, skip: 0, none: 0 };
}

function emptyByLen(): { lt200: number; mid: number; gt1000: number } {
  return { lt200: 0, mid: 0, gt1000: 0 };
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
    top1Buckets: new Array(20).fill(0) as number[],
    byRole: {},
    byAction: emptyByAction(),
    byLen: emptyByLen(),
    samples: [],
  };
  const logger = deps.logger;

  const failopen = (reason: string, err?: unknown): SemanticGateResult => {
    result.failopen = true;
    result.excludedMessageIds.clear();
    result.hits = 0;
    // 批次已整体放行：观测聚合不得留下半截样本，否则 shadow 统计口径被污染。
    result.top1Buckets = new Array(20).fill(0) as number[];
    result.byRole = {};
    result.byAction = emptyByAction();
    result.byLen = emptyByLen();
    result.samples = [];
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
  /** 每条已判定消息的观测快照（直方图/角色/动作/样本用；不含正文）。 */
  const observed: Array<{ id: string; role: string; top1: number; hasCandidate: boolean }> = [];
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

    let top1 = 0;
    for (const h of hits) {
      if (typeof h?.score === "number" && Number.isFinite(h.score)) {
        if (h.score > result.topScore) result.topScore = h.score;
        if (h.score > top1) top1 = h.score;
      }
    }
    // REVIEW §shadow：每条消息的 top1 落 20 桶直方图（不是只记批次最大值），
    // 使事后不重跑即可回算任意阈值下的候选率/排除量。
    const role = typeof judged[i]!.role === "string" && judged[i]!.role
      ? judged[i]!.role!
      : "unknown";
    if (!result.byRole[role]) result.byRole[role] = { candidates: 0, hits: 0 };
    result.top1Buckets[top1BucketIndex(top1)]!++;
    // REVIEW §shadow：长度分桶（问句/长提示词/代码块的误判通道观测）
    const len = codePointLength(judged[i]!.content);
    if (len < 200) result.byLen.lt200++;
    else if (len <= 1000) result.byLen.mid++;
    else result.byLen.gt1000++;

    const above = hits.filter((h) => typeof h?.score === "number" && h.score >= deps.threshold);
    if (above.length === 0) {
      observed.push({ id: judged[i]!.id, role, top1, hasCandidate: false });
      continue;
    }
    result.candidates++;
    result.byRole[role]!.candidates++;
    matches.push({ newMemory: toPseudoMemory(judged[i]!), candidates: above.map(toMemoryRecord) });
    observed.push({ id: judged[i]!.id, role, top1, hasCandidate: true });
  }

  // 无候选 → 不调 LLM（SPEC §5：候选非空才判定）
  if (matches.length === 0) {
    // 全部未达阈值：动作统一记 none（shadow 动作分布的分母）
    result.byAction.none += observed.length;
    return result;
  }

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
  const decisionByMsgId = new Map<string, DedupDecision>();
  for (const d of decisions) {
    if (!d || typeof d.record_id !== "string") continue;
    if (!d.record_id.startsWith("sem_")) continue;
    const msgId = d.record_id.slice(4);
    if (!judgedIds.has(msgId)) continue;
    decisionByMsgId.set(msgId, d);
    if (d.action === "skip") skipped.add(msgId);
  }
  result.hits = skipped.size;
  if (deps.mode === "on") {
    for (const id of skipped) result.excludedMessageIds.add(id);
  }

  // ⑦ shadow 观测聚合（REVIEW §shadow）：动作分布 / 按 role 命中 / 候选样本
  for (const o of observed) {
    if (!o.hasCandidate) {
      result.byAction.none++;
      continue;
    }
    const d = decisionByMsgId.get(o.id);
    // runLlmJudgment 默认 fillMissing=true，缺条按 store（放行）；此处同口径兜底。
    const action: DedupAction = d?.action ?? "store";
    result.byAction[action]++;
    if (action === "skip") result.byRole[o.role]!.hits++;
    result.samples.push({
      id: o.id,
      role: o.role,
      top1: o.top1,
      action,
      targetIds: Array.isArray(d?.target_ids) ? [...d.target_ids] : [],
    });
  }
  // mode=shadow：完整计数但不排除（排除集合保持空）
  return result;
}
