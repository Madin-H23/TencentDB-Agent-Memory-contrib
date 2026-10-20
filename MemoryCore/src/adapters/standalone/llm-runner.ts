/**
 * StandaloneLLMRunner — powered by Vercel AI SDK (`ai` + `@ai-sdk/openai`).
 *
 * This runner does NOT depend on OpenClaw's `runEmbeddedPiAgent`. It is designed
 * for the Hermes Gateway scenario where TDAI runs as an independent Node.js sidecar
 * without the OpenClaw host.
 *
 * Capabilities:
 * - `enableTools: false`: pure text output (L1 extraction, L1 dedup)
 * - `enableTools: true`: automatic tool-call loop with local file operations
 *   (L2 scene, L3 persona) via AI SDK's `maxSteps`
 *
 * Tool sandbox:
 *   When tools are enabled, three basic file operations are exposed:
 *   `read`, `write`, `edit` — aligned with OpenClaw host tool names.
 *   All file paths are resolved relative to `workspaceDir`, enforcing sandbox boundaries.
 */

import fsPromises from "node:fs/promises";
import path from "node:path";
import { APICallError, generateText, streamText, tool, stepCountIs, jsonSchema } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { report } from "../../core/report/reporter.js";
import { withSharedLlmLimit, getDefaultLlmConcurrency } from "../../utils/llm-concurrency.js";
import { runWithRateLimitRetry } from "../../utils/rate-limit-backoff.js";
import type {
  LLMRunner,
  LLMRunParams,
  LLMRunnerFactory,
  LLMRunnerCreateOptions,
  Logger,
} from "../../core/types.js";
import type { LLMUsage } from "../../core/report/metric-tracking-runner.js";

const TAG = "[memory-tdai] [standalone-runner]";

// Max iterations in the tool-call loop to prevent infinite loops
const MAX_TOOL_ITERATIONS = 20;

// ============================
// experimental_telemetry.metadata 组装
// ============================

/**
 * 组装传给 Vercel AI SDK 的 experimental_telemetry.metadata。
 *
 * 字段策略：
 *   - instanceId  : 始终写入（未传时降级为 "unknown"）
 *   - traceName   : 存在时 → 写入 langfuseTraceName + langfuseUpdateParent=true
 *                  （让 Langfuse 用业务语义命名 trace，覆盖默认的 Unnamed）
 *   - tags        : 非空数组才写入（避免空 tag 污染 Langfuse 索引）
 *   - sessionId   : 非空字符串才写入（Langfuse UI 顶级筛选字段）
 *   - userId      : 非空字符串才写入（Langfuse UI 顶级筛选字段）
 *
 * 未传对应字段时，metadata 里也不出现该键 —— 保持与旧行为完全一致。
 */
function buildTelemetryMetadata(params: LLMRunParams): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    instanceId: params.instanceId ?? "unknown",
  };
  if (params.traceName) {
    meta.langfuseTraceName = params.traceName;
    // langfuseUpdateParent=true 让子 span 的 name/attrs 传播到 Langfuse trace 根
    meta.langfuseUpdateParent = true;
  }
  if (Array.isArray(params.tags) && params.tags.length > 0) {
    meta.tags = params.tags;
  }
  if (typeof params.sessionId === "string" && params.sessionId.length > 0) {
    meta.sessionId = params.sessionId;
  }
  if (typeof params.userId === "string" && params.userId.length > 0) {
    meta.userId = params.userId;
  }
  return meta;
}

// ============================
// Configuration
// ============================

