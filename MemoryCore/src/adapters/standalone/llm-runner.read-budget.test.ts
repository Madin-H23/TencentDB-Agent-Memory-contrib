// S0 影子计量：本地沙箱 read 必须
//   1) 原样返回全文（零行为变更）；
//   2) 记录 read-budget 读数（超 32K 时告警）。
//
// 通过 mock ai.generateText 捕获 runner 传给 SDK 的 tools，再直接调用 read.execute，
// 不依赖模型真的发起工具调用。
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const calls: Array<Record<string, unknown>> = [];

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(async (params: Record<string, unknown>) => {
      calls.push(params);
      return { text: "ok", usage: {}, steps: [] };
    }),
    streamText: vi.fn((params: Record<string, unknown>) => {
      calls.push(params);
      const result = {
        text: Promise.resolve("ok"),
        totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
        steps: Promise.resolve([]),
      };
      return Object.assign(Promise.resolve(result), result);
    }),
  };
});

const { StandaloneLLMRunner } = await import("./llm-runner.js");

const CONFIG = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "test-model",
  maxTokens: 1024,
  timeoutMs: 30_000,
};

describe("llm-runner 沙箱 read 预算影子计量（S0）", () => {
  it("读取内容原样返回，并记录 read-budget 告警", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-read-budget-"));
    try {
      const content = "x".repeat(33_000);
      await fs.writeFile(path.join(dir, "big.md"), content, "utf-8");

      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const runner = new StandaloneLLMRunner({
        config: CONFIG,
        model: "test-model",
        enableTools: true,
        logger,
      });
      await runner.run({ systemPrompt: "s", prompt: "p", workspaceDir: dir });

      const tools = (calls[0] as any)?.tools;
      expect(tools?.read?.execute).toBeTypeOf("function");

      const out = await tools.read.execute({ path: "big.md" });
      expect(out).toBe(content);

      const lines = logger.warn.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes("read-budget") && l.includes("over_file=true"))).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
