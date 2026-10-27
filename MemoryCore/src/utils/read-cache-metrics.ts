/**
 * 读取缓存影子计量（2026-10-27）。
 *
 * 只回答一个问题：如果把 read 结果按内容哈希缓存，会命中多少次？
 * **不改变任何行为**——read 仍返回全文，不缓存内容、不跳过 I/O、不计入单独的预算。
 *
 * 为什么需要：审查测得「跨 run 同文件同 size」占 54.8%，但同 size 不等于同内容，
 * 必须用真实哈希核实；同时 per-run（同一次 run 内重复读）只有 2.7%，说明缓存
 * 若只做在 toolset 层收益很小，需要进程级/跨 run 的 key 才有意义。
 *
 * 失效语义与真实缓存一致：同一 key 内容变了 → 下一次读记 miss（等价于 edit/write
 * 后失效），内容改回原样则会重新命中。
 */
import { createHash } from "node:crypto";

export const READ_CACHE_ANCHOR = "read-cache-metrics";
export const READ_CACHE_MAX_ENTRIES = 512;

export interface ReadCacheNote {
  /** 若此刻启用内容哈希缓存，本次读取是否可直接命中。 */
  wouldHit: boolean;
  /** 内容 sha1（日志里只输出前 12 位）。 */
  hash: string;
  /** 计量表当前条目数。 */
  entries: number;
}

export class ReadCacheMetrics {
  private readonly seen = new Map<string, string>();

  constructor(private readonly maxEntries: number = READ_CACHE_MAX_ENTRIES) {}

  /**
   * @param key 归一化后的读取 key（storage: resolveStorageKey 的返回值；
   *            sandbox: resolveSandboxedPath 的绝对路径），不要用模型传来的原始 path。
   */
  note(key: string, content: string): ReadCacheNote {
    const hash = createHash("sha1").update(content).digest("hex");
    const prev = this.seen.get(key);
    const wouldHit = prev === hash;

    // LRU：命中/更新都刷新到队尾
    if (prev !== undefined) this.seen.delete(key);
    this.seen.set(key, hash);

    if (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }

    return { wouldHit, hash, entries: this.seen.size };
  }

  get size(): number {
    return this.seen.size;
  }
}

/** 进程级单例：跨 run 累计，才能反映真实缓存的上限收益。 */
export const readCacheMetrics = new ReadCacheMetrics();

/** 稳定锚点，便于 grep 与验收脚本聚合。 */
export function formatReadCacheNote(
  note: ReadCacheNote,
  path: string,
  chars: number,
  taskId?: string,
): string {
  return (
    `${READ_CACHE_ANCHOR} would_hit=${note.wouldHit} path="${path}" chars=${chars} ` +
    `hash=${note.hash.slice(0, 12)} entries=${note.entries} task_id=${taskId ?? "(none)"}`
  );
}
