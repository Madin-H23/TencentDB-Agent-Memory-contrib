/**
 * 金标 5 候选 A/B harness 消融旋钮集（票 05，2026-10-24 判定层 M2 治理）。
 *
 * 与 golden-ab5-metrics.ts 的分工：metrics 管度量与键；本模块管「消融变量如何
 * 进入判定链路」，全部纯函数 + runner 包装，供 scripts/golden-ab5.ts 接线：
 *
 * 1. `parseAb5Knobs`：--topk=N（默认 5，上限 50=数据集最大池深）/ --thinking=<level>
 *    （缺省不注入，合法值与生产 StandaloneLLMConfig 同源：default/disabled/
 *    enabled/low/high/max）/ --prompt-variant=<name>（缺省 base=生产 prompt）。
 *    非法值显式抛错。
 * 2. prompt 变体常量（**harness 侧集中，不动生产 prompts/**）：变体 = 系统
 *    提示词收紧段；`withPromptVariant` / `variantWrappedRunner` 在 runner 边界
 *    追加，生产 batchDedup/prompts 零改动。
 * 3. `thinkingConfigPatch`：thinking → StandaloneLLMConfig.thinkingLevel 注入
 *    映射（对齐生产 l1=low 消融臂；不注入时返回空补丁，runner config 不变）。
 * 4. 判定模型旋钮（票 07）：`parseAb5ModelKnobs`（--model / --provider 解析）、
 *    `resolveAb5ModelKnobs`（raw + yaml 全局 model → 生效值）、provider 预设表
 *    `AB5_PROVIDER_PRESETS`（opencode-go 条目对齐 tdai-panel vendorCatalog.ts）
 *    与 `providerLlmPatch`（runner config 组装：opencode 换 baseUrl + key 只取
 *    env + 注入 x-opencode-session 随机会话头；openai=yaml 原样）。
 *
 * 零生产影响：本模块只被 harness 导入；topk 经 batchDedup 既有 conflictRecallTopK
 * 参数透传（l1-dedup.ts），provider/model 只改 harness 侧 runner config 组装，
 * 不新增生产代码路径。可直测（golden-ab5-knobs.test.ts / golden-ab5-model.test.ts）。
 */

import { randomUUID } from "node:crypto";

import type { LLMRunner, LLMRunParams } from "../types.js";
import { THINKING_LEVELS, isThinkingLevel, type ThinkingLevel } from "../../adapters/standalone/llm-runner.js";
import { AB5_DEFAULT_PROVIDER, type Ab5Knobs, type Ab5ModelKnobs } from "./golden-ab5-metrics.js";
import { AB5_DEFAULT_KNOBS } from "./golden-ab5-metrics.js";

// ── prompt 变体常量（harness 侧；票 06 C 臂 strict）─────────────────────

/** strict 变体追加到系统提示词末尾的收紧段（金标标注口径对齐文案；预注册基准以本常量为准，票面简写版已被本常量取代）。 */
export const AB5_STRICT_PROMPT_SUFFIX =
  "判定纪律：只有当新记忆与某候选表达同一事实/规则/偏好/事件（不同措辞或互补阶段）时才可 merge/update；同主题但事实、对象或时间点不同的独立记忆必须 store；无法确定时宁可 store，不要合并。";

/** 候选变体表（变体名 → 追加段）；base=生产 prompt 不追加，故不在表中。 */
export const PROMPT_VARIANTS: Readonly<Record<string, string>> = {
  strict: AB5_STRICT_PROMPT_SUFFIX,
};

/** 缺省变体名 = 生产 prompt（不追加任何段落）。 */
export const DEFAULT_PROMPT_VARIANT = "base";

/** 变体名合法性：base（缺省）或 PROMPT_VARIANTS 的键。 */
export function isPromptVariantName(v: string): boolean {
  return v === DEFAULT_PROMPT_VARIANT || v in PROMPT_VARIANTS;
}

// ── 三参数解析 ──────────────────────────────────────────────────────────

/** 从 argv 取 `--name=value` 的 value（与 harness 既有 argValue 同语义：value 可含 =）。 */
function argValueFrom(argv: readonly string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
}

/** --topk 上限：与票 01 数据集候选池深一致（golden-5cand.ts 池 1..50 行），防误配超池深空转。 */
export const AB5_MAX_TOPK = 50;

/**
 * 三消融参数解析（缺省 = 票 02 基线复刻）：--topk 需为 1..50 整数（50=数据集
 * 最大池深）；--thinking 需为生产合法档位；--prompt-variant 需为 base 或已注册
 * 变体。非法值显式抛错，不允许静默回退（消融臂配置必须与实际执行严格一致）。
 */
