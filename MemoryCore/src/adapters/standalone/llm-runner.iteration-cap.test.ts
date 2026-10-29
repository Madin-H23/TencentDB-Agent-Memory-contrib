// P1-2（2026-10-30 交叉评审修复）：工具循环撞顶可见性。
// steps 数达到 maxIterations 且末步仍含工具调用 = stopWhen(stepCountIs) 截断了
// 仍想继续调工具的模型，工具循环未正常收尾——必须升级为 logger.warn（可见失败
// 信号）；既有 "run() completed" debug 行保留。
//
// 通过 mock ai.generateText 注入受控 steps，不依赖模型真的发起调用。
import { describe, expect, it, vi } from "vitest";

let stubSteps: Array<Record<string, unknown>> = [];

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(async () => ({
      text: "partial output",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      steps: stubSteps,
    })),
    streamText: vi.fn(() => {
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

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeStep(n: number, withToolCall: boolean): Record<string, unknown> {
  return {
    stepNumber: n,
    toolCalls: withToolCall
      ? [{ toolCallId: `t${n}`, toolName: "read", input: { path: "a.md" } }]
      : [],
    text: withToolCall ? "" : "done",
    finishReason: withToolCall ? "tool-calls" : "stop",
  };
}

async function run(maxIterations: number, logger: ReturnType<typeof makeLogger>) {
  const runner = new StandaloneLLMRunner({
    config: CONFIG,
    model: "test-model",
    enableTools: true,
    logger,
  });
  return runner.run({
    systemPrompt: "s",
    prompt: "p",
    workspaceDir: process.cwd(),
    maxIterations,
  });
}

function warnLines(logger: ReturnType<typeof makeLogger>): string[] {
  return logger.warn.mock.calls.map((c) => String(c[0]));
}

function hasCapWarn(logger: ReturnType<typeof makeLogger>): boolean {
  return warnLines(logger).some((l) => l.includes("tool-iteration cap"));
}

describe("llm-runner 工具循环撞顶可见性（P1-2）", () => {
  it("steps ≥ maxIterations 且末步含工具调用 → warn，含 steps/maxIterations 数值", async () => {
    stubSteps = [makeStep(0, true), makeStep(1, true), makeStep(2, true)];
    const logger = makeLogger();
    await run(3, logger);
    expect(hasCapWarn(logger)).toBe(true);
    const capLine = warnLines(logger).find((l) => l.includes("tool-iteration cap"));
    expect(capLine).toContain("steps=3");
    expect(capLine).toContain("maxIterations=3");
  });

  it("撞顶 warn 升级为可见信号的同时，既有 run() completed debug 行保留", async () => {
    stubSteps = [makeStep(0, true), makeStep(1, true)];
    const logger = makeLogger();
    await run(2, logger);
    expect(hasCapWarn(logger)).toBe(true);
    const debugLines = logger.debug.mock.calls.map((c) => String(c[0]));
    expect(debugLines.some((l) => l.includes("run() completed"))).toBe(true);
  });

  it("steps < maxIterations（未撞顶）→ 不 warn", async () => {
    stubSteps = [makeStep(0, true), makeStep(1, true)];
    const logger = makeLogger();
    await run(3, logger);
    expect(hasCapWarn(logger)).toBe(false);
  });

  it("steps = maxIterations 但末步无工具调用（正常收尾）→ 不 warn", async () => {
    stubSteps = [makeStep(0, true), makeStep(1, true), makeStep(2, false)];
    const logger = makeLogger();
    await run(3, logger);
    expect(hasCapWarn(logger)).toBe(false);
  });

  it("仅前序步骤含工具调用、末步干净 → 不 warn（只看末步）", async () => {
    stubSteps = [makeStep(0, true), makeStep(1, false)];
    const logger = makeLogger();
    await run(2, logger);
    expect(hasCapWarn(logger)).toBe(false);
  });

  it("空 steps（纯文本任务）→ 不 warn", async () => {
    stubSteps = [];
    const logger = makeLogger();
    await run(3, logger);
    expect(hasCapWarn(logger)).toBe(false);
  });
});
