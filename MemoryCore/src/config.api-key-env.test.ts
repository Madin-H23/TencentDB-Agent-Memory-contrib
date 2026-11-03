// 票④b 前置 A1（exp/p1-4b-semantic-gate）：embedding.apiKeyEnv。
// 仓库 yaml 不得出现明文 key；解析顺序 apiKey 明文优先 → process.env[apiKeyEnv]；
// 两者皆空 → 既有 configError 路径禁用 embedding（不抛、不崩）。
import { describe, it, expect, afterEach, vi } from "vitest";
import { parseConfig } from "./config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function parseEmbedding(embedding: Record<string, unknown>, rest: Record<string, unknown> = {}) {
  return parseConfig({ embedding, ...rest } as never);
}

describe("parseConfig：embedding.apiKeyEnv", () => {
  it("apiKeyEnv 命中 env → 生效，apiKeyEnv 字段保留", () => {
    vi.stubEnv("TDAI_TEST_EMB_KEY", "env-key-value");
    const cfg = parseEmbedding({
      provider: "openai",
      baseUrl: "https://example.invalid/v1",
      model: "BAAI/bge-m3",
      dimensions: 1024,
      apiKeyEnv: "TDAI_TEST_EMB_KEY",
    });
    expect(cfg.embedding.enabled).toBe(true);
    expect(cfg.embedding.apiKey).toBe("env-key-value");
    expect(cfg.embedding.apiKeyEnv).toBe("TDAI_TEST_EMB_KEY");
    expect(cfg.embedding.configError).toBeUndefined();
  });

  it("apiKey 明文优先于 apiKeyEnv（兼容既有 yaml）", () => {
    vi.stubEnv("TDAI_TEST_EMB_KEY", "env-key-value");
    vi.stubEnv("TDAI_TEST_PLAIN_KEY", "plain-key-value");
    const cfg = parseEmbedding({
      provider: "openai",
      baseUrl: "https://example.invalid/v1",
      model: "m",
      dimensions: 8,
      // 凭据闸：字面量 apiKey 一律改写为 env 引用（值在测试内 stub）
      apiKey: process.env.TDAI_TEST_PLAIN_KEY,
      apiKeyEnv: "TDAI_TEST_EMB_KEY",
    });
    expect(cfg.embedding.apiKey).toBe("plain-key-value");
  });

  it("apiKeyEnv 缺失（env 未设）→ configError + embedding disabled，不抛", () => {
    vi.stubEnv("TDAI_TEST_EMB_KEY_MISSING", "");
    const cfg = parseEmbedding({
      provider: "openai",
      baseUrl: "https://example.invalid/v1",
      model: "m",
      dimensions: 8,
      apiKeyEnv: "TDAI_TEST_EMB_KEY_MISSING",
    });
    expect(cfg.embedding.enabled).toBe(false);
    expect(cfg.embedding.apiKey).toBe("");
    expect(cfg.embedding.configError).toContain("apiKey");
  });

  it("apiKeyEnv 名字非法 → throw（对齐 jev 的 env 名校验）", () => {
    expect(() => parseEmbedding({ provider: "openai", apiKeyEnv: "not-a-valid-env" })).toThrow(/apiKeyEnv/);
    expect(() => parseEmbedding({ provider: "openai", apiKeyEnv: "1STARTS_WITH_DIGIT" })).toThrow(/apiKeyEnv/);
  });

  it("未配置 apiKeyEnv → 行为与基线一致（provider=none 时不报 configError）", () => {
    const cfg = parseEmbedding({ provider: "none" });
    expect(cfg.embedding.enabled).toBe(false);
    expect(cfg.embedding.apiKeyEnv).toBeUndefined();
    expect(cfg.embedding.configError).toBeUndefined();
  });
});
