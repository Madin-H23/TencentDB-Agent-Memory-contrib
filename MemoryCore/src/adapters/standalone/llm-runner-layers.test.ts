// 分层模型配置（v2 llm.layers 移植，2026-10-15）：纯函数层直测。
// v3 重写丢失 llm.layers 与 disableThinking（env TDAI_DISABLE_THINKING 成死配置），
// 面板「分层配置编辑」写的 llm.layers.lN 在 v3 是死配置。目标（绿）：
// applyLlmLayerOverride 按层叠覆盖标量字段（未配置字段沿用全局）；
// resolveDisableThinking 三态（显式值 > env TDAI_DISABLE_THINKING）。
import { describe, it, expect, vi, afterEach } from "vitest";

import { applyLlmLayerOverride, resolveDisableThinking } from "./llm-runner.js";
import type { StandaloneLLMConfig, LlmLayerOverride } from "./llm-runner.js";

const BASE: StandaloneLLMConfig = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "global-model",
  maxTokens: 4096,
  timeoutMs: 120_000,
  callDeadlineMs: 360_000,
  maxConcurrency: 4,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("applyLlmLayerOverride：按层叠覆盖", () => {
  it("无覆盖 → 原样返回（同一配置值，不新增字段）", () => {
    const out = applyLlmLayerOverride(BASE, undefined);
    expect(out).toEqual(BASE);
  });

  it("部分覆盖 → 未配置字段沿用全局，已配置字段被覆盖", () => {
    const ov: LlmLayerOverride = { model: "l1-model", maxTokens: 32768 };
    const out = applyLlmLayerOverride(BASE, ov);
    expect(out.model).toBe("l1-model");
    expect(out.maxTokens).toBe(32768);
    expect(out.timeoutMs).toBe(120_000);
    expect(out.baseUrl).toBe(BASE.baseUrl);
    expect(out.callDeadlineMs).toBe(360_000);
  });

  it("disableThinking 三态：true/false 显式覆盖、undefined 沿用全局", () => {
    expect(applyLlmLayerOverride(BASE, { disableThinking: true }).disableThinking).toBe(true);
    expect(applyLlmLayerOverride(BASE, { disableThinking: false }).disableThinking).toBe(false);
    expect(applyLlmLayerOverride(BASE, {}).disableThinking).toBeUndefined();
  });

  it("callDeadlineMs/timeoutMs 可独立按层覆盖", () => {
    const out = applyLlmLayerOverride(BASE, { timeoutMs: 600_000, callDeadlineMs: 660_000 });
    expect(out.timeoutMs).toBe(600_000);
    expect(out.callDeadlineMs).toBe(660_000);
  });

  it("stream 可按层覆盖（l2/l3 流式绕开 undici 300s headersTimeout）", () => {
    expect(applyLlmLayerOverride(BASE, { stream: true }).stream).toBe(true);
    expect(applyLlmLayerOverride(BASE, { stream: false }).stream).toBe(false);
    expect(applyLlmLayerOverride(BASE, {}).stream).toBe(BASE.stream);
  });

  it("headers 是全局字段：按层覆盖不丢、层覆盖改不动（v2 extra.headers 移植）", () => {
    const withHeaders: StandaloneLLMConfig = {
      ...BASE,
      headers: { "x-opencode-session": "8ae1bd54-2614-41ae-9ada-c21a2a3e7a00" },
    };
    expect(applyLlmLayerOverride(withHeaders, { model: "l1-model" }).headers).toEqual({
      "x-opencode-session": "8ae1bd54-2614-41ae-9ada-c21a2a3e7a00",
    });
    // LlmLayerOverride 无 headers 键——编译期即挡「按层换头」意图
    expect(applyLlmLayerOverride(withHeaders, { maxTokens: 1 }).headers).toEqual(withHeaders.headers);
  });

  it("不改写入参 base（纯函数）", () => {
    const snapshot = { ...BASE };
    applyLlmLayerOverride(BASE, { model: "x", maxTokens: 1, timeoutMs: 2, disableThinking: true, callDeadlineMs: 3 });
    expect(BASE).toEqual(snapshot);
  });

  it("覆盖值不以空串/0 回落全局（显式即生效，空 model 除外——与 v2 语义一致：空串 model 视为未设置）", () => {
    const out = applyLlmLayerOverride(BASE, { model: "", maxTokens: 0, timeoutMs: 0 });
    expect(out.model).toBe("global-model"); // 空 model 不生效
    expect(out.maxTokens).toBe(0); // 数值 0 显式生效
    expect(out.timeoutMs).toBe(0);
  });
});

describe("resolveDisableThinking：三态开关", () => {
  it("未配置且 env 未设 → false（上游默认行为不变）", () => {
    vi.stubEnv("TDAI_DISABLE_THINKING", "");
    expect(resolveDisableThinking(undefined)).toBe(false);
  });

  it("未配置 + env=true → true", () => {
    vi.stubEnv("TDAI_DISABLE_THINKING", "true");
    expect(resolveDisableThinking(undefined)).toBe(true);
  });

  it("显式 true 压过 env 缺失 → true", () => {
    expect(resolveDisableThinking(true)).toBe(true);
  });

  it("显式 false 压过 env=true（层内强制开）→ false", () => {
    vi.stubEnv("TDAI_DISABLE_THINKING", "true");
    expect(resolveDisableThinking(false)).toBe(false);
  });
});