export interface StandaloneLLMConfig {
  /** OpenAI-compatible API base URL (e.g. "https://api.openai.com/v1"). */
  baseUrl: string;
  /** API key for authentication. */
  apiKey: string;
  /** Default model name (e.g. "gpt-4o"). */
  model: string;
  /** Default max output tokens. */
  maxTokens?: number;
  /** Request timeout in milliseconds (default: 120_000). */
  timeoutMs?: number;
  /**
   * 进程级并发闸门（P1，v2 8c00003 移植）：本 runner 实例发起的厂商调用在
   * `llm:${baseUrl}` 共享信号量内执行，防多子系统叠加触发厂商并发秒拒。
   * ≤0/缺省 → 回退进程级默认（gateway 装配时 setDefaultLlmConcurrency 设一次），
   * 仍 ≤0 则不限流。
   */
  maxConcurrency?: number;
  /**
   * 整调用硬期限（P1，v2 callDeadlineMs 移植）：限流退避+多次尝试的总预算硬顶，
   * 上游挂死时也必然在期限内返回（RateLimitDeadlineError）。
   * 缺省 = timeoutMs×2 + 30s（≥ 两次尝试+一次 20s 退避预算，不盖死各层超时）。
   */
  callDeadlineMs?: number;
  /**
   * 自定义请求头（v2 extra.headers 移植，2026-10-16）：随每次厂商请求发送。
   * 部分 OpenAI 兼容上游强制要求固定头（opencode-go 缺 x-opencode-session 时
   * 上游 400 MissingSessionID，node fetch 探针 2026-10-16 实证）。全局字段，
   * 不按层覆盖（换头=改全局 llm 块）。
   */
  headers?: Record<string, string>;
  /**
   * LLM 访问模式（gateway 层解释；runner 拿到的是已解析后的 baseUrl/apiKey）：
   *   - "openai": 直连通用 OpenAI 兼容服务（默认，向后兼容）
   *   - "proxy":  走 context_proxy，运行时会自动把 baseUrl 拼成
   *               `${baseUrl}/proxy/<instanceId>/v1`，apiKey 用 metadata.systemUser.memory.userKey
   */
  provider?: "openai" | "proxy";
  /** provider=proxy 时的可选配置。 */
  proxy?: {
    /** 是否用 memory systemUser.userKey 作为 Authorization（默认 true）。 */
    useMemorySystemUserKey?: boolean;
  };
  /**
   * 是否用流式请求(streamText)调用上游。默认 false(generateText 非流式)。
   * 个别 OpenAI 兼容上游只接受流式请求时置 true。
   *
   * ⚠️ 仅 StandaloneLLMRunner(含 gateway/local/knowledge-ingest)路径生效;
   * OpenClaw host runner 不使用此 runner,该开关被忽略。不会把增量 token
   * 透传给调用方,只是"以流式协议请求上游后等待完整文本"的兼容层。
   */
  stream?: boolean;
  /**
   * 关思考三态开关（v2 分层移植，2026-10-15）：显式值优先，未设置回落
   * env TDAI_DISABLE_THINKING。DeepSeek-V4 系列默认开思考（reasoning_content），
   * 会烧光 max_tokens 导致 content 空/截断（v2 2026-09-08 实测）。
   */
  disableThinking?: boolean;
  /**
   * 思考等级（2026-10-20 用户需求，思考改按等级）：显式值优先于旧三态
   * disableThinking 与 env TDAI_DISABLE_THINKING。
   */
  thinkingLevel?: ThinkingLevel;
  /**
   * 厂商显示名（v2 c00899f 归属移植，2026-10-15）：yaml llm.providerLabel，
   * 用于 L1 完成/延后/失败日志与面板蒸馏归属。v3 无 activeProvider 折叠，
   * 此为纯展示字段，不参与调用路由。
   */
  providerLabel?: string;
  /**
   * 蒸馏分层覆盖（v2 llm.layers 移植，2026-10-15）：l1|l2|l3 各层可覆盖
   * 标量字段，未配置的层沿用全局值。面板「分层配置编辑」写入的即是本结构。
   */
  layers?: LlmLayersOverride;
}

/** llm.layers.<层> 可覆盖的标量字段。不支持按层换 baseUrl/apiKey（换厂商仍改全局 llm 块）。 */
export interface LlmLayerOverride {
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** 三态：true 强制关 / false 强制开(压过全局 env) / 未设沿用全局(env 兜底)。
   *  @deprecated 2026-10-20 起改用 thinkingLevel（旧三态仍兼容读取）。 */
  disableThinking?: boolean;
  /** 思考等级（2026-10-20）：default/disabled/enabled/low/high/max。 */
  thinkingLevel?: ThinkingLevel;
  /** 整调用硬期限覆盖（须 ≥ 该层 timeoutMs + 限流退避预算，否则重试无意义）。 */
  callDeadlineMs?: number;
  /**
   * 流式请求覆盖（2026-10-15 加）。Node 内置 fetch(undici) headersTimeout 默认
   * 300s，非流式补全「生成完才发头」，慢层（l2/l3 开思考的 step-5，单调用
   * 1-5min）配到 600s 也会被静默截到 ~300s；流式即时发头绕开该天花板。
   */
  stream?: boolean;
}

