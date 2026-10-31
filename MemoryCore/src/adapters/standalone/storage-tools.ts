/**
 * Storage-backed LLM tool definitions — drop-in replacement for the local-FS
 * sandboxed tools in `llm-runner.ts`.
 *
 * Used in service mode (COS) so that L2/L3 LLM agents read/write files via
 * StorageAdapter instead of the local filesystem.
 *
 * Tool names and schemas are **identical** to `createSandboxedTools`, so
 * LLM prompts work unchanged.
 */

import { tool, jsonSchema } from "ai";
import type { StorageAdapter } from "../../core/storage/adapter.js";
import {
  ReadBudgetTracker,
  formatReadBudgetObservation,
} from "../../utils/read-budget.js";
import { readCacheMetrics, formatReadCacheNote } from "../../utils/read-cache-metrics.js";
import { applyReadWindow } from "../../utils/read-window.js";
import { checkSceneCharCap } from "../../utils/scene-char-cap.js";
import {
  checkAnchorPreservation,
  checkSceneCharCapWithSupersede,
  filterSupersededLines,
  findUnrelocatedAnchors,
  supersedeDelta,
  type AnchorLossRejection,
  RELOCATE_HINT,
} from "../../utils/supersede.js";

const TAG = "[memory-tdai] [storage-tools]";

