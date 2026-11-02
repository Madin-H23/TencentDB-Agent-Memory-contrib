// 票④b 前置 A2（exp/p1-4b-semantic-gate）：sendDimensions 透传。
// BGE-M3 拒收 dimensions（HTTP 400 / code 20015）：sendDimensions:false 时请求体
// 不得出现 dimensions 键；主路径 factory.ts 已传，StorePool 路径此前漏传。
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddingService } from "./embedding.js";
import { StorePool } from "./store-pool.js";
import type { MemoryTdaiConfig } from "../../config.js";

type FetchCall = { url: string; body: Record<string, unknown> };

function stubFetchOk(dims = 4): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) as Record<string, unknown> });
    return new Response(JSON.stringify({
      data: Array.from({ length: (JSON.parse(init.body) as { input: string[] }).input.length }, (_, index) => ({
        index,
        embedding: new Array(dims).fill(0.1),
      })),
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** 凭据闸：字面量 apiKey 一律改写为 env 引用（值在 beforeAll 里 stub）。 */
function baseConfig() {
  return {
    provider: "openai",
    baseUrl: "https://example.invalid/v1",
    apiKey: process.env.TDAI_TEST_EMB_KEY ?? "",
    model: "BAAI/bge-m3",
    dimensions: 1024,
  };
}

beforeEach(() => {
  vi.stubEnv("TDAI_TEST_EMB_KEY", "test-key-not-real");
});

describe("createEmbeddingService：sendDimensions", () => {
  it("sendDimensions:false → 请求体不含 dimensions（BGE-M3 兼容）", async () => {
    const calls = stubFetchOk();
    const svc = createEmbeddingService({ ...baseConfig(), sendDimensions: false });
    await svc.embed("你好");
    expect(calls.length).toBe(1);
    expect("dimensions" in calls[0]!.body).toBe(false);
    expect(calls[0]!.body.model).toBe("BAAI/bge-m3");
  });

  it("sendDimensions:true → 请求体含 dimensions=1024", async () => {
    const calls = stubFetchOk();
    const svc = createEmbeddingService({ ...baseConfig(), sendDimensions: true });
    await svc.embed("你好");
    expect(calls[0]!.body.dimensions).toBe(1024);
  });

  it("未显式配置 → 保持基线默认 true", async () => {
    const calls = stubFetchOk();
    const svc = createEmbeddingService({ ...baseConfig() });
    await svc.embed("你好");
    expect(calls[0]!.body.dimensions).toBe(1024);
  });
});

describe("StorePool 路径：sendDimensions 透传（此前漏传 → BGE-M3 必 400）", () => {
  it("getStore().embedding 请求体同样不含 dimensions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdai-embpool-"));
    const calls = stubFetchOk();
    const pool = new StorePool({
      mode: "sqlite",
      dataDir: dir,
      memoryCfg: {
        embedding: {
          enabled: true,
          ...baseConfig(), sendDimensions: false, maxInputChars: 5000, conflictRecallTopK: 5,
        },
        bm25: { enabled: false },
      } as unknown as MemoryTdaiConfig,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    try {
      const pooled = await pool.getStore("default", null);
      await pooled.embedding.embed("你好");
      expect(calls.length).toBe(1);
      expect("dimensions" in calls[0]!.body).toBe(false);
    } finally {
      // 不走 closeAll（grace 关闭 30s，单元测试不可接受）：直接关底层 store。
      const cached = await pool.getStore("default", null).catch(() => undefined);
      try { cached?.store.close(); } catch { /* ignore */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
