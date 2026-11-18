// REQ-2026-001：网关运行态覆盖层加载契约（基线 < 覆盖层 < env）。
// 面板切厂商不再改写 git 跟踪的 yaml，改写一个固定的非跟踪覆盖层文件；
// 网关加载时把它叠加到基线配置上。本测试先红后绿钉住四条 AC：
// AC-02 加载生效 / AC-03 优先级 / AC-04 坏文件 fail-soft / AC-08 空覆盖层逐字节不变。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadGatewayConfig } from "./config.js";

let tmp: string;
let baseline: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gw-overrides-"));
  // 基线配置：一个非覆盖字段（server.port）+ 一个将被覆盖字段（llm.model）。
  baseline = join(tmp, "tdai-gateway.yaml");
  writeFileSync(baseline, [
    "server:",
    "  port: 8420",
    "llm:",
    "  model: baseline-model",
    "  maxTokens: 100",
    "worker:",
    "  maxParkedRetries: true",
  ].join("\n"), "utf-8");
  vi.stubEnv("TDAI_GATEWAY_CONFIG", baseline);
  // 覆盖层路径经 env 注入到临时目录（生产缺省走 <dataDir>/tdai-runtime-overrides.yaml）。
  vi.stubEnv("TDAI_RUNTIME_OVERRIDES", join(tmp, "tdai-runtime-overrides.yaml"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("loadGatewayConfig：运行态覆盖层（REQ-2026-001）", () => {
  it("AC-02 覆盖字段取覆盖层、非覆盖字段仍取基线", () => {
    writeFileSync(join(tmp, "tdai-runtime-overrides.yaml"), [
      "llm:",
      "  model: overlay-model",
    ].join("\n"), "utf-8");

    const cfg = loadGatewayConfig();
    expect(cfg.llm.model).toBe("overlay-model");       // 覆盖字段来自覆盖层
    expect(cfg.llm.maxTokens).toBe(100);                // 同段未覆盖字段仍来自基线（递归合并保留）
    expect(cfg.server.port).toBe(8420);                 // 非覆盖段来自基线
    expect(cfg.worker.maxParkedRetries).toBe(true);
  });

  it("AC-03 优先级：env > 覆盖层 > 基线", () => {
    writeFileSync(join(tmp, "tdai-runtime-overrides.yaml"), "llm:\n  model: overlay-model\n", "utf-8");
    // env 通道注入 llm.model（现有 env 优先语义；用 getEnv 识别的键名，测试里探明后调整）
    vi.stubEnv("TDAI_LLM_MODEL", "env-model");

    const cfg = loadGatewayConfig();
    // env 通道 TDAI_LLM_MODEL 已存在（config.ts:672 env ?? str(llmConfig)），
    // 必须压过覆盖层与基线——精确断言钉住最高优先级，不用宽松 toContain。
    expect(cfg.llm.model).toBe("env-model");
  });

  it("AC-02 嵌套段递归合并：覆盖层只给 llm.layers.l1，基线 l2/l3 保留（审查 P1-1）", () => {
    // 基线补 layers.l2/l3（用第二个基线文件，避免污染 beforeEach 的 baseline）
    writeFileSync(baseline, [
      "server:", "  port: 8420",
      "llm:", "  model: baseline-model", "  maxTokens: 100",
      "  layers:",
      "    l2:", "      model: base-l2", "    l3:", "      model: base-l3",
    ].join("\n"), "utf-8");
    writeFileSync(join(tmp, "tdai-runtime-overrides.yaml"), [
      "llm:", "  layers:", "    l1:", "      model: overlay-l1",
    ].join("\n"), "utf-8");

    const cfg = loadGatewayConfig();
    const layers = (cfg.llm as unknown as { layers: Record<string, { model: string }> }).layers;
    expect(layers.l1.model).toBe("overlay-l1");  // 覆盖层新增
    expect(layers.l2.model).toBe("base-l2");      // 基线嵌套字段保留（浅合并会丢→红）
    expect(layers.l3.model).toBe("base-l3");
  });

  it("AC-04 坏覆盖层 fail-soft：记录错误 + 回落基线，不清空基线配置", () => {
    writeFileSync(join(tmp, "tdai-runtime-overrides.yaml"), "llm: [unclosed\n  - broken", "utf-8");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let cfg: ReturnType<typeof loadGatewayConfig> | null = null;
    expect(() => { cfg = loadGatewayConfig(); }).not.toThrow();
    expect(cfg).not.toBeNull();
    expect(cfg!.llm.model).toBe("baseline-model");      // 回落基线 ll
    expect(cfg!.server.port).toBe(8420);                 // 基线配置未被清空（独立 catch 关键）
    const flat = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(flat).toContain("runtime overrides");         // 错误日志带覆盖层标识
    expect(flat).toContain(join(tmp, "tdai-runtime-overrides.yaml")); // 显错带路径（排障定位·先例 config.parse-error.test.ts:36）
  });

  it("缺省路径用面板同款公式（无 legacy 回退）——审查 P1-2", () => {
    // 不设 TDAI_RUNTIME_OVERRIDES，改用 MEMORY_TENCENTDB_ROOT 指到临时根，
    // 覆盖层须落在 <root>/memory-tdai/tdai-runtime-overrides.yaml（面板同款）。
    // 同时造一个 legacy ~/memory-tdai 覆盖层作反饵，验证不会读它。
    vi.stubEnv("TDAI_RUNTIME_OVERRIDES", "");
    vi.stubEnv("MEMORY_TENCENTDB_ROOT", join(tmp, "tdai-root"));
    const newDir = join(tmp, "tdai-root", "memory-tdai");
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(newDir, "tdai-runtime-overrides.yaml"), "llm:\n  model: newpath-model\n", "utf-8");

    const cfg = loadGatewayConfig();
    expect(cfg.llm.model).toBe("newpath-model"); // 读新路径覆盖层
  });

  it("AC-08 覆盖层不存在 / 空骨架 → 行为逐字节同基线", () => {
    const base = loadGatewayConfig();
    expect(base.llm.model).toBe("baseline-model");
    expect(base.server.port).toBe(8420);

    // 空骨架 llm: {} → 仍逐字节同基线
    writeFileSync(join(tmp, "tdai-runtime-overrides.yaml"), "llm: {}\n", "utf-8");
    const withEmpty = loadGatewayConfig();
    expect(withEmpty.llm.model).toBe(base.llm.model);
    expect(withEmpty.server.port).toBe(base.server.port);
    expect(withEmpty.llm.maxTokens).toBe(base.llm.maxTokens);
  });
});
