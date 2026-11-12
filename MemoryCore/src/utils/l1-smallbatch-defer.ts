// 票 P2-A2（exp/p2-a2-l1-smallbatch-defer）：L1 小批空转攒批——pure 决策/配置解析。
//
// 背景（实测证据 2026-11-12，1MB 尾窗）：178 轮 l1-empty 中 171 轮（96%）
// inputMsgs ≤3——小会话频繁触发、每轮一次 LLM 调用判「无可记」
// （reason=empty_scenes 177=合法空判定），每窗口数百 K tokens 纯判空消耗。
//
// 机制：小批不立即提取 → defer（游标不动，沿用 P0-Fix2 defer 语义）→ 消息自然
// 累积 → 下轮批次变大 → 越过门槛才提取。零内容丢失由游标语义保证：cursor 按
// recorded_at_ms 推进，defer 不调 markL1ExtractionComplete ⇒ 下轮查询 >cursor
// 必含旧+新消息（审查已证）。
//
// 三变体只差 defer 判据，本实现取 S3 组合判据（条数 OR 内容，取更保守者）：
// 一次代码路径 + shadow 双信号计量（qualified/chars）⇒ 事后回算 S1/S2/S3 择优。
//
// 精确判据（票面「审查放行+三项补齐」·P1-1）：
//   defer ⇔ (全片 qualified 总数 > 0)
//         ∧ (各组 qualified 均 < minMessages)
//         ∧ (本片 qualified 总 chars < minChars)
//         ∧ (age(切片最旧行) ≤ maxDeferAgeMs)
//         ∧ 无残余行（queriedCount ≤ sliceEnd）
//   - qualified==0（全噪声批）→ 不 defer：保持现行免 LLM 早返回语义；
//   - 有残余行 → 不 defer：保 backlog drain 不停摆（补齐 2）；
//   - age 超阈 → 强制提取：防小批关键事实无限延迟（S1 强制项）。
//
// 本模块零 I/O（接线见 pipeline-factory.ts createL1Runner 组并行池前）。

export type L1SmallBatchDeferMode = "shadow" | "on";

export interface L1SmallBatchDeferConfig {
  /** 恒 true（parse 已把 off 归一为 undefined）；保留字段对齐 l1Archive 先例。 */
  enabled: boolean;
  /** shadow=只计量不 defer（同输入照常提取）；on=真 defer。 */
  mode: L1SmallBatchDeferMode;
  /** 条数门槛 K：组 qualified < K 才可能 defer（S1）。 */
  minMessages: number;
  /** 内容门槛 L：本片 qualified 总 chars < L 才可能 defer（S2/S3 字符支）。 */
  minChars: number;
  /** defer 年龄上限（ms）：age(切片最旧行) 超阈 → 强制提取。 */
  maxDeferAgeMs: number;
}

/** true 的安全默认：shadow + K5 + chars200 + 30min（影子先量）。 */
export const L1_SMALLBATCH_DEFER_DEFAULT_MIN_MESSAGES = 5;
export const L1_SMALLBATCH_DEFER_DEFAULT_MIN_CHARS = 200;
export const L1_SMALLBATCH_DEFER_DEFAULT_MAX_DEFER_AGE_MS = 1_800_000; // 30 min

/**
 * minMessages 上限 = L1_BATCH_PROCESS（切片上限，pipeline-factory.ts:107）。
 * P0-4：>10 则门槛永不可达（每片最多 10 条）⇒ 机制退化永 defer。此处镜像常量
 * 避免 pure 模块 → pipeline-factory 的循环依赖；相等性由
 * l1-smallbatch-defer.test.ts 跨模块互钉测试锁定。
 */
export const L1_SMALLBATCH_DEFER_MAX_MIN_MESSAGES = 10;