export function parseAb5Knobs(argv: readonly string[]): Ab5Knobs {
  let { topk, thinking, promptVariant } = AB5_DEFAULT_KNOBS;

  const topkRaw = argValueFrom(argv, "topk");
  if (topkRaw !== undefined) {
    const n = Number(topkRaw);
    if (!Number.isInteger(n) || n < 1 || n > AB5_MAX_TOPK) {
      throw new Error(`[ab5] --topk 非法: ${JSON.stringify(topkRaw)}（须为 1..${AB5_MAX_TOPK} 的整数，${AB5_MAX_TOPK}=数据集最大池深）`);
    }
    topk = n;
  }

  const thinkingRaw = argValueFrom(argv, "thinking");
  if (thinkingRaw !== undefined) {
    if (!isThinkingLevel(thinkingRaw)) {
      throw new Error(`[ab5] --thinking 非法: ${JSON.stringify(thinkingRaw)}（合法: ${THINKING_LEVELS.join("/")}）`);
    }
    thinking = thinkingRaw;
  }

  const variantRaw = argValueFrom(argv, "prompt-variant");
  if (variantRaw !== undefined) {
    if (!isPromptVariantName(variantRaw)) {
      throw new Error(
        `[ab5] --prompt-variant 非法: ${JSON.stringify(variantRaw)}（合法: ${DEFAULT_PROMPT_VARIANT},${Object.keys(PROMPT_VARIANTS).join(",")}）`,
      );
    }
    promptVariant = variantRaw;
  }

  return { topk, thinking, promptVariant };
}

// ── prompt 变体注入点（runner 边界，生产链路零改动）─────────────────────

/**
 * 按变体改写单次 run 参数：strict 把收紧段追加到系统提示词末尾（原文在前、
 * 追加段在后，中间空行分隔）；base 原样返回（同一引用）。变体有追加段但
 * params.systemPrompt 缺失时显式抛错——不允许静默降级成 base（未来调用面
 * 变更若不再传 systemPrompt，strict 消融臂会失真成基线而不自知）。
 * 纯函数，不改写入参。
 */
export function withPromptVariant(params: LLMRunParams, variant: string): LLMRunParams {
  const suffix = PROMPT_VARIANTS[variant];
  if (!suffix) return params;
  if (!params.systemPrompt) {
    throw new Error(
      `[ab5] prompt 变体 ${JSON.stringify(variant)} 需要追加收紧段，但本次 run 缺 systemPrompt——拒绝静默降级为 base（消融臂配置失真防护）`,
    );
  }
  return { ...params, systemPrompt: `${params.systemPrompt}\n\n${suffix}` };
}

/** runner 包装：变体非 base 时在每次 run 前追加收紧段；base 直接返回内层 runner。 */
export function variantWrappedRunner(inner: LLMRunner, variant: string): LLMRunner {
  if (variant === DEFAULT_PROMPT_VARIANT || !PROMPT_VARIANTS[variant]) return inner;
  return {
    run: (params) => inner.run(withPromptVariant(params, variant)),
  };
}

// ── thinking 注入（StandaloneLLMConfig.thinkingLevel）───────────────────

/**
 * thinking 旋钮 → runner config 补丁：未注入（空串）返回空补丁（runner config
 * 保持生产原样）；已注入返回 { thinkingLevel }。档位合法性防御式再校验
 * （parse 已验，此处防手拼旋钮绕过解析）。
 */
export function thinkingConfigPatch(knobs: Ab5Knobs): { thinkingLevel?: ThinkingLevel } {
  if (!knobs.thinking) return {};
  if (!isThinkingLevel(knobs.thinking)) {
    throw new Error(`[ab5] thinking 旋钮非法: ${JSON.stringify(knobs.thinking)}（合法: ${THINKING_LEVELS.join("/")}）`);
  }
  return { thinkingLevel: knobs.thinking };
}

// ── 判定模型旋钮（票 07：--model / --provider）──────────────────────────

/** 单 provider 预设：换 provider 时 runner config 的替换来源（openai=无预设，yaml 原样）。 */
export interface Ab5ProviderPreset {
  baseUrl: string;
  /** key 值只从该 env 变量取（run-golden-ab5-v3.bat 注入；预设表零明文 key） */
  apiKeyEnv: string;
  /** provider 未被 --model 覆盖时的默认模型（yaml 模型名不跨厂商沿用） */
  defaultModel: string;
  /** 强制请求头名（值=每次运行随机会话串；opencode-go 缺该头上游 400 MissingSessionID，2026-10-16 探针实证） */
  sessionHeader: string;
}

/**
 * provider 预设表（openai 不在表内=缺省现状：直连 yaml llm 块）。opencode 条目
 * 逐字段对齐 tdai-panel server/vendorCatalog.ts 的 opencode-go 内置条目
 * （2026-10-24 快照：baseUrl/apiKeyEnv/defaultModel/session 头名）。
 */
export const AB5_PROVIDER_PRESETS: Readonly<Record<string, Ab5ProviderPreset>> = {
  opencode: {
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKeyEnv: "TDAI_KEY_OPENCODE",
    defaultModel: "deepseek-v4.1-flash",
    sessionHeader: "x-opencode-session",
  },
};

/** provider 名合法性：openai（缺省=现状）或预设表键。 */
export function isAb5ProviderName(v: string): boolean {
  return v === AB5_DEFAULT_PROVIDER || v in AB5_PROVIDER_PRESETS;
}

