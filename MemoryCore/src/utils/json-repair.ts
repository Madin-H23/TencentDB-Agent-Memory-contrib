/**
 * 票18（2026-10-25）：查重判定解析加固的纯函数集。
 *
 * 三件套（方案 v2，方案审查 PASS 条件通过后定稿）：
 * 1. `escapeStrayQuotesInStrings`——B1 裸引号修复核心，自 l1-extractor.ts 原样上移共享
 *    （抽取链同票改为引用本实现，逻辑逐字节不变；幂等性由 b1-stray-quote-repair.test.ts
 *    全链钉 + 本文件直测双保险）。
 * 2. `extractJsonArraySpans`——A1 多候选均衡括号扫描器（替代贪婪 `/\[[\s\S]*\]/`：
 *    行文含 `[`/多 JSON 预览/截断 think 都会把首括到末括抓成非法片段）。
 * 3. `salvageJsonArrayTail`——A2 截断 salvage：数组未闭合（厂商侧中止）时收集完整
 *    顶层对象重解析前缀；只保留完整对象、零内容编造。
 *
 * 全部纯函数、字符串感知（转义处理）、O(n) 单遍。
 */

/**
 * B1（2026-10-16 引入，2026-10-25 上移共享）：字符串感知的未转义引号修复。LLM 常把
 * 英文双引号裸写进字符串值——JSON.parse 在第一个裸引号后即崩。逐字符扫描跟踪字符串
 * 上下文：字符串内的 `"` 若后续（跳过空白）不是结构字符（, } ] :）或输入结束，则视为
 * 内容一部分，转义为 \"。
 * 安全底线：合法 JSON 串内不存在裸引号（引号必以 \" 出现或即闭合），故合法输入经本
 * 函数逐字节原样返回——幂等性有专测。
 */
export function escapeStrayQuotesInStrings(json: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i]!;
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (ch === "\\") {
      // 转义序列（\" \\ \n 等）：反斜杠+下一字符原样保留
      out += ch + (json[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"') {
      // 真闭合 vs 裸引号：看后续第一个非空白字符
      let j = i + 1;
      while (j < json.length && /\s/.test(json[j]!)) j++;
      const next = json[j];
      if (next === undefined || next === "," || next === "}" || next === "]" || next === ":") {
        inString = false;
        out += ch;
      } else {
        out += '\\"'; // 内容里的裸引号 → 转义，内容不丢
      }
      continue;
    }
    out += ch;
  }
  return out;
}

/** 跳过 text[i]（必须是 `"`）起的字符串字面量，返回闭合引号之后的下标；未闭合返回 text.length。 */
function skipString(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length) {
    const ch = text[j]!;
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === '"') return j + 1;
    j++;
  }
  return text.length;
}

export interface JsonArraySpan {
  start: number;
  end: number; // 闭括号下标（含）
}

/**
 * A1：多候选均衡括号扫描器。依次尝试 text 中每个未消费的 `[`（字符串感知），从该处
 * 计深（`[`/`{` 加、`]`/`}` 减，字符串字面量整体跳过）走到配对括号——行文里的
 * `[rec_a1]`、JSON 预览、字符串内的括号都不再带偏；未闭合的 `[`（截断）不产出 span。
 * 返回按出现序的 span 列表（至多 maxCandidates 个，嵌套不单报——外层即可整体解析）。
 */
export function extractJsonArraySpans(text: string, maxCandidates = 8): JsonArraySpan[] {
  const spans: JsonArraySpan[] = [];
  let i = 0;
  while (i < text.length && spans.length < maxCandidates) {
    const ch = text[i]!;
    if (ch === '"') {
      i = skipString(text, i);
      continue;
    }
    if (ch !== "[") {
      i++;
      continue;
    }
    let depth = 1;
    let j = i + 1;
    let end = -1;
    while (j < text.length) {
      const c = text[j]!;
      if (c === '"') {
        j = skipString(text, j);
        continue;
      }
      if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
      j++;
    }
    if (end >= 0) {
      spans.push({ start: i, end });
      i = end + 1;
    } else {
      i++; // 未闭合：从下一个字符继续找候选（嵌套/后续的真数组仍有机会）
    }
  }
  return spans;
}

/**
 * A2：截断 salvage。对 text 中每个 `[` 候选进入数组上下文：收集「深度回到 0 的完整
 * 顶层对象」（只保留完整对象、零内容编造），到输入末尾仍未遇配对 `]`（厂商侧中止的
 * 截断形态）时，以「`[` 前缀 … 最后一个完整对象 `]`」重解析；遇 `]` 正常闭合则整体
 * 解析。任一候选成功且至少拿到一个对象即返回；全失败返回 null。
 * 注：salvage 不做白名单过滤——调用方（parseBatchResult）按批内 record_id 过滤，
 * 顺带封掉 LLM 幻觉条目。
 */
export function salvageJsonArrayTail(text: string): unknown[] | null {
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      i = skipString(text, i);
      continue;
    }
    if (ch !== "[") {
      i++;
      continue;
    }
    // 进入数组上下文（该 `[` 为数组开括号）
    let objectDepth = 0;
    let lastObjEnd = -1;
    let closedAt = -1;
    let j = i + 1;
    while (j < text.length) {
      const c = text[j]!;
      if (c === '"') {
        j = skipString(text, j);
        continue;
      }
      if (c === "{") objectDepth++;
      else if (c === "}") {
        objectDepth--;
        if (objectDepth === 0) lastObjEnd = j;
        if (objectDepth < 0) objectDepth = 0; // 行文噪声容错：不让你深变负
      } else if (c === "]" && objectDepth === 0) {
        closedAt = j;
        break;
      }
      j++;
    }
    const attempt =
      closedAt >= 0 ? text.slice(i, closedAt + 1) : lastObjEnd >= 0 ? `${text.slice(i, lastObjEnd + 1)}]` : null;
    if (attempt) {
      try {
        const parsed = JSON.parse(attempt) as unknown;
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch {
        // 该候选失败 → 下一个 `[`
      }
    }
    i++;
  }
  return null;
}
