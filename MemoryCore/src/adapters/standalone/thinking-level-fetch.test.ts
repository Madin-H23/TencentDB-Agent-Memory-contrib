// 思考等级的**出站请求体**行为测试（2026-10-20）。
// 此前 thinking-level.test.ts 只测了三个纯函数，最危险的 fetch 覆写逻辑
// （注入 / 剥离 / 400 重试 / 自适应判定）零覆盖 → 补上。
//
// 打桩 globalThis.fetch，直接断言发出去的 body 里有没有思考类参数。
import { describe, it, expect, vi, afterEach } from "vitest";

import { StandaloneLLMRunner, type StandaloneLLMConfig } from "./llm-runner.js";

const BASE: StandaloneLLMConfig = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "some-model",
  maxTokens: 4096,
  timeoutMs: 30_000,
};

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

/** 打桩 fetch：记录每次请求的 body，并按脚本返回响应 */
function stubFetch(responses: Array<{ status: number; body: string }>) {
  const captured: Captured[] = [];
  let i = 0;
  const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    } catch {
      body = {};
    }
    captured.push({ url: String(url), body });
    const r = responses[Math.min(i, responses.length - 1)] ?? { status: 200, body: "{}" };
    i += 1;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => r.body,
      clone() {
        return { text: async () => r.body };
      },
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return captured;
}

const OK_BODY = JSON.stringify({
  choices: [{ message: { content: "ok" } }],
  usage: { input_tokens: 1, output_tokens: 1 },
});

async function runWith(
  model: string,
  thinkingLevel: string | undefined,
  captured: Captured[],
): Promise<void> {
  const runner = new StandaloneLLMRunner({
    config: { ...BASE, model, thinkingLevel: thinkingLevel as never },
  });
  try {
    await runner.run({ taskId: "t", prompt: "hi" } as never);
  } catch {
    /* 响应体不合法也会抛；这里只关心出站 body */
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("非 minimax 厂商：等级参数真的发出去", () => {
  it("low → reasoning_effort=low；high → high", async () => {
    const c1 = stubFetch([{ status: 200, body: OK_BODY }]);
    await runWith("glm-4.7-flash", "low", c1);
    expect(c1[0]!.body.reasoning_effort).toBe("low");
    expect(c1[0]!.body.thinking).toBeUndefined();

    const c2 = stubFetch([{ status: 200, body: OK_BODY }]);
    await runWith("glm-4.7-flash", "high", c2);
    expect(c2[0]!.body.reasoning_effort).toBe("high");
  });

  it("disabled → thinking:{type:disabled}", async () => {
    const c = stubFetch([{ status: 200, body: OK_BODY }]);
    await runWith("glm-4.7-flash", "disabled", c);
    expect(c[0]!.body.thinking).toEqual({ type: "disabled" });
  });

  it("max → reasoning_effort + thinking 两套方言并存", async () => {
    const c = stubFetch([{ status: 200, body: OK_BODY }]);
    await runWith("glm-4.7-flash", "max", c);
    expect(c[0]!.body.reasoning_effort).toBe("high");
    expect(c[0]!.body.thinking).toEqual({ type: "enabled" });
  });

  it("default / enabled → 不注入任何思考参数", async () => {
    for (const lv of ["default", "enabled"]) {
      const c = stubFetch([{ status: 200, body: OK_BODY }]);
      await runWith("glm-4.7-flash", lv, c);
      expect(c[0]!.body.reasoning_effort).toBeUndefined();
      expect(c[0]!.body.thinking).toBeUndefined();
    }
  });
});

describe("minimax 推理型 M 系：等级被忽略（要求 adaptive thinking）", () => {
  it("六档都不发思考参数（自适应思考不可关）", async () => {
    for (const lv of ["default", "disabled", "enabled", "low", "high", "max"]) {
      const c = stubFetch([{ status: 200, body: OK_BODY }]);
      await runWith("minimax-m3.1-flash-free", lv, c);
      expect(c[0]!.body.reasoning_effort).toBeUndefined();
      expect(c[0]!.body.thinking).toBeUndefined();
    }
  });

  it("非推理型的 minimax 模型不再被误判（等级照发）", async () => {
    const c = stubFetch([{ status: 200, body: OK_BODY }]);
    await runWith("minimax-text-01", "high", c);
    expect(c[0]!.body.reasoning_effort).toBe("high");
  });
});

describe("上游 400：剥离后重试一次", () => {
  it("自适应约束措辞 → 整套思考参数剥离后重试", async () => {
    const c = stubFetch([
      {
        status: 400,
        body: JSON.stringify({
          error: { message: 'invalid params, model "MiniMax-M3.1-Flash" requires adaptive thinking' },
        }),
      },
      { status: 200, body: OK_BODY },
    ]);
    const runner = new StandaloneLLMRunner({
      config: { ...BASE, model: "other-model", thinkingLevel: "disabled" as never },
    });
    try {
      await runner.run({ taskId: "t", prompt: "hi" } as never);
    } catch {
      /* ignore */
    }
    expect(c).toHaveLength(2);
    expect(c[0]!.body.thinking).toEqual({ type: "disabled" });
    expect(c[1]!.body.thinking).toBeUndefined();
  });

  it("「未知参数」措辞（此前正则漏判 → 硬 400 整层挂）也能兜住", async () => {
    const c = stubFetch([
      { status: 400, body: JSON.stringify({ error: { message: "Unrecognized request argument supplied: reasoning_effort" } }) },
      { status: 200, body: OK_BODY },
    ]);
    const runner = new StandaloneLLMRunner({
      config: { ...BASE, model: "other-model", thinkingLevel: "low" as never },
    });
    try {
      await runner.run({ taskId: "t", prompt: "hi" } as never);
    } catch {
      /* ignore */
    }
    expect(c).toHaveLength(2);
    expect(c[1]!.body.reasoning_effort).toBeUndefined();
  });

  it("定向剥离：只删被点名的参数，保住另一套方言", async () => {
    const c = stubFetch([
      { status: 400, body: JSON.stringify({ error: { message: "Unknown parameter: reasoning_effort" } }) },
      { status: 200, body: OK_BODY },
    ]);
    const runner = new StandaloneLLMRunner({
      config: { ...BASE, model: "other-model", thinkingLevel: "max" as never },
    });
    try {
      await runner.run({ taskId: "t", prompt: "hi" } as never);
    } catch {
      /* ignore */
    }
    expect(c).toHaveLength(2);
    // 只掉 reasoning_effort，thinking 保留
    expect(c[1]!.body.reasoning_effort).toBeUndefined();
    expect(c[1]!.body.thinking).toEqual({ type: "enabled" });
  });

  it("非思考类 400 不重试（原样返回）", async () => {
    const c = stubFetch([{ status: 400, body: JSON.stringify({ error: { message: "context length exceeded" } }) }]);
    const runner = new StandaloneLLMRunner({
      config: { ...BASE, model: "other-model", thinkingLevel: "low" as never },
    });
    try {
      await runner.run({ taskId: "t", prompt: "hi" } as never);
    } catch {
      /* ignore */
    }
    expect(c).toHaveLength(1);
  });
});
