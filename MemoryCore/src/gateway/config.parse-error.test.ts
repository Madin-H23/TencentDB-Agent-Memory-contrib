// P1（2026-10-14，v2 70055eb 移植）：损坏配置显错。v3 现状（红）：yaml/json
// 解析失败被空 catch 静默吞掉→env-only 回退，运行态与 yaml 假性一致，排障时
// 会误判「配置已生效」。目标（绿）：console.error 带文件路径与错误信息，
// 回退行为本身不变（配置文件仍是可选的）。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadGatewayConfig } from "./config.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gwconfig-err-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("loadGatewayConfig：损坏配置显错（不静默吞）", () => {
  it("yaml 语法坏 → console.error 带路径与错误，且不抛（env-only 回退）", () => {
    const bad = join(tmp, "bad.yaml");
    writeFileSync(bad, "deployMode: [unclosed\n  - broken", "utf-8");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("TDAI_GATEWAY_CONFIG", bad);

    let cfg: ReturnType<typeof loadGatewayConfig> | null = null;
    expect(() => { cfg = loadGatewayConfig(); }).not.toThrow();
    expect(cfg).not.toBeNull();
    // 显错必须带路径（排障定位）与错误文本
    const flat = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(flat).toContain(bad);
    // env-only 回退：默认端口仍在（未被坏 yaml 污染）
    expect(cfg!.server.port).toBe(8420);
  });

  it("json 语法坏 → 同样显错带路径", () => {
    const bad = join(tmp, "bad.json");
    writeFileSync(bad, "{ not json", "utf-8");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("TDAI_GATEWAY_CONFIG", bad);

    expect(() => loadGatewayConfig()).not.toThrow();
    const flat = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(flat).toContain(bad);
  });

  it("合法 yaml pin：不触发解析显错（正常路径零噪音）", () => {
    const good = join(tmp, "good.yaml");
    writeFileSync(good, "server:\n  port: 8431\n", "utf-8");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("TDAI_GATEWAY_CONFIG", good);

    const cfg = loadGatewayConfig();
    expect(errSpy).not.toHaveBeenCalled();
    expect(cfg.server.port).toBe(8431);
  });
});