/**
 * 解析 `persona.l1SmallBatchDefer`（同款先例：parseFactSupersedeConfig 拒绝式）：
 * - undefined/null/false → undefined（off，yaml 不写=行为逐字节不变）
 * - true → { enabled:true, mode:"shadow", minMessages:5, minChars:200, maxDeferAgeMs:1800000 }
 * - 对象 → 缺省字段回落；enabled=false / mode="off" → undefined
 * - 非法 mode / minMessages（正整数且 ≤10）/ minChars（有限 ≥0）/
 *   maxDeferAgeMs（正有限）/ 非布尔非对象 → throw（不静默回落）
 */
export function parseL1SmallBatchDeferConfig(raw: unknown): L1SmallBatchDeferConfig | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;
  if (raw === true) {
    return {
      enabled: true,
      mode: "shadow",
      minMessages: L1_SMALLBATCH_DEFER_DEFAULT_MIN_MESSAGES,
      minChars: L1_SMALLBATCH_DEFER_DEFAULT_MIN_CHARS,
      maxDeferAgeMs: L1_SMALLBATCH_DEFER_DEFAULT_MAX_DEFER_AGE_MS,
    };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("persona.l1SmallBatchDefer 必须为布尔或对象（{enabled, mode, minMessages, minChars, maxDeferAgeMs}）");
  }
  const o = raw as Record<string, unknown>;
  const enabled = o.enabled ?? true;
  if (typeof enabled !== "boolean") {
    throw new Error(`persona.l1SmallBatchDefer.enabled 须为布尔: ${String(enabled)}`);
  }
  if (enabled === false) return undefined;
  const modeRaw = o.mode ?? "shadow";
  if (modeRaw !== "shadow" && modeRaw !== "on" && modeRaw !== "off") {
    throw new Error(`persona.l1SmallBatchDefer.mode 非法: ${String(modeRaw)}（只允许 shadow|on|off）`);
  }
  if (modeRaw === "off") return undefined;
  const minMessagesRaw = o.minMessages ?? L1_SMALLBATCH_DEFER_DEFAULT_MIN_MESSAGES;
  if (
    typeof minMessagesRaw !== "number"
    || !Number.isInteger(minMessagesRaw)
    || minMessagesRaw < 1
    || minMessagesRaw > L1_SMALLBATCH_DEFER_MAX_MIN_MESSAGES
  ) {
    throw new Error(
      `persona.l1SmallBatchDefer.minMessages 须为 1..${L1_SMALLBATCH_DEFER_MAX_MIN_MESSAGES} 的整数: ${String(minMessagesRaw)}`,
    );
  }
  const minCharsRaw = o.minChars ?? L1_SMALLBATCH_DEFER_DEFAULT_MIN_CHARS;
  if (typeof minCharsRaw !== "number" || !Number.isFinite(minCharsRaw) || minCharsRaw < 0) {
    throw new Error(`persona.l1SmallBatchDefer.minChars 须为有限非负数值: ${String(minCharsRaw)}`);
  }
  const maxDeferAgeRaw = o.maxDeferAgeMs ?? L1_SMALLBATCH_DEFER_DEFAULT_MAX_DEFER_AGE_MS;
  if (typeof maxDeferAgeRaw !== "number" || !Number.isFinite(maxDeferAgeRaw) || maxDeferAgeRaw <= 0) {
    throw new Error(`persona.l1SmallBatchDefer.maxDeferAgeMs 须为正有限数值(ms): ${String(maxDeferAgeRaw)}`);
  }
  return {
    enabled: true,
    mode: modeRaw,
    minMessages: minMessagesRaw,
    minChars: minCharsRaw,
    maxDeferAgeMs: maxDeferAgeRaw,
  };
}

/** 单组（sid）的 quality-gate 后统计。 */
export interface L1SmallBatchDeferGroupStat {
  /** 组 sessionId（空串表示空 sessionId）。 */
  sessionId: string;
  /** quality-gate（shouldExtractL1）后的 qualified 条数。 */
  qualified: number;
  /** qualified 消息的总字符数。 */
  chars: number;
}

