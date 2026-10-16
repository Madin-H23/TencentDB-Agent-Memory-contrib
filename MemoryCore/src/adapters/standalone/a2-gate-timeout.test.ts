// A2（2026-10-16，继续中断的 A/B/C）：并发闸门内创建超时信号——排队等待不烧
// 调用预算。旧行为：AbortSignal.timeout 在闸门外创建，L1 排在 L2/L3 慢调用之后
// 时队列时间吃掉 timeoutMs（等 100s 排队+只剩 80s 调用），且限流重试的第二次
// 尝试复用同一个已烧过的信号。新行为：每次尝试在取得槽位后独享满额 timeoutMs，
// 总量仍由 callDeadlineMs 硬顶。
// 本测试用真定时器复现该场景：闸门限 1，调用 A 占位 600ms，调用 B 排队；
// B 的 timeoutMs=300ms——旧行为 B 在排队期就被掐（execute 时信号已 abort），
// 新行为 B 拿到满额 300ms 且正常完成。
import { describe, it, expect, vi, afterEach } from "vitest";

// mock AI SDK：generateText 尊重 abortSignal（已 abort 即拒，模拟真实 SDK 行为），
// 第一次调用挂起（占闸门），第二次立即成功。
const firstHang: { release?: (v: unknown) => void } = {};
let callCount = 0;

vi.mock("ai", () => ({
  generateText: vi.fn(async (params: { abortSignal?: AbortSignal }) => {
    callCount += 1;
    if (callCount === 1) {
      // 占位调用：挂起直到测试放行；放行后检查自身信号未被误掐
      return new Promise((resolve, reject) => {
        firstHang.release = (v) => resolve(v);
        params.abortSignal?.addEventListener("abort", () =>
          reject(new Error("aborted during LLM call")),
        );
      });
    }
    if (params.abortSignal?.aborted) {
      throw new Error("aborted during LLM call");
    }
    return { text: "ok", totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, steps: [] };
  }),
  streamText: vi.fn(),
  tool: vi.fn(),
  stepCountIs: vi.fn(() => ({ type: "stepCountIs" })),
  jsonSchema: vi.fn(),
  APICallError: { isInstance: () => false },
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => ({ chat: () => ({ mockModel: true }) })),
}));

import { StandaloneLLMRunner } from "./llm-runner.js";

afterEach(() => {
  vi.clearAllMocks();
});

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;

function makeRunner(baseUrl: string, timeoutMs: number) {
  return new StandaloneLLMRunner({
    config: {
      baseUrl,
      apiKey: "sk-test",
      model: "mock-model",
      maxConcurrency: 1,
      timeoutMs,
      callDeadlineMs: 5_000,
    },
    enableTools: false,
    logger: silentLogger,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("A2：超时信号在闸门内创建（排队不烧预算）", () => {
  it("排队 550ms 的调用仍拿满额 300ms 并成功（旧行为会在排队期被掐）", async () => {
    callCount = 0;
    const url = "https://mock-a2.test/v1";
    // A/B 同 baseUrl 共享闸门（limit=1）；A 长超时占位 600ms，B 300ms 排队 550ms
    const runnerA = makeRunner(url, 2_000);
    const runnerB = makeRunner(url, 300);

    const aPromise = runnerA.run({ prompt: "A", taskId: "a" });
    await sleep(50); // 确保 A 已取得槽位
    const bPromise = runnerB.run({ prompt: "B", taskId: "b" });
    await sleep(600); // B 全程在排队；旧行为此刻 B 的超时信号早已 fire
    firstHang.release?.({ text: "A-done", totalUsage: null, steps: [] });

    const [a, b] = await Promise.all([aPromise, bPromise]);
    expect(a).toBe("A-done");
    expect(b).toBe("ok"); // 新行为：B 在 execute 时才建信号，拿到满额预算
  }, 10_000);
});