export interface LlmLayersOverride {
  l1?: LlmLayerOverride;
  l2?: LlmLayerOverride;
  l3?: LlmLayerOverride;
}

/**
 * 关思考三态判定：显式配置值优先，未设置回落 env TDAI_DISABLE_THINKING === "true"。
 * 纯函数（env 经参数外读取），供 runner 与启动锚点共用同一口径。
 * @deprecated 2026-10-20 起思考改按等级（resolveThinkingLevel），本函数仅保留
 *             旧三态兼容（legacy disableThinking 映射用）。
 */
export function resolveDisableThinking(explicit?: boolean): boolean {
  return explicit ?? process.env.TDAI_DISABLE_THINKING === "true";
}

/**
 * 思考等级（2026-10-20 用户需求：把「关思考」开关改为按等级，参考 ZCode 的
 * Default/Low/High/Max 与 enabled/disabled 档）：
 *   default   不注入任何思考参数（env TDAI_DISABLE_THINKING=true 时回落为 disabled）
 *   disabled  强制关闭 → thinking:{type:"disabled"}
 *   enabled   明确开启（不受 env 影响）→ 不注入，由上游默认思考
 *   low/high  强度档 → reasoning_effort:low|high
 *   max       最高档 → reasoning_effort:high + thinking:{type:"enabled"}
 * 旧三态 disableThinking 无损映射：true→disabled / false→enabled / 缺省→default。
 */
export type ThinkingLevel = "default" | "disabled" | "enabled" | "low" | "high" | "max";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["default", "disabled", "enabled", "low", "high", "max"];

export function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v);
}

/**
 * 等级判定（纯函数）：显式等级优先 → 旧三态映射 → env 回落。
 * 与旧 resolveDisableThinking 的行为完全等价（显式 false 压过 env true 保持）。
 */
export function resolveThinkingLevel(explicit?: ThinkingLevel, legacyDisable?: boolean): ThinkingLevel {
  if (explicit) return explicit;
  if (legacyDisable === true) return "disabled";
  if (legacyDisable === false) return "enabled";
  return process.env.TDAI_DISABLE_THINKING === "true" ? "disabled" : "default";
}

/** 等级 → 请求体注入内容（null=不注入任何思考参数）。OpenAI 兼容 reasoning_effort 口径。 */
export function thinkingLevelPatch(level: ThinkingLevel): Record<string, unknown> | null {
  switch (level) {
    case "disabled":
      return { thinking: { type: "disabled" } };
    case "low":
      return { reasoning_effort: "low" };
    case "high":
      return { reasoning_effort: "high" };
    case "max":
      return { reasoning_effort: "high", thinking: { type: "enabled" } };
    default:
      return null; // default / enabled —— 由上游默认思考行为决定
  }
}

/**
 * 按层叠覆盖运行时 LLM 配置（v2 tdai-core resolveRuntimeLlm 的覆盖段移植）：
 * 只拷贝 LlmLayerOverride 声明过的标量字段；model 空串视为未设置；
 * 数值 0 视为显式生效。不改写入参（纯函数）。
 */
export function applyLlmLayerOverride<T extends StandaloneLLMConfig>(
  base: T,
  ov?: LlmLayerOverride,
): T {
  if (!ov) return base;
  return {
    ...base,
    ...(ov.model ? { model: ov.model } : {}),
    ...(ov.maxTokens !== undefined ? { maxTokens: ov.maxTokens } : {}),
    ...(ov.timeoutMs !== undefined ? { timeoutMs: ov.timeoutMs } : {}),
    ...(ov.disableThinking !== undefined ? { disableThinking: ov.disableThinking } : {}),
    ...(ov.thinkingLevel !== undefined ? { thinkingLevel: ov.thinkingLevel } : {}),
    ...(ov.callDeadlineMs !== undefined ? { callDeadlineMs: ov.callDeadlineMs } : {}),
    ...(ov.stream !== undefined ? { stream: ov.stream } : {}),
  };
}

