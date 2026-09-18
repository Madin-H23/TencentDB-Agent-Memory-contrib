// Regression tests for the log-noise hardening batch (local standalone ops):
// 1. l0-recorder target-miss WARN rate-limit (pure helper, direct unit test)
// 2. malformed config file → visible console.error + env-only fallback
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldWarnTargetMiss } from "./l0-recorder.js";
import { loadGatewayConfig } from "../../gateway/config.js";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TDAI_GATEWAY_CONFIG;
  delete process.env.TDAI_GATEWAY_PORT;
});

describe("shouldWarnTargetMiss（err 日志限频）", () => {
  it("窗口内首条 WARN，其后降级，窗口过期再 WARN", () => {
    const t0 = 1_000_000;
    expect(shouldWarnTargetMiss(t0)).toBe(true); // 首条
    expect(shouldWarnTargetMiss(t0 + 1000)).toBe(false);
    expect(shouldWarnTargetMiss(t0 + 5 * 60 * 1000)).toBe(false);
    expect(shouldWarnTargetMiss(t0 + 10 * 60 * 1000)).toBe(true); // 恰好到期
    expect(shouldWarnTargetMiss(t0 + 10 * 60 * 1000 + 1)).toBe(false);
  });
});

describe("loadGatewayConfig 损坏配置文件", () => {
  it("解析失败时 console.error 可见 + 回退 env-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "tdai-cfg-malformed-"));
    const cfgPath = join(dir, "tdai-gateway.yaml");
    writeFileSync(cfgPath, "llm: [this: is: not: valid: yaml", "utf-8");
    process.env.TDAI_GATEWAY_CONFIG = cfgPath;
    process.env.TDAI_GATEWAY_PORT = "4599";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const cfg = loadGatewayConfig() as unknown as { server: { port: number } };
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(String(errSpy.mock.calls[0]?.[0])).toContain(cfgPath);
      // env-only 回退：env 里设置的端口仍然生效
      expect(cfg.server.port).toBe(4599);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
