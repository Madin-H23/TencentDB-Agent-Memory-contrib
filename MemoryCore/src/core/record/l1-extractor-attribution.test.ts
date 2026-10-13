// 厂商/模型归属（2026-10-13）：完成/延后/失败三类日志与失败消息必须带
// provider+model——面板蒸馏记录两卡据此显示「(厂商: 模型)」，死信卡的死信
// 转储 error 字段随失败消息透出（无需额外管道）。
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./l1-dedup.js", () => ({
  batchDedup: async (params: Record<string, unknown>) => {
    if (params.dedupFailFast) throw new Error("concurrency reached, current: 6, limit: 5");
    return (params.memories as Array<{ record_id: string }>).map((m) => ({
      record_id: m.record_id,
      action: "store" as const,
      target_ids: [],
    }));
  },
}));

import { extractL1Memories, L1ExtractionFailure } from "./l1-extractor.js";
import type { LLMRunner } from "../types.js";

const T = 1_700_000_000_000;
const MESSAGES = [
  { id: "m1", role: "user" as const, content: "归属验证：完成日志与失败消息须带厂商与模型。", timestamp: T },
];
const RESPONSE = JSON.stringify([
  { scene_name: "归属场景", message_ids: ["m1"], memories: [{ type: "episodic", content: "归属事实", priority: 50 }] },
]);

const lines: string[] = [];
const logger = {
  info: (m: string) => lines.push(m),
  warn: (m: string) => lines.push(m),
  error: (m: string) => lines.push(m),
  debug: () => {},
};

function run(opts: { dedupFailFast?: boolean; model?: string; providerLabel?: string; llmResponse?: string }) {
  const llm = { run: async () => opts.llmResponse ?? RESPONSE } as unknown as LLMRunner;
  const baseDir = mkdtempSync(join(tmpdir(), "extractor-attrib-"));
  lines.length = 0;
  return extractL1Memories({
    messages: MESSAGES,
    sessionKey: "zcode-default",
    sessionId: "sess-attr",
    baseDir,
    config: {},
    logger,
    options: {
      enableDedup: true,
      promptMode: "chat",
      llmRunner: llm,
      dedupFailFast: opts.dedupFailFast,
      model: opts.model,
      providerLabel: opts.providerLabel,
    },
  }).finally(() => rmSync(baseDir, { recursive: true, force: true }));
}

describe("extractL1Memories：厂商/模型归属日志", () => {
  it("完成日志带 model=…, provider=…（面板轮次卡显示 厂商: 模型）", async () => {
    await run({ model: "deepseek-v4.1-flash", providerLabel: "opencode-go" });
    const complete = lines.find((l) => l.includes("Extraction complete"));
    expect(complete).toContain("model=deepseek-v4.1-flash");
    expect(complete).toContain("provider=opencode-go");
  });

  it("dedup 失败：延后 warn 行 + 失败消息均带归属（死信转储 error 字段随之透出）", async () => {
    await expect(
      run({ dedupFailFast: true, model: "deepseek-v4.1-flash", providerLabel: "opencode-go" }),
    ).rejects.toThrow(/concurrency reached/);
    const deferred = lines.find((l) => l.includes("l1-deferred"));
    expect(deferred).toContain("model=deepseek-v4.1-flash");
    expect(deferred).toContain("provider=opencode-go");
    // 失败消息后缀形如 "(model=…, provider=…)"，面板据此提取并剥离
    await expect(
      run({ dedupFailFast: true, model: "deepseek-v4.1-flash", providerLabel: "opencode-go" }),
    ).rejects.toMatchObject({
      reason: "dedup_failed",
      message: expect.stringContaining("(model=deepseek-v4.1-flash, provider=opencode-go)"),
    } as unknown as Record<string, unknown>);
  });

  it("全采样失败：延后行带归属，抛出原分类", async () => {
    await expect(
      run({ llmResponse: "not-json-at-all", model: "deepseek-v4.1-flash", providerLabel: "opencode-go" }),
    ).rejects.toBeInstanceOf(L1ExtractionFailure);
    const deferred = lines.find((l) => l.includes("l1-deferred"));
    expect(deferred).toContain("provider=opencode-go");
  });

  it("未传归属信息 → unknown 占位，行格式保持稳定（旧调用方不破）", async () => {
    await run({});
    const complete = lines.find((l) => l.includes("Extraction complete"));
    expect(complete).toContain("model=unknown, provider=unknown");
  });

  it("llm_error 失败消息同样带归属后缀（连接超时类死信卡可显示厂商:模型）", async () => {
    const boom = { run: async () => { throw new Error("Cannot connect to API: Connect Timeout Error"); } } as unknown as LLMRunner;
    await expect(
      extractL1Memories({
        messages: MESSAGES,
        sessionKey: "zcode-default",
        sessionId: "sess-attr",
        baseDir: mkdtempSync(join(tmpdir(), "extractor-attrib-")),
        config: {},
        logger,
        options: { enableDedup: false, promptMode: "chat", llmRunner: boom, model: "deepseek-v4.1-flash", providerLabel: "opencode-go" },
      }),
    ).rejects.toMatchObject({
      reason: "llm_error",
      message: expect.stringContaining("(model=deepseek-v4.1-flash, provider=opencode-go)"),
    } as unknown as Record<string, unknown>);
  });
});