// ============================
// Sandboxed tool execution helpers
// ============================

function resolveSandboxedPath(workspaceDir: string, relativePath: string): string | null {
  const resolved = path.resolve(workspaceDir, relativePath);
  if (!resolved.startsWith(path.resolve(workspaceDir))) {
    return null;
  }
  return resolved;
}

// ============================
// Tool definitions (Vercel AI SDK `tool()` format)
// ============================

function createSandboxedTools(workspaceDir: string, logger?: Logger) {
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
        const resolved = resolveSandboxedPath(workspaceDir, args.path);
        if (!resolved) return JSON.stringify({ error: `Path "${args.path}" escapes workspace boundary.` });
        try {
          const content = await fsPromises.readFile(resolved, "utf-8");
          logger?.debug?.(`${TAG} read: "${args.path}" → ${content.length} chars`);
          return content;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger?.warn?.(`${TAG} read failed: ${msg}`);
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
        const resolved = resolveSandboxedPath(workspaceDir, args.path);
        if (!resolved) return JSON.stringify({ error: `Path "${args.path}" escapes workspace boundary.` });
        try {
          await fsPromises.mkdir(path.dirname(resolved), { recursive: true });
          await fsPromises.writeFile(resolved, args.content, "utf-8");
          logger?.debug?.(`${TAG} write: "${args.path}" → ${Buffer.byteLength(args.content, "utf8")} bytes`);
          return JSON.stringify({ success: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger?.warn?.(`${TAG} write failed: ${msg}`);
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
        const resolved = resolveSandboxedPath(workspaceDir, args.path);
        if (!resolved) return JSON.stringify({ error: `Path "${args.path}" escapes workspace boundary.` });
        if (!args.edits || args.edits.length === 0) return JSON.stringify({ error: "edits array cannot be empty." });
        try {
          let content = await fsPromises.readFile(resolved, "utf-8");
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
          await fsPromises.writeFile(resolved, content, "utf-8");
          logger?.debug?.(
            `${TAG} edit: "${args.path}" → ${args.edits.length} replacement(s), ${Buffer.byteLength(content, "utf8")} bytes`,
          );
          return JSON.stringify({ success: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger?.warn?.(`${TAG} edit failed: ${msg}`);
          return JSON.stringify({ error: msg });
        }
      }) as any,
    }),
  };
}

/** Read-only tool subset — currently empty.
 *
 * Historically returned `{ read: all.read }` so the AI SDK wouldn't reject
 * an empty tools object. In practice this caused weak models (e.g. small
 * Doubao endpoints) to hallucinate calls like `read({"path":"."})` during
 * pure-text tasks (L1 extraction), triggering EISDIR on the sandbox dir
 * and burning a turn on a useless tool call.
 *
 * Modern AI SDK (v6) accepts an undefined `tools` field, so the runner now
 * skips the `tools`/`stopWhen` parameters entirely when tools are disabled
 * — see `generateText` invocation below.
 */
function createReadOnlyTools(_workspaceDir: string, _logger?: Logger) {
  return {};
}

// ============================
// StandaloneLLMRunner
// ============================

export class StandaloneLLMRunner implements LLMRunner {
  private config: StandaloneLLMConfig;
  private model: string;
  private enableTools: boolean;
  private stream: boolean;
  private logger?: Logger;

  /**
   * Side-channel: 最近一次 run() 调用的 token usage。
   * 由 MetricTrackingRunner 装饰器读取，用于精确上报 credit。
   * 不改变 LLMRunner 接口签名。
   */
  lastUsage?: LLMUsage;

  constructor(opts: {
    config: StandaloneLLMConfig;
    model?: string;
    enableTools?: boolean;
    stream?: boolean;
    logger?: Logger;
  }) {
    this.config = opts.config;
    this.model = opts.model ?? opts.config.model;
    this.enableTools = opts.enableTools ?? false;
    this.stream = opts.stream ?? opts.config.stream ?? false;
    this.logger = opts.logger;
  }

  async run(params: LLMRunParams): Promise<string> {
    const runStartMs = Date.now();
    const timeoutMs = params.timeoutMs ?? this.config.timeoutMs ?? 120_000;
    const maxTokens = params.maxTokens ?? this.config.maxTokens ?? 4096;
    const workspaceDir = params.workspaceDir ?? process.cwd();
    // Per-call overrides — when the caller supplies their own tools (e.g.
    // SkillExtractor's skill_list/skill_view/skill_manage), they trump the
    // runner-level enableTools default. This lets one runner instance
    // serve both pure-text L1 extraction and tool-driven skill review.
    const callerProvidedTools = params.tools && Object.keys(params.tools).length > 0;
    const effectiveEnableTools = params.enableTools ?? this.enableTools;
    const maxIterations = params.maxIterations ?? MAX_TOOL_ITERATIONS;

    // 思考等级（2026-10-20 用户需求：思考改按等级，参考 ZCode 的 Default/Low/
    // High/Max 与 enabled/disabled 档）。等级优先于旧三态 disableThinking，
    // 旧三态经 resolveThinkingLevel 无损映射（true→disabled/false→enabled）。
    const thinkingLevel = resolveThinkingLevel(this.config.thinkingLevel, this.config.disableThinking);
    const levelPatch = thinkingLevelPatch(thinkingLevel);
    // 2026-10-20：部分厂商模型**要求** adaptive thinking（如 MiniMax-M3 系列，
    // 探针实测：带 thinking:{type:"disabled"} → 400 invalid params「requires
    // adaptive thinking」；不带 → 200 正常）。对这类模型不注入任何思考参数
    // ——其思考由模型自适应决定，等级对其语义上无效（显式 warn 以免静默）。
    const modelRequiresAdaptiveThinking = /minimax/i.test(this.model ?? "");
    if (levelPatch && modelRequiresAdaptiveThinking) {
      this.logger?.warn?.(
        `${TAG} 模型 ${this.model} 要求 adaptive thinking，忽略思考等级 ${thinkingLevel}（不注入思考参数）`,
      );
    }

    this.logger?.debug?.(
      `${TAG} run() start: taskId=${params.taskId}, model=${this.model}, ` +
      `tools=${effectiveEnableTools}${callerProvidedTools ? "(caller)" : ""}, timeout=${timeoutMs}ms, ` +
      `thinkingLevel=${thinkingLevel}`,
    );

    // Create OpenAI-compatible provider via AI SDK
    // Use "compatible" mode to call /chat/completions (not Responses API),
    // which works with all OpenAI-compatible backends (DeepSeek, Qwen, etc.)
    // 关思考三态开关（v2 移植，2026-10-15）：config.disableThinking 显式值优先，
    // 未设置回落 env TDAI_DISABLE_THINKING。实现注意（v2 2026-09-08 fetch 探针实测）：
    // AI SDK 的 openai-compatible provider 不会把 thinking 序列化进请求体
    // （providerOptions 路径实测 thinking=undefined），因此改在 fetch 层直接
    // 改写 JSON body 注入 thinking:{type:"disabled"}。
    // fetch 覆写**始终安装**（2026-10-20）：三件事都在这里做——
    //   ① 需要关思考的模型：注入 thinking:{type:"disabled"}（v2 移植行为不变）；
    //   ② 要求 adaptive thinking 的模型（MiniMax 系）：**主动剥离** thinking /
    //      reasoning_effort——实测 AI SDK 的 openai-compatible provider 也会在
    //      body 里带 thinking/reasoning_effort，仅靠「不注入」不够；
    //   ③ 兜底：上游 400 且错误含 thinking 相关 invalid params → 剥离后重试一次
    //      （覆盖未知厂商的同类约束）。
    const provider = createOpenAI({
      baseURL: this.config.baseUrl,
      apiKey: this.config.apiKey,
      compatibility: "compatible",
      // 自定义请求头（v2 extra.headers 移植）：opencode-go 等厂商强制要求
      // （缺 x-opencode-session 上游 400）。空对象/缺省不传，行为不变。
      ...(this.config.headers && Object.keys(this.config.headers).length > 0
        ? { headers: this.config.headers }
        : {}),
      fetch: async (url: unknown, init?: RequestInit) => {
        const patchBody = (
          reqInit: RequestInit | undefined,
          mode: "inject" | "strip",
          inject?: Record<string, unknown>,
        ): { init?: RequestInit; stripped: string[] } => {
          if (typeof reqInit?.body !== "string") return { init: reqInit, stripped: [] };
          try {
            const body = JSON.parse(reqInit.body) as Record<string, unknown>;
            const stripped: string[] = [];
            if (mode === "inject") {
              Object.assign(body, inject ?? {});
            } else {
              for (const k of ["thinking", "reasoning_effort", "reasoning"]) {
                if (body[k] !== undefined) {
                  stripped.push(k);
                  delete body[k];
                }
              }
            }
            return { init: { ...reqInit, body: JSON.stringify(body) }, stripped };
          } catch {
            // body 非 JSON 时保持原样
            return { init: reqInit, stripped: [] };
          }
        };

        const first =
          !levelPatch || !modelRequiresAdaptiveThinking
            ? { init: levelPatch ? patchBody(init, "inject", levelPatch).init : init, stripped: [] as string[] }
            : patchBody(init, "strip");
        if (first.stripped.length > 0) {
          this.logger?.warn?.(
            `${TAG} 模型 ${this.model} 要求 adaptive thinking，已剥离请求中的 ${first.stripped.join(", ")}`,
          );
        }
        const res = await fetch(url as Parameters<typeof fetch>[0], first.init ?? init);
        if (res.status !== 400) return res;
        // 兜底：未知厂商若同样因 thinking 参数被拒，去掉 thinking/reasoning 重试一次
        const text = await res.clone().text().catch(() => "");
        if (!/requires adaptive thinking|thinking[^"]{0,40}invalid|invalid[^"]{0,40}thinking|reasoning[^"]{0,40}not allowed/i.test(text)) {
          return res;
        }
        this.logger?.warn?.(
          `${TAG} 上游拒绝 thinking 参数（adaptive thinking 约束），剥离后重试一次`,
        );
        const retry = patchBody(first.init ?? init, "strip");
        return fetch(url as Parameters<typeof fetch>[0], retry.init ?? init);
      },
    });

    // Select tools based on mode + storage
    // Service mode (COS): use storage-backed tools → LLM reads/writes via StorageAdapter
    // Standalone mode (local FS): use sandboxed FS tools → LLM reads/writes local files
    // enableTools=false: omit tools entirely so the model cannot hallucinate calls.
    // Caller-provided tools (params.tools) override the defaults — used by
    // SkillExtractor to inject domain-specific tools (skill_list, etc.).
    let tools: Record<string, unknown> | undefined;
    if (callerProvidedTools && effectiveEnableTools) {
      tools = params.tools;
      this.logger?.debug?.(`${TAG} Using caller-provided tools: [${Object.keys(tools!).join(", ")}]`);
    } else if (effectiveEnableTools && params.storage) {
      const { createStorageTools } = await import("./storage-tools.js");
      tools = createStorageTools(params.storage, params.storagePrefix ?? "", this.logger);
      this.logger?.debug?.(`${TAG} Using storage-backed tools (prefix="${params.storagePrefix ?? ""}")`);
    } else if (effectiveEnableTools) {
      tools = createSandboxedTools(workspaceDir, this.logger);
    } else {
      tools = undefined; // pure-text task — never expose any tool to the model
    }

    try {
      // H-11 Step 2: caller-provided abortSignal（e.g. pipeline-worker lost its
      // lock and wants the LLM call to bail out）—— 仅保留给外层重试/期限竞速做
      // abort 传播。每次尝试的超时信号在闸门内创建（A2，2026-10-16）：曾在闸门外
      // 创建，L1 排在 L2/L3 慢调用之后时队列等待时间烧掉 timeoutMs 预算，且两次
      // 重试共用同一个已烧过的信号；移入后排队不烧预算、每次尝试独享满额，
      // 总量仍由 runWithRateLimitRetry 的 callDeadlineMs 硬顶。
      const callerSignal = params.abortSignal;

      const callParams = {
        model: provider.chat(this.model),
        system: params.systemPrompt,
        prompt: params.prompt,
        // Only attach tools when actually enabled — passing an empty object
        // (or even a tools-only-with-`read`) makes some OpenAI-compatible
        // backends emit spurious tool calls on pure-text tasks.
        ...(tools && Object.keys(tools).length > 0
          ? { tools, stopWhen: stepCountIs(maxIterations) }
          : {}),
        maxOutputTokens: maxTokens,
        // maxRetries:0 = 关闭 AI SDK 内置快速重试（默认 2 连发，共 3 次请求）。
        // 回归修复（2026-10-20，批次 1.2）：v2 的 859d388 已在 SDK 调用上设过
        // maxRetries:0，v3 移植 1765221 时漏带，SDK 调用回落到默认 3 连发。
        // 内置重试间隔约 8s，对限流/日额度类拒绝毫无意义（额度不会在 8 秒内
        // 恢复），却把每次失败的厂商请求放大 3 倍；与外层限流退避重试叠加后
        // 单次抽取最多打出 6 个厂商请求，在按日额度计费的厂商上是纯浪费。
        // 实测证据："Failed after 3 attempts" 在 v2 生效期（10-08~10-13）出现
        // 0 次，v3 接管后（10-14~10-20）出现 999 次。
        // 限流感知的长退避由外层 runWithRateLimitRetry 承担（见下）。
        maxRetries: 0,
        experimental_telemetry: {
          isEnabled: true,
          functionId: params.taskId,
          metadata: buildTelemetryMetadata(params),
        },
      };

      // stream=true → streamText(给只吃流式的上游);否则 generateText。
      // 读 totalUsage 而不是单 step 的 usage —— tool-call 多 step 时后者只报最后一步,
      // 会漏掉前序工具调用请求的用量,导致 credit 计费偏低。
      // ai@6.0.164 的字段是 inputTokens/outputTokens/totalUsage。
      //
      // 执行包络（P1，v2 8c00003+859d388 移植）：并发闸门在内层（厂商分桶信号量，
      // 退避等待不占槽位），限流重试在外层（concurrency reached/429 → 指数退避
      // 重试 1 次），整体受 callDeadline 硬顶——上游挂死也必然在期限内返回。
      const callOnce = async () => {
        const execute = async () => {
          // 超时信号在闸门内创建（A2）：每次尝试独享满额 timeoutMs，与 caller
          // abort 合并（Node 20+ AbortSignal.any，任一触发即中止）。
          const timeoutSignal = AbortSignal.timeout(timeoutMs);
          const attemptSignal = callerSignal
            ? AbortSignal.any([timeoutSignal, callerSignal])
            : timeoutSignal;
          const r = this.stream
            ? await (async () => {
                const streamResult = streamText({ ...callParams, abortSignal: attemptSignal });
                return {
                  text: ((await streamResult.text) ?? "").trim(),
                  usage: await streamResult.totalUsage,
                  steps: await streamResult.steps,
                };
              })()
            : await (async () => {
                const genResult = await generateText({ ...callParams, abortSignal: attemptSignal });
                return {
                  text: (genResult.text ?? "").trim(),
                  usage: genResult.totalUsage,
                  steps: genResult.steps,
                };
              })();
          return r;
        };
        const gateLimit = this.config.maxConcurrency ?? getDefaultLlmConcurrency();
        return withSharedLlmLimit(`llm:${this.config.baseUrl}`, gateLimit, execute);
      };
      const { text, usage, steps } = await runWithRateLimitRetry(callOnce, {
        maxRetries: 1,
        deadlineMs: this.config.callDeadlineMs ?? timeoutMs * 2 + 30_000,
      }, callerSignal);

      const totalMs = Date.now() - runStartMs;

      // 暴露 token usage 到 side-channel（供 MetricTrackingRunner 读取）
      // AI SDK 用 inputTokens/outputTokens,我们的内部 LLMUsage 沿用旧命名
      // promptTokens/completionTokens 以匹配 MetricTrackingRunner。
      if (usage) {
        const promptTokens = usage.inputTokens ?? 0;
        const completionTokens = usage.outputTokens ?? 0;
        this.lastUsage = {
          promptTokens,
          completionTokens,
          totalTokens: usage.totalTokens ?? promptTokens + completionTokens,
        };
      } else {
        this.lastUsage = undefined;
      }

      this.logger?.debug?.(
        `${TAG} run() completed: ${totalMs}ms, steps=${steps.length}, output=${text.length} chars`,
      );

      // Log each step's activity (tool calls + text output)
      for (const step of steps) {
        const calls = step.toolCalls ?? [];
        const textLen = step.text?.length ?? 0;
        if (calls.length > 0) {
          const callSummary = calls.map((tc) =>
            `${tc.toolName}(${JSON.stringify(tc.input).slice(0, 120)})`,
          ).join(", ");
          this.logger?.debug?.(
            `${TAG} step[${step.stepNumber}] toolCalls: ${callSummary}`,
          );
        }
        if (textLen > 0) {
          this.logger?.debug?.(
            `${TAG} step[${step.stepNumber}] text: ${textLen} chars, finishReason=${step.finishReason}`,
          );
        }
        if (calls.length === 0 && textLen === 0) {
          this.logger?.debug?.(
            `${TAG} step[${step.stepNumber}] empty (no tools, no text), finishReason=${step.finishReason}`,
          );
        }
      }

      // Metric
      if (params.instanceId) {
        report("llm_call", {
          taskId: params.taskId,
          provider: "standalone",
          model: this.model,
          inputLength: params.prompt.length,
          outputLength: text.length,
          totalDurationMs: totalMs,
          success: true,
          error: null,
        });
      }

      return text;
    } catch (err) {
      const totalMs = Date.now() - runStartMs;
      let errMsg = err instanceof Error ? err.message : String(err);
      if (APICallError.isInstance(err)) {
        // err.message alone can be as terse as "Not Found"; the failing URL,
        // status and response body only exist on APICallError, so surface them
        // here (preview + remainder counter, same convention as l1-extractor).
        const body = typeof err.responseBody === "string" ? err.responseBody : "";
        const bodyPreview = body.slice(0, 2048);
        errMsg =
          `${errMsg} (status=${err.statusCode ?? "?"}, url=${err.url}` +
          (bodyPreview
            ? `, body=${bodyPreview}${body.length > 2048 ? `…(+${body.length - 2048})` : ""}`
            : "") +
          ")";
      }
      this.logger?.error(`${TAG} run() failed after ${totalMs}ms: ${errMsg}`);

      if (params.instanceId) {
        report("llm_call", {
          taskId: params.taskId,
          provider: "standalone",
          model: this.model,
          inputLength: params.prompt.length,
          outputLength: 0,
          totalDurationMs: totalMs,
          success: false,
          error: errMsg,
        });
      }

      throw err;
    }
  }
}

// ============================
// StandaloneLLMRunnerFactory
// ============================

export interface StandaloneLLMRunnerFactoryOptions {
  /** LLM API configuration. */
  config: StandaloneLLMConfig;
  /** Logger instance. */
  logger?: Logger;
}

/**
 * Factory that creates StandaloneLLMRunner instances.
 *
 * Used by the Gateway and Hermes host adapters.
 */
export class StandaloneLLMRunnerFactory implements LLMRunnerFactory {
  private config: StandaloneLLMConfig;
  private logger?: Logger;

  constructor(opts: StandaloneLLMRunnerFactoryOptions) {
    this.config = opts.config;
    this.logger = opts.logger;
  }

  createRunner(opts?: LLMRunnerCreateOptions): LLMRunner {
    const enableTools = opts?.enableTools ?? false;
    const modelRef = opts?.modelRef;

    // Parse "provider/model" → just use the model part for OpenAI-compatible API
    let model = this.config.model;
    if (modelRef) {
      const slashIdx = modelRef.indexOf("/");
      model = slashIdx > 0 ? modelRef.slice(slashIdx + 1) : modelRef;
    }

    this.logger?.debug?.(
      `${TAG} Creating StandaloneLLMRunner: model=${model}, tools=${enableTools}`,
    );

    return new StandaloneLLMRunner({
      config: this.config,
      model,
      enableTools,
      logger: this.logger,
    });
  }
}
