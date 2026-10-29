/**
 * read 分段读（方案B）—— 字符窗口切片 + 截断标注。
 *
 * `storage-tools.ts` 与 `llm-runner.ts` 两处 read 工具共用本实现，保证语义同构。
 *
 * 语义：
 * - `offset` 缺省 0；`limit` 缺省 = 到文件尾。
 * - 返回 = `[offset, offset+limit)` 的逐字切片（UTF-16 code unit 口径，与
 *   read-budget 的 `content.length` 计量同口径）。
 * - 发生截断（offset>0 或 offset+limit<总长）时，在返回值末尾追加一行标注：
 *   `[... omitted N chars, offset=M limit=L of T total ...]`
 *   其中 N = 被省略的字符总数（T - 切片长度），M/L = 实际生效的 offset/limit，
 *   T = 文件总字符数。切片非空时标注独占一行（前缀 "\n"）；切片为空时返回值
 *   就是标注本身。
 * - 越界安全：offset ≥ 总长 → 返回空串 + 标注（不抛错）。
 * - 兼容钉：无 offset/limit（默认全文）时切片 = 全文且不截断 → 不追加任何
 *   标注，返回值与旧实现逐字节一致。
 * - 异常输入钳制：负 offset → 0；负 limit → 0；非有限数值（NaN/Infinity）视同
 *   缺省；非整数向下取整。
 */

export interface ReadWindowParams {
  offset?: number;
  limit?: number;
}

export function formatReadWindowMarker(
  omitted: number,
  offset: number,
  limit: number,
  total: number,
): string {
  return `[... omitted ${omitted} chars, offset=${offset} limit=${limit} of ${total} total ...]`;
}

export function applyReadWindow(content: string, params: ReadWindowParams = {}): string {
  const total = content.length;

  const rawOffset = params.offset;
  let start = typeof rawOffset === "number" && Number.isFinite(rawOffset) ? Math.floor(rawOffset) : 0;
  if (start < 0) start = 0;

  const rawLimit = params.limit;
  let limit: number;
  if (typeof rawLimit === "number" && Number.isFinite(rawLimit)) {
    limit = Math.floor(rawLimit);
    if (limit < 0) limit = 0;
  } else {
    limit = Math.max(0, total - start);
  }

  const end = Math.min(total, start + limit);
  const slice = content.slice(start, end);

  const truncated = start > 0 || end < total;
  if (!truncated) return slice;

  const omitted = total - slice.length;
  const marker = formatReadWindowMarker(omitted, start, limit, total);
  return slice.length > 0 ? `${slice}\n${marker}` : marker;
}