/** 未 defer 的原因（shadow 观测/日志用；defer=true 时 undefined）。 */
export type L1SmallBatchDeferNoDeferReason =
  | "no_qualified" // 全噪声批：保持现行免 LLM 早返回语义
  | "residual_rows" // 有残余行：保 backlog drain
  | "group_qualified" // 任一组 qualified ≥ minMessages
  | "min_chars" // qualified 总 chars ≥ minChars（单条长消息含事实）
  | "max_defer_age"; // age(最旧行) 超阈：强制提取

export interface L1SmallBatchDeferDecision {
  /** true = 本片延后攒批（runner early-return，游标不动）。 */
  defer: boolean;
  /** 全片 qualified 总数（shadow 观测量）。 */
  qualified: number;
  /** 全片 qualified 总字符（shadow 观测量）。 */
  chars: number;
  /** qualified ≥ minMessages 的组数（P0-1：任一组达标即整片提取）。 */
  qualifiedGroups: number;
  /** age(切片最旧行) = nowMs - oldestRecordedAtMs（P1-3 起算点·零新状态）。 */
  ageMs: number;
  /** 未 defer 的原因；defer=true 时为 undefined。 */
  reason?: L1SmallBatchDeferNoDeferReason;
}

/**
 * 小批延后判据（pure·零 I/O）。输入即 runner 组并行池前可得的全部信息：
 * 分组统计、切片最旧行 recordedAtMs、当前时刻、有无残余行。
 */
export function deferDecision(params: {
  /** 按 sid 分组的 qualified/chars 统计（整片 all-or-nothing）。 */
  groups: L1SmallBatchDeferGroupStat[];
  /** 本片（切片）最旧行的 recordedAtMs；age 起算点（P1-3）。 */
  oldestRecordedAtMs: number;
  /** 当前时刻（调用方 Date.now()，保持 pure）。 */
  nowMs: number;
  /** 有残余行（queriedCount > sliceEnd）→ 不 defer（补齐 2 保 drain）。 */
  hasResidual: boolean;
  cfg: L1SmallBatchDeferConfig;
}): L1SmallBatchDeferDecision {
  const { groups, oldestRecordedAtMs, nowMs, hasResidual, cfg } = params;
  let qualified = 0;
  let chars = 0;
  let qualifiedGroups = 0;
  for (const g of groups) {
    qualified += g.qualified;
    chars += g.chars;
    if (g.qualified >= cfg.minMessages) qualifiedGroups += 1;
  }
  const ageMs = nowMs - oldestRecordedAtMs;

  // 判据求值顺序即 reason 的信息量优先序；布尔结果与顺序无关（合取式）。
  if (qualified === 0) {
    // 全噪声批：现行实现会在 extractor 内免 LLM 早返回并推进游标——保持该语义，
    // 不进攒批（P1-1）。
    return { defer: false, qualified, chars, qualifiedGroups, ageMs, reason: "no_qualified" };
  }
  if (hasResidual) {
    // 残余行存在：按现行提取保 drain，否则 backlog 排空会被低 qualified 头片
    // 停摆至 maxDeferAge（补齐 2）。
    return { defer: false, qualified, chars, qualifiedGroups, ageMs, reason: "residual_rows" };
  }
  if (qualifiedGroups > 0) {
    // P0-1 all-or-nothing：任一组达门槛 → 整片全提取（禁按组 defer，否则被
    // defer 组的消息会被单游标整片推进永久跳过）。
    return { defer: false, qualified, chars, qualifiedGroups, ageMs, reason: "group_qualified" };
  }
  if (chars >= cfg.minChars) {
    // S2：单条长消息含事实时立即提取的价值。
    return { defer: false, qualified, chars, qualifiedGroups, ageMs, reason: "min_chars" };
  }
  if (ageMs > cfg.maxDeferAgeMs) {
    // S1 强制项：小批关键事实不无限延迟。
    return { defer: false, qualified, chars, qualifiedGroups, ageMs, reason: "max_defer_age" };
  }
  return { defer: true, qualified, chars, qualifiedGroups, ageMs };
}
