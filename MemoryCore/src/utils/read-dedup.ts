/**
 * 票 TICKETS-C-read-dedup-20261113.md：L2 scene-extract **run 内** read 结果去重。
 *
 * 动机（实测 2026-11-13 gateway.out）：L2 scene-extract 的 LLM 通过 storage-tools
 * `read` 分页读大场景文件（offset/limit），对同一文件/同一窗口反复读——单 task
 * `scene-extract-1794526320691` 达 24 次读（2 次全文 + 22 次窗口小读），run_chars
 * 峰值 147,955 破 80K run 帽。`readCacheMetrics`（2026-10-27）已测出 71.1% 全文
 * 重读率，但只计量不生效，每次重读全额计入 run 预算并再次进入提示词。
 *
 * 本模块零 I/O：键构造 + 进程内 Map + 写失效。接线见 storage-tools.ts。
 *
 * 安全性：命中时返回的 output 与首次读**逐字节相同**（同 storageKey 同参数同文件
 * 内容），对 LLM 等价于重复读的结果，零语义变化、无「上下文缺片段」风险。
 * 作用域 = 一次 toolset = 一次 run（与 ReadBudgetTracker 同生命周期），跨 run 归零，
 * 不引入跨 run 陈旧风险。
 */

export const READ_DEDUP_ANCHOR = "read-dedup";

/** 读参数归一后的去重键输入。 */
export interface ReadDedupArgs {
  offset?: number;
  limit?: number;
  includeInvalidated?: boolean;
  includeArchive?: boolean;
}

/** 一次 note 的观测结果。 */
export interface ReadDedupNote {
  /** 若启用去重，本次读是否可直接命中（同 run 内同参数已读过）。 */
  wouldDedup: boolean;
  /** 本次可省的字符数（命中时 = 本次 output 长度；未命中 0）。 */
  savedChars: number;
  /** 本 run 累计去重次数。 */
  dedupCount: number;
  /** 当前缓存条目数。 */
  entries: number;
}

/** 默认条目上限（与 READ_CACHE_MAX_ENTRIES 同量级：单 run 读次数远小于此）。 */
export const READ_DEDUP_MAX_ENTRIES = 256;

/** 布尔/未定义归一：undefined 与 false 同键（缺省即 false）。 */
function normBool(v: boolean | undefined): string {
  return v === true ? "1" : "0";
}

/**
 * 去重键：storageKey|offset|limit|includeInvalidated|includeArchive。
 * 数值用 String 归一（NaN/Infinity 有稳定字符串形态，不会抛）。
 */
export function readDedupKey(storageKey: string, args: ReadDedupArgs): string {
  return [
    storageKey,
    String(args.offset),
    String(args.limit),
    normBool(args.includeInvalidated),
    normBool(args.includeArchive),
  ].join("|");
}

/**
 * run 内 read 去重跟踪器（一次 toolset 一个实例）。
 *
 * - `note`：记账（shadow 计量用）；首次记 miss，同参重复记 hit
 * - `get`：on 模式取缓存 output（命中返回首次字节串，未命中 undefined）
 * - `invalidate`：写/ edit 同 storageKey 后作废该 key 全部条目（陈旧防护）
 */
export class ReadDedupTracker {
  private readonly cache = new Map<string, string>();
  private dedupHits = 0;
  private saved = 0;

  constructor(private readonly maxEntries: number = READ_DEDUP_MAX_ENTRIES) {}

  /** 记账并返回观测值。**不**因此改变调用方行为（是否真去重由调用方按 mode 决定）。 */
  note(p: { storageKey: string; output: string; args: ReadDedupArgs }): ReadDedupNote {
    const k = readDedupKey(p.storageKey, p.args);
    const hit = this.cache.has(k);
    if (hit) {
      this.dedupHits += 1;
      this.saved += p.output.length;
      // LRU：命中刷新到队尾
      this.cache.delete(k);
    }
    this.cache.set(k, p.output);
    this.evict();
    return {
      wouldDedup: hit,
      savedChars: hit ? p.output.length : 0,
      dedupCount: this.dedupHits,
      entries: this.cache.size,
    };
  }

  /** on 模式：取本次读的缓存结果（未命中 undefined）。只读，不刷新 LRU。 */
  get(storageKey: string, args: ReadDedupArgs): string | undefined {
    return this.cache.get(readDedupKey(storageKey, args));
  }

  /** 写/edit 失效：作废该 storageKey 的全部窗口条目。 */
  invalidate(storageKey: string): void {
    const prefix = `${storageKey}|`;
    for (const k of [...this.cache.keys()]) {
      if (k.startsWith(prefix)) this.cache.delete(k);
    }
  }

  /** 本 run 累计去重次数。 */
  get dedupCount(): number {
    return this.dedupHits;
  }

  /** 本 run 累计可省字符数。 */
  get savedChars(): number {
    return this.saved;
  }

  /** 当前条目数。 */
  get entries(): number {
    return this.cache.size;
  }

  private evict(): void {
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

/** 稳定锚点日志行（同 read-budget / read-cache-metrics 形态，便于 grep 与验收聚合）。 */
export function formatReadDedupNote(
  note: { wouldDedup: boolean; savedChars: number; dedupCount: number; entries: number },
  path: string,
  chars: number,
  taskId?: string,
): string {
  return (
    `${READ_DEDUP_ANCHOR} would_dedup=${note.wouldDedup} path="${path}" chars=${chars} ` +
    `saved_chars=${note.savedChars} dedup_count=${note.dedupCount} entries=${note.entries} ` +
    `task_id=${taskId ?? "(none)"}`
  );
}

// ── T2：persona.l2ReadDedup 配置解析（拒绝式·同 parseFactSupersedeConfig 先例）──

export type L2ReadDedupMode = "shadow" | "on";

export interface L2ReadDedupConfig {
  /** shadow=只打 metric 不改行为（read 照常返回原文并计预算）；on=命中返回缓存且不计预算。 */
  mode: L2ReadDedupMode;
}

/**
 * 解析 `persona.l2ReadDedup`：
 * - undefined/null/false → undefined（off，工具 schema 与行为逐字节不变）
 * - true → { mode: "shadow" }（安全默认=影子先量）
 * - 对象 → mode 缺省 "shadow"；mode=off → undefined
 * - 非法 mode / 非布尔非对象 → throw（不静默回落）
 */
export function parseL2ReadDedupConfig(raw: unknown): L2ReadDedupConfig | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;
  if (raw === true) return { mode: "shadow" };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("persona.l2ReadDedup 必须为布尔或对象（{mode}）");
  }
  const modeRaw = (raw as Record<string, unknown>).mode ?? "shadow";
  if (modeRaw !== "shadow" && modeRaw !== "on" && modeRaw !== "off") {
    throw new Error(`persona.l2ReadDedup.mode 非法: ${String(modeRaw)}（只允许 off|shadow|on）`);
  }
  if (modeRaw === "off") return undefined;
  return { mode: modeRaw };
}
