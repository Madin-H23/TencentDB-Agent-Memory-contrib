// 分层模型配置（v2 llm.layers 移植，2026-10-15）：gateway 配置解析 + splice 透传。
// v3 现状（红）：yaml llm.layers 无人解析（面板「分层配置编辑」写的是死配置），
// 且 splice 逐字段重建丢失 maxConcurrency/callDeadlineMs/stream——同 v2 e674e3a 装配链教训。
// 目标（绿）：llm.layers.l1/l2/l3 五标量字段（model/maxTokens/timeoutMs/disableThinking/
// callDeadlineMs）解析进 cfg.llm.layers，并随 splice 进 memory.llm 供 tdai-core 按层读取。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadGatewayConfig } from "./config.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gwconfig-layers-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const YAML = `
llm:
  baseUrl: "https://api.example.com/v1"
  apiKey: "sk-test"
  model: "global-model"
  maxConcurrency: 4
  callDeadlineMs: 360000
  layers:
    l1:
      model: "l1-model"
      maxTokens: 32768
      disableThinking: true
    l2:
      timeoutMs: 600000
      callDeadlineMs: 660000
      disableThinking: false
`;

function loadWithYaml(text: string) {
  const file = join(tmp, "gw.yaml");
  writeFileSync(file, text, "utf-8");
  vi.stubEnv("TDAI_GATEWAY_CONFIG", file);
  return loadGatewayConfig();
}

describe("loadGatewayConfig：llm.layers 解析 + splice 透传", () => {
  it("l1 三字段解析（model/maxTokens/disableThinking）", () => {
    const cfg = loadWithYaml(YAML);
    expect(cfg.llm.layers?.l1).toEqual({
      model: "l1-model",
      maxTokens: 32768,
      disableThinking: true,
    });
  });

  it("l2 超时/硬期限覆盖 + disableThinking 显式 false 保留（三态不可丢）", () => {
    const cfg = loadWithYaml(YAML);
    expect(cfg.llm.layers?.l2).toEqual({
      timeoutMs: 600000,
      callDeadlineMs: 660000,
      disableThinking: false,
    });
  });

  it("未配置的层不产出键（l3 undefined）", () => {
    const cfg = loadWithYaml(YAML);
    expect(cfg.llm.layers?.l3).toBeUndefined();
  });

  it("全局 callDeadlineMs/maxConcurrency 解析（env 缺省时读 yaml）", () => {
    const cfg = loadWithYaml(YAML);
    expect(cfg.llm.callDeadlineMs).toBe(360000);
    expect(cfg.llm.maxConcurrency).toBe(4);
  });

  it("splice 进 memory.llm：layers + callDeadlineMs + maxConcurrency 不再丢（装配链教训）", () => {
    const cfg = loadWithYaml(YAML);
    expect(cfg.memory.llm.layers?.l1?.model).toBe("l1-model");
    expect(cfg.memory.llm.layers?.l2?.callDeadlineMs).toBe(660000);
    expect(cfg.memory.llm.callDeadlineMs).toBe(360000);
    expect(cfg.memory.llm.maxConcurrency).toBe(4);
  });

  it("无 layers 段 → 不产出 layers 键（向后兼容，老 yaml 行为不变）", () => {
    const cfg = loadWithYaml(
      `llm:\n  baseUrl: "https://api.example.com/v1"\n  apiKey: "sk-test"\n  model: "m"\n`,
    );
    expect(cfg.llm.layers).toBeUndefined();
    expect(cfg.memory.llm.layers).toBeUndefined();
  });
});