interface Logger {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

/**
 * Resolve a relative path within a storage prefix boundary (sandbox).
 *
 * Returns the full storage key (prefix + normalized path), or null if the
 * path escapes the prefix boundary (e.g. "../" traversal).
 */
function resolveStorageKey(prefix: string, relativePath: string): string | null {
  // Normalize: strip leading ./ , convert backslashes, collapse //
  const normalized = relativePath
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");

  // Block absolute paths and parent traversal
  if (normalized.startsWith("/") || normalized.startsWith("..")) return null;

  // After join, verify the result still starts with prefix
  const key = `${prefix}${normalized}`;

  // Double-check: split and reject any ".." segment
  if (normalized.split("/").includes("..")) return null;

  return key;
}

/**
 * Create storage-backed read/write/edit tools.
 *
 * @param storage    - StorageAdapter instance (COS or local backend)
 * @param prefix     - Key prefix acting as sandbox root (e.g. "scene_blocks/")
 * @param logger     - Optional logger for diagnostics
 */
export function createStorageTools(
  storage: StorageAdapter,
  prefix: string,
  logger?: Logger,
  /** 2026-10-27：run 归属，写进 read-budget 锚点（验收按 run 聚合）。 */
  taskId?: string,
  /**
   * 方案C（exp/l2-plan-c-write-cap）：L2 场景块写入后像尺寸帽（字符数，≤0/undefined=off）。
   * 只对场景块前缀（prefix 非空）生效；L3 persona（prefix 为空）不受限 —— 作用域在工厂
   * 内定死，调用方传错也不会殃及 persona。
   */
  sceneCharCap?: number,
  /**
   * [P1 票⑥ 显式失效替代硬删]：read 默认过滤 [SUPERSEDED] 失效行（includeInvalidated
   * 审计）；write/edit 落盘前行级保锚守卫（锚点 m_<ts>_<hash> 永不物理删除）+
   * [DELETED] 软删流文件级重定位守卫 + 失效段不计入尺寸帽 + metric=l2_supersede。
   * 作用域同 sceneCharCap（只对非空前缀生效）；缺省 off=工具 schema/行为与基线逐字节一致。
   */
  explicitInvalidation?: boolean,
) {
  // S0 影子计量：一次 toolset = 一次 run，累计量随工具集生命周期归零。
  const readBudget = new ReadBudgetTracker();
  // 方案C：帽作用域 = 非空前缀。空 prefix（L3 persona）→ 0（off）。
  const effectiveCharCap = prefix ? (sceneCharCap ?? 0) : 0;
  // 票⑥：失效语义作用域 = 非空前缀（同帽）。off 时 read/write/edit 全部走基线路径。
  const effectiveInval = prefix ? (explicitInvalidation ?? false) : false;
  /**
   * 票⑥ 写路径守卫（on 专属，落盘前）：普通写入=行级保锚（前像锚点多重集必须
   * 全数存活于后像）；[DELETED] 软删流=文件级重定位（被删文件锚点必须已在同前缀
   * 其余场景文件中，否则 MERGE 删除即锚点流失）。返回拒绝体与读取到的前像
   * （供 metric 增量计算；读不到前像=null，新建文件无锚可失）。
   */
  const supersedeWriteGuard = async (
    path: string,
    key: string,
    content: string,
  ): Promise<{ rejection: AnchorLossRejection | null; pre: string | null }> => {
    let pre: string | null = null;
    try {
      pre = await storage.readFile(key);
    } catch {
      pre = null;
    }
    if (content === "[DELETED]") {
      if (pre === null) return { rejection: null, pre };
      let names: string[] = [];
      try {
        names = await storage.readdirNames(prefix, ".md");
      } catch {
        names = [];
      }
      const others: string[] = [];
      for (const name of names) {
        const otherKey = `${prefix}${name}`;
        if (otherKey === key) continue;
        try {
          const c = await storage.readFile(otherKey);
          if (c !== null) others.push(c);
        } catch {
          // 读不到的文件按「不含锚点」处理（fail-closed：缺口只会更严不会放行）
        }
      }
      const unrelocated = findUnrelocatedAnchors(pre, others);
      if (unrelocated.length > 0) {
        return {
          rejection: {
            error: "anchor_loss_forbidden",
            lostCount: unrelocated.length,
            lost: unrelocated.slice(0, 5),
            hint: RELOCATE_HINT,
          },
          pre,
        };
      }
      return { rejection: null, pre };
    }
    return { rejection: checkAnchorPreservation(pre, content), pre };
  };
  return {
    read: tool({
      description: effectiveInval
        ? "Read the contents of a file at the given relative path. Supports optional offset/limit (character window) to read large files section by section. 配合场景索引按需读取所需场景。已失效行（[SUPERSEDED ...] 标记）默认被过滤；includeInvalidated:true 返回含失效行的全量原文（审计）。"
        : "Read the contents of a file at the given relative path. Supports optional offset/limit (character window) to read large files section by section. 配合场景索引按需读取所需场景。",
      inputSchema: jsonSchema<{ path: string; offset?: number; limit?: number; includeInvalidated?: boolean }>(
        effectiveInval
          ? {
              type: "object",
              properties: {
                path: { type: "string", description: "Relative file path to read." },
                offset: { type: "number", description: "Character offset to start reading from (default 0)." },
                limit: { type: "number", description: "Maximum number of characters to return (default: read to end of file)." },
                includeInvalidated: { type: "boolean", description: "Include [SUPERSEDED] invalidated lines (audit view). Default false." },
              },
              required: ["path"],
            }
          : {
              type: "object",
              properties: {
                path: { type: "string", description: "Relative file path to read." },
                offset: { type: "number", description: "Character offset to start reading from (default 0)." },
                limit: { type: "number", description: "Maximum number of characters to return (default: read to end of file)." },
              },
              required: ["path"],
            },
      ),
      execute: (async (args: { path: string; offset?: number; limit?: number; includeInvalidated?: boolean }) => {
        const key = resolveStorageKey(prefix, args.path);
        if (!key) return JSON.stringify({ error: `Path "${args.path}" escapes workspace boundary.` });
        try {
          const content = await storage.readFile(key);
          if (content === null) {
            logger?.debug?.(`${TAG} read: "${args.path}" → not found`);
            return JSON.stringify({ error: `File not found: ${args.path}` });
          }
          logger?.debug?.(`${TAG} read: "${args.path}" → ${content.length} chars`);
          // 影子缓存计量（2026-10-27）：只统计 would-hit，仍按全文哈希。
          const cacheNote = readCacheMetrics.note(key, content);
          logger?.debug?.(`${TAG} ${formatReadCacheNote(cacheNote, args.path, content.length, taskId)}`);
          // 方案B 分段读：无 offset/limit 时切片 = 全文且无标注（与旧实现逐字节一致）。
          const returned = applyReadWindow(content, { offset: args.offset, limit: args.limit });
          // 票⑥ on：默认过滤失效行（装配点 = applyReadWindow 之后的输出组装；窗口坐标
          // 保持原文坐标，includeInvalidated:true 逐字节回到基线 read）。off：returned 原样。
          const output = effectiveInval
            ? filterSupersededLines(returned, { includeInvalidated: args.includeInvalidated === true })
            : returned;
          // read-budget 计量口径不变：observe 记实际返回的 chars（含截断标注行）。
          const obs = readBudget.observe(args.path, output.length);
          logger?.debug?.(`${TAG} ${formatReadBudgetObservation(obs, taskId)}`);
          if (obs.overFile || obs.crossedRunBudget) {
            logger?.warn?.(`${TAG} ${formatReadBudgetObservation(obs, taskId)} (shadow-only, no enforcement)`);
          }
          return output;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger?.warn(`${TAG} read failed (key=${key}): ${msg}`);
          return JSON.stringify({ error: msg });
        }
      }) as any,
    }),

    write: tool({
      description: "Write content to a file at the given relative path. Creates or overwrites.",
      inputSchema: jsonSchema<{ path: string; content: string }>({
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path to write." },
          content: { type: "string", description: "Content to write." },
        },
        required: ["path", "content"],
      }),
      execute: (async (args: { path: string; content: string }) => {
        const key = resolveStorageKey(prefix, args.path);
        if (!key) return JSON.stringify({ error: `Path "${args.path}" escapes workspace boundary.` });
        // 票⑥ on：落盘前显式失效守卫 —— [DELETED] 软删流走文件级重定位（锚点未迁移
        // 则拒绝，MERGE 删除 lost=0 的机制保证）；普通写入走行级保锚（锚点行永不物理
        // 删除，加 [SUPERSEDED] 前缀不算丢）。拒绝体结构化（anchor_loss_forbidden）。
        if (effectiveInval) {
          const inval = await supersedeWriteGuard(args.path, key, args.content);
          if (inval.rejection) {
            logger?.warn(
              `${TAG} write rejected (${inval.rejection.error}): "${args.path}" lost=${inval.rejection.lostCount}`,
            );
            return JSON.stringify(inval.rejection);
          }
          if (args.content !== "[DELETED]") {
            const delta = supersedeDelta(inval.pre, args.content);
            if (delta > 0) logger?.info?.(`${TAG} metric=l2_supersede value=${delta} path=${args.path}`);
          }
        }
        // 方案C：写入后像尺寸帽 —— 超帽拒绝且不落盘。"[DELETED]" 删除标记不受限。
        // 票⑥ on：帽改失效排除口径（失效段不计入后像帽——失效越多可写余量越大）。
        const capRejection = args.content === "[DELETED]"
          ? null
          : effectiveInval
            ? checkSceneCharCapWithSupersede(args.content, effectiveCharCap)
            : checkSceneCharCap(args.content, effectiveCharCap);
        if (capRejection) {
          logger?.warn(
            `${TAG} write rejected (over_scene_char_cap): "${args.path}" ${capRejection.chars}/${capRejection.cap} chars`,
          );
          return JSON.stringify(capRejection);
        }
        try {
          await storage.writeFile(key, args.content);
          logger?.debug?.(`${TAG} write: "${args.path}" → ${Buffer.byteLength(args.content, "utf8")} bytes`);
          return JSON.stringify({ success: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger?.warn(`${TAG} write failed (key=${key}): ${msg}`);
          return JSON.stringify({ error: msg });
        }
      }) as any,
    }),

    edit: tool({
      description: "Apply one or more text replacements to a file. Each edit replaces an exact substring.",
      inputSchema: jsonSchema<{ path: string; edits: Array<{ oldText: string; newText: string }> }>({
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path." },
          edits: {
            type: "array",
            description: "Array of replacements to apply sequentially.",
            items: {
              type: "object",
              properties: {
                oldText: { type: "string", description: "Exact string to find." },
                newText: { type: "string", description: "Replacement string." },
              },
              required: ["oldText", "newText"],
            },
          },
        },
        required: ["path", "edits"],
      }),
      execute: (async (args: { path: string; edits: Array<{ oldText: string; newText: string }> }) => {
        const key = resolveStorageKey(prefix, args.path);
        if (!key) return JSON.stringify({ error: `Path "${args.path}" escapes workspace boundary.` });
        if (!args.edits || args.edits.length === 0) return JSON.stringify({ error: "edits array cannot be empty." });
        try {
          const existing = await storage.readFile(key);
          if (existing === null) {
            logger?.debug?.(`${TAG} edit: "${args.path}" → not found`);
            return JSON.stringify({ error: `File not found: ${args.path}` });
          }
          let content = existing;
          for (const edit of args.edits) {
            if (!edit.oldText) return JSON.stringify({ error: "oldText cannot be empty." });
            if (!content.includes(edit.oldText)) {
              return JSON.stringify({ error: `oldText not found in file "${args.path}": ${edit.oldText.slice(0, 80)}` });
            }
            // Pass a replacer function so `$&`, `$'`, "$`", `$1`, `$$` in newText are
            // inserted literally. A plain string replacement would expand them as
            // special patterns -- `$'` (matched substring's suffix) duplicates the rest
            // of the file on every edit, growing scene blocks exponentially.
            content = content.replace(edit.oldText, () => edit.newText);
          }
          // 票⑥ on：行级保锚守卫先行 —— edit 后像丢失前像锚点 → 拒绝且不落盘。
          const anchorRejection = effectiveInval ? checkAnchorPreservation(existing, content) : null;
          if (anchorRejection) {
            logger?.warn(
              `${TAG} edit rejected (${anchorRejection.error}): "${args.path}" lost=${anchorRejection.lostCount}`,
            );
            return JSON.stringify(anchorRejection);
          }
          // 方案C：edit 后像（应用全部替换后的完整内容）尺寸帽 —— 超帽拒绝且不落盘。
          // 票⑥ on：帽改失效排除口径（失效段不计入后像帽）。
          const capRejection = effectiveInval
            ? checkSceneCharCapWithSupersede(content, effectiveCharCap)
            : checkSceneCharCap(content, effectiveCharCap);
          if (capRejection) {
            logger?.warn(
              `${TAG} edit rejected (over_scene_char_cap): "${args.path}" ${capRejection.chars}/${capRejection.cap} chars`,
            );
            return JSON.stringify(capRejection);
          }
          if (effectiveInval) {
            const delta = supersedeDelta(existing, content);
            if (delta > 0) logger?.info?.(`${TAG} metric=l2_supersede value=${delta} path=${args.path}`);
          }
          await storage.writeFile(key, content);
          logger?.debug?.(
            `${TAG} edit: "${args.path}" → ${args.edits.length} replacement(s), ${Buffer.byteLength(content, "utf8")} bytes`,
          );
          return JSON.stringify({ success: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger?.warn(`${TAG} edit failed (key=${key}): ${msg}`);
          return JSON.stringify({ error: msg });
        }
      }) as any,
    }),
  };
}

/** Read-only subset for storage tools (mirrors createReadOnlyTools). */
export function createStorageReadOnlyTools(
  storage: StorageAdapter,
  prefix: string,
  logger?: Logger,
) {
  const all = createStorageTools(storage, prefix, logger);
  return { read: all.read };
}
