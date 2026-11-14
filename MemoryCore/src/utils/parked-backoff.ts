/**
 * 票 origin#27（R1·parked 僵尸任务退避上限）：纯函数决策器+拒绝式配置。
 *
 * 缺陷实证（2026-11-14）：pipeline-worker 的 parked retry `entry.attempt` 无上限——
 * 锁持续被占的 scope 每轮重试失败后 attempt++ 永不放弃（uptime 7.8h 空转
 * 414→977 次；昨日重启清零后复发），且死信无出口只能靠重启清零。
 *
 * 机制：attempt 达 maxRetries → 该 parked 任务转 deadLetter（复用既有
 * moveToDeadLetter 落库+ACK 语义，零内容丢失——任务落死信队列可查）。
 * delay 本身沿用既有 getParkedRetryDelay 指数表（200/600/1800/5000+jitter）
 * 不在本模块管理。默认 off（未配置=现有无限重试行为逐字节不变）。
 */

export const PARKED_BACKOFF_DEFAULT_MAX_RETRIES = 8;

export type ParkedBackoffMode = "on";

export interface ParkedBackoffConfig {
  /** 锁冲突连续重试次数上限；达到即转 deadLetter。 */
  maxRetries: number;
}

/**
 * 解析 `maxParkedRetries`（worker 配置）：
 * - undefined/null/false → undefined（off=现有无限重试逐字节不变）
 * - true → { maxRetries: 8 }（安全默认）
 * - 对象 → maxRetries 必须正整数；mode=off → undefined
 * - 非法 → throw（不静默回落）
 */
export function parseParkedBackoffConfig(raw: unknown): ParkedBackoffConfig | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;
  if (raw === true) return { maxRetries: PARKED_BACKOFF_DEFAULT_MAX_RETRIES };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("maxParkedRetries 必须为布尔或对象（{maxRetries}）");
  }
  const o = raw as Record<string, unknown>;
  const mode = o.mode;
  if (mode === "off") return undefined;
  const n = o.maxRetries;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
    throw new Error(`maxParkedRetries.maxRetries 须为正整数: ${String(n)}`);
  }
  return { maxRetries: n };
}

export type ParkedRetryAction =
  | { action: "retry" }
  | { action: "dead-letter"; attempt: number };

/**
 * 单次锁冲突后的重试决策（纯函数）：
 * - cfg=undefined（off）→ 恒 retry（现有无限重试语义）
 * - attempt < maxRetries → retry（delay 由调用方 getParkedRetryDelay 既有表管理）
 * - attempt >= maxRetries → dead-letter（调用方将任务转死信并移出 parked 队列）
 */
export function parkedRetryDecision(params: {
  /** 当前 attempt（本词义：本次锁冲突是第 attempt+1 次失败·从 0 起）。 */
  attempt: number;
  cfg: ParkedBackoffConfig | undefined;
}): ParkedRetryAction {
  const { attempt, cfg } = params;
  if (!cfg) return { action: "retry" };
  if (attempt < cfg.maxRetries) return { action: "retry" };
  return { action: "dead-letter", attempt };
}
