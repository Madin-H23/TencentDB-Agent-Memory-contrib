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

describe("loadGatewayConfig llm.maxConcurrency 并发闸门配置", () => {
  // 沿用模块级 tmpDir 与 TDAI_TEST_KEY_A（beforeAll 已就绪）
  function withFixture(yaml: string, fn: () => void): void {
    const p = path.join(tmpDir, "fixture-maxconc.yaml");
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

  const BASE_YAML = `
llm:
  activeProvider: "vendor-a"
  providers:
    - name: vendor-a
      baseUrl: "https://vendor-a.example/v1"
      apiKeyEnv: "TDAI_TEST_KEY_A"
      model: "model-a1"
`;

  it("未配置 → undefined（不限流，上游默认行为不变）", () => {
    const prev = process.env.TDAI_LLM_MAX_CONCURRENCY;
    delete process.env.TDAI_LLM_MAX_CONCURRENCY;
    try {
      withFixture(BASE_YAML, () => {
        expect(loadGatewayConfig().llm.maxConcurrency).toBeUndefined();
      });
    } finally {
      if (prev !== undefined) process.env.TDAI_LLM_MAX_CONCURRENCY = prev;
    }
  });

  it("yaml llm.maxConcurrency 折叠进配置", () => {
    const prev = process.env.TDAI_LLM_MAX_CONCURRENCY;
    delete process.env.TDAI_LLM_MAX_CONCURRENCY;
    try {
      withFixture(BASE_YAML + "  maxConcurrency: 4\n", () => {
        expect(loadGatewayConfig().llm.maxConcurrency).toBe(4);
      });
    } finally {
      if (prev !== undefined) process.env.TDAI_LLM_MAX_CONCURRENCY = prev;
    }
  });

  it("env TDAI_LLM_MAX_CONCURRENCY 压过 yaml 值", () => {
    const prev = process.env.TDAI_LLM_MAX_CONCURRENCY;
    process.env.TDAI_LLM_MAX_CONCURRENCY = "2";
    try {
      withFixture(BASE_YAML + "  maxConcurrency: 4\n", () => {
        expect(loadGatewayConfig().llm.maxConcurrency).toBe(2);
      });
    } finally {
      if (prev === undefined) delete process.env.TDAI_LLM_MAX_CONCURRENCY;
      else process.env.TDAI_LLM_MAX_CONCURRENCY = prev;
    }
  });
});

describe("loadGatewayConfig llm.maxConcurrency 端到端透传", () => {
  // 回归钉子（2026-10-13 事故）：闸门字段经 折叠→memory.llm splice→resolveRuntimeLlm
  // 三跳逐字段重建，任一跳丢字段闸门即静默失效。逐跳各有单测仍会漏，必须在出口钉。
  function withFixture(yaml: string, fn: () => void): void {
    const p = path.join(tmpDir, "fixture-maxconc-e2e.yaml");
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

  const E2E_YAML = `
llm:
  activeProvider: "vendor-a"
  maxConcurrency: 4
  providers:
    - name: vendor-a
      baseUrl: "https://vendor-a.example/v1"
      apiKeyEnv: "TDAI_TEST_KEY_A"
      model: "model-a1"
`;

  it("yaml maxConcurrency 抵达 memory.llm（splice 不丢字段）", () => {
    const prev = process.env.TDAI_LLM_MAX_CONCURRENCY;
    delete process.env.TDAI_LLM_MAX_CONCURRENCY;
    try {
      withFixture(E2E_YAML, () => {
        const cfg = loadGatewayConfig();
        expect(cfg.llm.maxConcurrency).toBe(4);
        expect(cfg.memory.llm.maxConcurrency).toBe(4);
      });
    } finally {
      if (prev !== undefined) process.env.TDAI_LLM_MAX_CONCURRENCY = prev;
    }
  });

  it("未配置时 memory.llm.maxConcurrency 为 undefined（不限流，行为不变）", () => {
    const prev = process.env.TDAI_LLM_MAX_CONCURRENCY;
    delete process.env.TDAI_LLM_MAX_CONCURRENCY;
    try {
      withFixture(E2E_YAML.replace("  maxConcurrency: 4\n", ""), () => {
        expect(loadGatewayConfig().memory.llm.maxConcurrency).toBeUndefined();
      });
    } finally {
      if (prev !== undefined) process.env.TDAI_LLM_MAX_CONCURRENCY = prev;
    }
  });
});

describe("loadGatewayConfig llm.callDeadlineMs 整调用硬期限", () => {
  function withFixture(yaml: string, fn: () => void): void {
    const p = path.join(tmpDir, "fixture-deadline.yaml");
    fs.writeFileSync(p, yaml, "utf-8");
    const prevCfg = process.env.TDAI_GATEWAY_CONFIG;
    const prev = process.env.TDAI_LLM_CALL_DEADLINE_MS;
    process.env.TDAI_GATEWAY_CONFIG = p;
    if (prev !== undefined) process.env.TDAI_LLM_CALL_DEADLINE_MS = "";
    else delete process.env.TDAI_LLM_CALL_DEADLINE_MS;
    try {
      fn();
    } finally {
      if (prevCfg === undefined) delete process.env.TDAI_GATEWAY_CONFIG;
      else process.env.TDAI_GATEWAY_CONFIG = prevCfg;
      if (prev !== undefined) process.env.TDAI_LLM_CALL_DEADLINE_MS = prev;
      else delete process.env.TDAI_LLM_CALL_DEADLINE_MS;
    }
  }

  const BASE_YAML = `
llm:
  activeProvider: "vendor-a"
  providers:
    - name: vendor-a
      baseUrl: "https://vendor-a.example/v1"
      apiKeyEnv: "TDAI_TEST_KEY_A"
      model: "model-a1"
`;

  it("未配置 → undefined（runner 用内置 180s 默认，上游行为不变）", () => {
    withFixture(BASE_YAML, () => {
      const cfg = loadGatewayConfig();
      expect(cfg.llm.callDeadlineMs).toBeUndefined();
      expect(cfg.memory.llm.callDeadlineMs).toBeUndefined();
    });
  });

  it("yaml 全局值抵达 memory.llm，分层覆盖抵达 memory.llm.layers（端到端出口钉）", () => {
    withFixture(
      BASE_YAML +
        "  callDeadlineMs: 360000\n" +
        "  layers:\n    l2:\n      callDeadlineMs: 660000\n",
      () => {
        const cfg = loadGatewayConfig();
        expect(cfg.llm.callDeadlineMs).toBe(360_000);
        expect(cfg.memory.llm.callDeadlineMs).toBe(360_000);
        expect(cfg.llm.layers?.l2?.callDeadlineMs).toBe(660_000);
      },
    );
  });

  it("env TDAI_LLM_CALL_DEADLINE_MS 压过 yaml 全局值", () => {
    const p = path.join(tmpDir, "fixture-deadline-env.yaml");
    fs.writeFileSync(p, BASE_YAML + "  callDeadlineMs: 360000\n", "utf-8");
    const prev = process.env.TDAI_GATEWAY_CONFIG;
    const prevEnv = process.env.TDAI_LLM_CALL_DEADLINE_MS;
    process.env.TDAI_GATEWAY_CONFIG = p;
    process.env.TDAI_LLM_CALL_DEADLINE_MS = "420000";
    try {
      expect(loadGatewayConfig().llm.callDeadlineMs).toBe(420_000);
    } finally {
      if (prev === undefined) delete process.env.TDAI_GATEWAY_CONFIG;
      else process.env.TDAI_GATEWAY_CONFIG = prev;
      if (prevEnv === undefined) delete process.env.TDAI_LLM_CALL_DEADLINE_MS;
      else process.env.TDAI_LLM_CALL_DEADLINE_MS = prevEnv;
    }
  });
});

describe("loadGatewayConfig llm.providerLabel 厂商显示名", () => {
  function withFixture(yaml: string, fn: () => void): void {
    const p = path.join(tmpDir, "fixture-provlabel.yaml");
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

  const BASE_YAML = `
llm:
  activeProvider: "vendor-a"
  providers:
    - name: vendor-a
      baseUrl: "https://vendor-a.example/v1"
      apiKeyEnv: "TDAI_TEST_KEY_A"
      model: "model-a1"
`;

  it("activeProvider 原样带入 llm.providerLabel 并抵达 memory.llm（端到端出口钉）", () => {
    withFixture(BASE_YAML, () => {
      const cfg = loadGatewayConfig();
      expect(cfg.llm.providerLabel).toBe("vendor-a");
      expect(cfg.memory.llm.providerLabel).toBe("vendor-a");
    });
  });
});

describe("loadGatewayConfig memory.extraction.dedupPromptVersion（D1 提示词版本开关）", () => {
  function withFixture(yaml: string, fn: () => void): void {
    const p = path.join(tmpDir, "fixture-promptver.yaml");
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

  const BASE = `
llm:
  activeProvider: "vendor-a"
  providers:
    - name: vendor-a
      baseUrl: "https://vendor-a.example/v1"
      apiKeyEnv: "TDAI_TEST_KEY_A"
      model: "model-a1"
memory:
  extraction:
    enableDedup: true
`;

  it("缺省 → v1（生产默认行为不变）", () => {
    withFixture(BASE, () => {
      expect(loadGatewayConfig().memory.extraction.dedupPromptVersion).toBe("v1");
    });
  });

  it("yaml v2 → cfg.memory.extraction.dedupPromptVersion=v2（出口钉）", () => {
    withFixture(BASE + "    dedupPromptVersion: v2\n", () => {
      expect(loadGatewayConfig().memory.extraction.dedupPromptVersion).toBe("v2");
    });
  });

  it("非法值 fail-fast（拼写错误静默失效比报错更危险）", () => {
    withFixture(BASE + "    dedupPromptVersion: v3\n", () => {
      expect(() => loadGatewayConfig()).toThrow(/dedupPromptVersion/);
    });
  });
});