/**
 * 模型旋钮解析（票 07）：--provider=<openai|opencode>（缺省 openai=yaml 原样）；
 * --model=<id>（缺省空串=未覆盖，生效值经 resolveAb5ModelKnobs 结合 yaml 解析）。
 * 非法 provider / 空 model 显式抛错——消融臂配置必须与实际执行严格一致。
 */
export function parseAb5ModelKnobs(argv: readonly string[]): { provider: string; model: string } {
  let provider = AB5_DEFAULT_PROVIDER;
  let model = "";

  const providerRaw = argValueFrom(argv, "provider");
  if (providerRaw !== undefined) {
    if (!isAb5ProviderName(providerRaw)) {
      throw new Error(
        `[ab5] --provider 非法: ${JSON.stringify(providerRaw)}（合法: ${AB5_DEFAULT_PROVIDER},${Object.keys(AB5_PROVIDER_PRESETS).join(",")}）`,
      );
    }
    provider = providerRaw;
  }

  const modelRaw = argValueFrom(argv, "model");
  if (modelRaw !== undefined) {
    if (modelRaw === "") {
      throw new Error("[ab5] --model 非法: 空模型名（缺省=provider 对应默认：openai→yaml 全局值、opencode→预设默认模型）");
    }
    model = modelRaw;
  }

  return { provider, model };
}

/**
 * raw 模型旋钮 + yaml 全局 model → 生效模型旋钮：openai 未覆盖 → yaml 值（现状）；
 * opencode 未覆盖 → 预设默认模型。防御式再校验 provider（parse 已验，防手拼绕过）。
 */
export function resolveAb5ModelKnobs(raw: { provider: string; model: string }, yamlModel: string): Ab5ModelKnobs {
  if (!isAb5ProviderName(raw.provider)) {
    throw new Error(
      `[ab5] provider 非法: ${JSON.stringify(raw.provider)}（合法: ${AB5_DEFAULT_PROVIDER},${Object.keys(AB5_PROVIDER_PRESETS).join(",")}）`,
    );
  }
  const model =
    raw.model || (raw.provider === AB5_DEFAULT_PROVIDER ? yamlModel : AB5_PROVIDER_PRESETS[raw.provider]!.defaultModel);
  return { provider: raw.provider, model };
}

/** providerLlmPatch 的 llm 输入面（loadGatewayConfig 产出的 llm 块相关字段）。 */
export interface Ab5LlmSource {
  baseUrl: string;
  apiKey: string;
  model: string;
  headers?: Record<string, string>;
}

export interface ProviderLlmPatchOptions {
  /** env 来源（缺省 process.env；测试注入合成值） */
  env?: Record<string, string | undefined>;
  /** session 头值（缺省每次调用随机 UUID；测试注入固定值保确定性） */
  sessionId?: string;
}

/**
 * 判定模型旋钮 → runner config 组装片段（票 07）：
 * - openai：baseUrl/apiKey/headers 全套 yaml 原样（=现状直连），model=生效值。
 * - opencode：baseUrl 换预设；apiKey **只从预设 env 变量取**（缺失/空串显式抛错
 *   点名变量名、不盲跑；错误信息不含 key 值）；注入 session 头（值=随机会话串）。
 * harness 把返回片段铺进 StandaloneLLMRunner config（maxTokens 等标量仍来自 yaml）。
 * 纯函数（env/sessionId 可注入），可直测。
 */
export function providerLlmPatch(
  llm: Ab5LlmSource,
  mk: Ab5ModelKnobs,
  opts: ProviderLlmPatchOptions = {},
): { baseUrl: string; apiKey: string; model: string; headers?: Record<string, string> } {
  if (mk.provider === AB5_DEFAULT_PROVIDER) {
    return {
      baseUrl: llm.baseUrl,
      apiKey: llm.apiKey,
      model: mk.model,
      ...(llm.headers && Object.keys(llm.headers).length > 0 ? { headers: { ...llm.headers } } : {}),
    };
  }
  const preset = AB5_PROVIDER_PRESETS[mk.provider];
  if (!preset) {
    throw new Error(
      `[ab5] provider 非法: ${JSON.stringify(mk.provider)}（合法: ${AB5_DEFAULT_PROVIDER},${Object.keys(AB5_PROVIDER_PRESETS).join(",")}）`,
    );
  }
  const env = opts.env ?? process.env;
  const apiKey = env[preset.apiKeyEnv];
  if (typeof apiKey !== "string" || apiKey === "") {
    throw new Error(
      `[ab5] --provider=${mk.provider} 需要 env ${preset.apiKeyEnv}（run-golden-ab5-v3.bat 自动注入；缺失即退出，不盲跑）`,
    );
  }
  return {
    baseUrl: preset.baseUrl,
    apiKey,
    model: mk.model,
    headers: { [preset.sessionHeader]: opts.sessionId ?? randomUUID() },
  };
}
