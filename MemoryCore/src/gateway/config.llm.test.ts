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

describe("loadGatewayConfig llm.layers 分层覆盖", () => {
  const LAYERS_YAML = `
llm:
  activeProvider: "vendor-a"
  providers:
    - name: vendor-a
      baseUrl: "https://vendor-a.example/v1"
      apiKeyEnv: "TDAI_TEST_KEY_A"
      model: "model-a1"
      models: [model-a1]
      extra:
        disableThinking: true
  layers:
    l2:
      maxTokens: 16384
      disableThinking: false
    l3:
      model: "model-strong"
`;

  function withFixture(yaml: string, fn: () => void): void {
    const p = path.join(tmpDir, "fixture-layers.yaml");
    fs.writeFileSync(p, yaml, "utf-8");
    const prev = process.env.TDAI_GATEWAY_CONFIG;
    process.env.TDAI_GATEWAY_CONFIG = p;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.TDAI_GATEWAY_CONFIG;
      else process.env.TDAI_GATEWAY_CONFIG = prev;
    }
  }

  it("layers 折叠进配置对象:标量覆盖+层内 disableThinking 显式 false 保留(三态)", () => {
    withFixture(LAYERS_YAML, () => {
      const cfg = loadGatewayConfig();
      expect(cfg.llm.layers?.l2).toEqual({ maxTokens: 16384, disableThinking: false });
      expect(cfg.llm.layers?.l3).toEqual({ model: "model-strong" });
      expect(cfg.llm.layers?.l1).toBeUndefined();
      // 全局值不受 layers 影响(层覆盖发生在 resolveRuntimeLlm,不在折叠处)
      expect(cfg.llm.maxTokens).not.toBe(16384);
    });
  });

  it("未知层键 fail-fast 启动报错", () => {
    withFixture(LAYERS_YAML + "\n    l4:\n      maxTokens: 999\n", () => {
      expect(() => loadGatewayConfig()).toThrow(/未知层 "l4"/);
    });
  });

  it("layers 非映射形态 fail-fast", () => {
    // 注意:构造"yaml 合法但 layers 是数组"的形态——若 yaml 整体坏掉会被文件级 catch 吞成 env-only
    const badLayers = LAYERS_YAML.replace(/  layers:[\s\S]*$/, "  layers: [1, 2]\n");
    withFixture(badLayers, () => {
      expect(() => loadGatewayConfig()).toThrow(/llm\.layers 存在但不是映射/);
    });
  });
});
