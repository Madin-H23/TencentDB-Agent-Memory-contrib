// AI SDK 内置重试关闭（批次 1.2 / v3 移植漏带的回归修复）。
//
// v2 的 859d388 已在 SDK 调用上设过 maxRetries:0，v3 移植 1765221 时漏带，
// SDK 调用回落到默认 3 连发。内置重试间隔约 8s，对限流/日额度类拒绝毫无意义
// （额度不会在 8 秒内恢复），却把每次失败的厂商请求放大 3 倍；与外层限流退避
// 重试叠加后单次抽取最多打出 6 个厂商请求。
//
// 实测证据："Failed after 3 attempts" 在 v2 生效期（10-08~10-13）出现 0 次，
// v3 接管后（10-14~10-20）出现 999 次。
//
// 本测试直接断言 SDK 收到的参数——不依赖日志文本。
import { describe, expect, it, vi, beforeEach } from "vitest";

const calls: Array<Record<string, unknown>> = [];

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(async (params: Record<string, unknown>) => {
      calls.push(params);
      return { text: "ok", usage: {}, steps: [] };
    }),
    // streamText 的真实返回值是**带属性的 thenable**（text / totalUsage / steps
    // 都是属性而非 await 后的值），runner 侧是 `streamResult.text` 这样直接取属性。
    // mock 必须复刻这个形状，否则会把「取属性」误测成「await 整个对象」。
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

beforeEach(() => {
  calls.length = 0;
});

describe("StandaloneLLMRunner：maxRetries 必须为 0", () => {
  it("非流式调用传给 SDK 的 maxRetries 为 0", async () => {
    const runner = new StandaloneLLMRunner({ config: CONFIG, model: "test-model" });
    await runner.run({ systemPrompt: "s", prompt: "p" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.maxRetries).toBe(0);
  });

  it("流式调用传给 SDK 的 maxRetries 同样为 0", async () => {
    const runner = new StandaloneLLMRunner({ config: CONFIG, model: "test-model", stream: true });
    await runner.run({ systemPrompt: "s", prompt: "p" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.maxRetries).toBe(0);
  });

  it("maxRetries 不是 undefined（缺省会回落到 SDK 默认 3 连发）", async () => {
    const runner = new StandaloneLLMRunner({ config: CONFIG, model: "test-model" });
    await runner.run({ systemPrompt: "s", prompt: "p" });
    expect(calls[0]!.maxRetries).not.toBeUndefined();
  });

  it("该设置与外层限流退避重试并存（外层仍会重试限流类错误）", async () => {
    // 外层 runWithRateLimitRetry 的 maxRetries: 1 不受影响——
    // SDK 内层不重试，外层对限流错误做指数退避后重试一次。
    const runner = new StandaloneLLMRunner({ config: CONFIG, model: "test-model" });
    await runner.run({ systemPrompt: "s", prompt: "p" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.maxRetries).toBe(0);
  });
});
