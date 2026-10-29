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
import { checkSceneCharCap } from "../../utils/scene-char-cap.js";

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
) {
  // S0 影子计量：一次 toolset = 一次 run，累计量随工具集生命周期归零。
  const readBudget = new ReadBudgetTracker();
  // 方案C：帽作用域 = 非空前缀。空 prefix（L3 persona）→ 0（off）。
  const effectiveCharCap = prefix ? (sceneCharCap ?? 0) : 0;
  return {
    read: tool({
      description: "Read the contents of a file at the given relative path.",
      inputSchema: jsonSchema<{ path: string }>({
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path to read." },
        },
        required: ["path"],
      }),
      execute: (async (args: { path: string }) => {
        const key = resolveStorageKey(prefix, args.path);
        if (!key) return JSON.stringify({ error: `Path "${args.path}" escapes workspace boundary.` });
        try {
          const content = await storage.readFile(key);
          if (content === null) {
            logger?.debug?.(`${TAG} read: "${args.path}" → not found`);
            return JSON.stringify({ error: `File not found: ${args.path}` });
          }
          logger?.debug?.(`${TAG} read: "${args.path}" → ${content.length} chars`);
          // 影子缓存计量（2026-10-27）：只统计 would-hit，仍返回全文。
          const cacheNote = readCacheMetrics.note(key, content);
          logger?.debug?.(`${TAG} ${formatReadCacheNote(cacheNote, args.path, content.length, taskId)}`);
          const obs = readBudget.observe(args.path, content.length);
          logger?.debug?.(`${TAG} ${formatReadBudgetObservation(obs, taskId)}`);
          if (obs.overFile || obs.crossedRunBudget) {
            logger?.warn?.(`${TAG} ${formatReadBudgetObservation(obs, taskId)} (shadow-only, no enforcement)`);
          }
          return content;
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
        // 方案C：写入后像尺寸帽 —— 超帽拒绝且不落盘。"[DELETED]" 删除标记不受限。
        const capRejection = args.content === "[DELETED]"
          ? null
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
          // 方案C：edit 后像（应用全部替换后的完整内容）尺寸帽 —— 超帽拒绝且不落盘。
          const capRejection = checkSceneCharCap(content, effectiveCharCap);
          if (capRejection) {
            logger?.warn(
              `${TAG} edit rejected (over_scene_char_cap): "${args.path}" ${capRejection.chars}/${capRejection.cap} chars`,
            );
            return JSON.stringify(capRejection);
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
