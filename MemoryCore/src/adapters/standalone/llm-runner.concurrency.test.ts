import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { StandaloneLLMRunner } from "./llm-runner.js";

// ---------------------------------------------------------------------------
// StandaloneLLMRunner 厂商并发闸门集成测试：本地 http 桩模拟 OpenAI 兼容端点，
// 统计厂商侧峰值在飞请求数。契约：
//   1) config.maxConcurrency=N → 无论 run() 并发多少，桩侧峰值 ≤ N
//   2) 未配置 maxConcurrency → 不限（峰值可打满发起数，上游行为不变）
//   3) 失败释放许可：500 后下个调用仍能进入（信号量不吞 permit）
// ---------------------------------------------------------------------------

const CHAT_OK = JSON.stringify({
  id: "chatcmpl-stub",
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model: "stub-model",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

interface StubHandle {
  server: Server;
  url: string;
  peak: () => number;
  failNext500: () => void;
}

async function startStub(delayMs: number): Promise<StubHandle> {
  let inFlight = 0;
  let peakSeen = 0;
  let pending500 = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c;
    });
    req.on("end", () => {
      if (pending500 > 0) {
        pending500--;
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "internal boom" } }));
        return;
      }
      inFlight++;
      peakSeen = Math.max(peakSeen, inFlight);
      setTimeout(() => {
        inFlight--;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(CHAT_OK);
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("stub listen failed");
  return {
    server,
    url: `http://127.0.0.1:${addr.port}/v1`,
    peak: () => peakSeen,
    failNext500: () => {
      pending500++;
    },
  };
}

function makeRunner(baseUrl: string, maxConcurrency?: number): StandaloneLLMRunner {
  return new StandaloneLLMRunner({
    config: {
      baseUrl,
      apiKey: "stub-key",
      model: "stub-model",
      maxTokens: 64,
      timeoutMs: 10_000,
      ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
    },
    model: "stub-model",
    enableTools: false,
  });
}

const RUN_PARAMS = {
  systemPrompt: "sys",
  prompt: "hello",
  taskId: "stub-task",
};

describe("StandaloneLLMRunner maxConcurrency 闸门", () => {
  let stub: StubHandle;

  beforeAll(async () => {
    stub = await startStub(25);
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  });

  it("maxConcurrency=2：5 个并发 run() 桩侧峰值 ≤2 且全部成功", async () => {
    const runner = makeRunner(stub.url, 2);
    const texts = await Promise.all(
      Array.from({ length: 5 }, () => runner.run({ ...RUN_PARAMS })),
    );
    expect(texts).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(stub.peak()).toBeLessThanOrEqual(2);
    expect(stub.peak()).toBe(2); // 真并发而非串行
  });

  it("未配置 maxConcurrency：不限流，峰值可到发起数", async () => {
    const runner = makeRunner(stub.url);
    await Promise.all(Array.from({ length: 4 }, () => runner.run({ ...RUN_PARAMS })));
    expect(stub.peak()).toBeGreaterThanOrEqual(4);
  });

  it("失败释放许可：500 拒绝后，同闸门的下个调用仍能完成", async () => {
    const runner = makeRunner(stub.url, 1);
    stub.failNext500();
    await expect(runner.run({ ...RUN_PARAMS })).rejects.toThrow(/boom/);
    await expect(runner.run({ ...RUN_PARAMS })).resolves.toBe("ok");
    // 第二次调用确实到达了桩（许可被释放的证据）
    expect(stub.peak()).toBeGreaterThanOrEqual(1);
  });

  it("按 baseUrl 分桶：两个不同端点互不占用许可", async () => {
    // 用全新桩：peak 是累计值，不能复用前序用例打满过的 stub
    const a0 = await startStub(25);
    const b0 = await startStub(25);
    try {
      const a = makeRunner(a0.url, 1);
      const b = makeRunner(b0.url, 1);
      const [pa, pb] = await Promise.all([
        Promise.all(Array.from({ length: 3 }, () => a.run({ ...RUN_PARAMS }))),
        Promise.all(Array.from({ length: 3 }, () => b.run({ ...RUN_PARAMS }))),
      ]);
      expect(pa).toHaveLength(3);
      expect(pb).toHaveLength(3);
      expect(a0.peak()).toBeLessThanOrEqual(1);
      expect(b0.peak()).toBeLessThanOrEqual(1);
    } finally {
      await new Promise<void>((resolve) => a0.server.close(() => resolve()));
      await new Promise<void>((resolve) => b0.server.close(() => resolve()));
    }
  });
});
