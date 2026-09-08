import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadGatewayConfig } from "./config.js";

// 唯一 seam:配置装载函数 loadGatewayConfig。
// 喂 yaml fixture + env,断言多厂商折叠产物与校验分支——只测外部行为
// (折叠结果/抛错/告警),不测内部实现。

const FIXTURE_YAML = `
llm:
  activeProvider: "vendor-a"
  providers:
    - name: vendor-a
      baseUrl: "https://vendor-a.example/v1"
      apiKeyEnv: "TDAI_TEST_KEY_A"
      model: "model-a1"
      models: [model-a1, model-a2]
      maxTokens: 2048
      extra:
        disableThinking: true
        headers:
          x-test-session: "sess-123"
    - name: vendor-b
      baseUrl: "https://vendor-b.example/v1"
      apiKeyEnv: "TDAI_TEST_KEY_B"
      model: "model-b1"
      models: [model-b1]
  maxTokens: 8192
  timeoutMs: 60000
`;

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-config-test-"));
  fs.writeFileSync(path.join(tmpDir, "fixture.yaml"), FIXTURE_YAML, "utf-8");
  process.env.TDAI_GATEWAY_CONFIG = path.join(tmpDir, "fixture.yaml");
  process.env.TDAI_TEST_KEY_A = "test-key-a-value";
  process.env.TDAI_TEST_KEY_B = "test-key-b-value";
});

afterAll(() => {
  delete process.env.TDAI_GATEWAY_CONFIG;
  delete process.env.TDAI_TEST_KEY_A;
  delete process.env.TDAI_TEST_KEY_B;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadGatewayConfig llm 多厂商折叠", () => {
  it("activeProvider 条目折叠为单对象:baseUrl / apiKeyEnv 取值 / model / headers / disableThinking", () => {
    const cfg = loadGatewayConfig();
    expect(cfg.llm.baseUrl).toBe("https://vendor-a.example/v1");
    expect(cfg.llm.apiKey).toBe("test-key-a-value");
    expect(cfg.llm.model).toBe("model-a1");
    expect(cfg.llm.disableThinking).toBe(true);
    expect(cfg.llm.headers).toEqual({ "x-test-session": "sess-123" });
    expect(cfg.llm.provider).toBe("openai");
  });

  it("厂商条目 maxTokens 覆盖 llm 级共享值;无条目值的厂商回落共享值", () => {
    expect(loadGatewayConfig().llm.maxTokens).toBe(2048);
    process.env.TDAI_ACTIVE_PROVIDER = "vendor-b";
    try {
      const cfg = loadGatewayConfig();
      expect(cfg.llm.model).toBe("model-b1");
      expect(cfg.llm.maxTokens).toBe(8192);
    } finally {
      delete process.env.TDAI_ACTIVE_PROVIDER;
    }
  });

  it("activeProvider 未命中 providers → 启动抛错(fail-fast,不静默回落)", () => {
    process.env.TDAI_ACTIVE_PROVIDER = "no-such-vendor";
    try {
      expect(() => loadGatewayConfig()).toThrow(/未命中 providers/);
    } finally {
      delete process.env.TDAI_ACTIVE_PROVIDER;
    }
  });

  it("apiKeyEnv 对应环境变量缺失 → 启动抛错(fail-fast)", () => {
    delete process.env.TDAI_TEST_KEY_A;
    try {
      expect(() => loadGatewayConfig()).toThrow(/环境变量未设置或为空/);
    } finally {
      process.env.TDAI_TEST_KEY_A = "test-key-a-value";
    }
  });

  it("model 不在 models 清单(含 env 覆盖后的最终值)→ console.warn 告警但不阻断", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.TDAI_ACTIVE_PROVIDER = "vendor-b";
    process.env.TDAI_LLM_MODEL = "model-brand-new";
    try {
      const cfg = loadGatewayConfig();
      expect(cfg.llm.model).toBe("model-brand-new");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("不在 models 清单"));
    } finally {
      warn.mockRestore();
      delete process.env.TDAI_ACTIVE_PROVIDER;
      delete process.env.TDAI_LLM_MODEL;
    }
  });

  it("env 覆盖链优先于折叠结果:TDAI_LLM_API_KEY 全局应急覆盖 apiKeyEnv", () => {
    process.env.TDAI_LLM_API_KEY = "global-override-key";
    try {
      expect(loadGatewayConfig().llm.apiKey).toBe("global-override-key");
    } finally {
      delete process.env.TDAI_LLM_API_KEY;
    }
  });
});
