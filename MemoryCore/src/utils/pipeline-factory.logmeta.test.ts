// P2（2026-10-14，v2 c00899f/6415c8e 移植）：L1 完成日志归属——完成行带
// model（cfg.extraction.model → cfg.llm.model 回退）与 sids=[分组 sid 列表]，
// 面板/日志可据此定位调用方与切片归属。
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createL1Runner } from "./pipeline-factory.js";
import type { LLMRunner, Logger } from "../core/types.js";

const T0 = 1_700_000_000_000;
const SESSION_KEY = "zcode-default";

function appendL0(baseDir: string, sessionId: string, id: string, content: string, recordedAtMs: number) {
  const convDir = join(baseDir, "conversations");
  mkdirSync(convDir, { recursive: true });
  const line = JSON.stringify({
    sessionKey: SESSION_KEY, sessionId, userId: "default", agentId: "default",
    recordedAt: new Date(recordedAtMs).toISOString(), id, role: "user", content, timestamp: recordedAtMs,
  });
  const date = new Date(recordedAtMs).toISOString().slice(0, 10);
  writeFileSync(join(convDir, `${date}.jsonl`), line + "\n", { flag: "a", encoding: "utf-8" });
}

function makeRunner(baseDir: string, infoLogs: string[], cfgExtra: Record<string, unknown>) {
  const fake: LLMRunner = {
    run: async () =>
      JSON.stringify([
        { scene_name: "场景", message_ids: ["m"], memories: [{ type: "episodic", content: "事实内容", priority: 50 }] },
      ]),
  } as unknown as LLMRunner;
  return createL1Runner({
    pluginDataDir: baseDir,
    // cfgExtra 摊在 cfg 根（model 进 extraction、llm 进根级 llm，与真实结构一致）
    cfg: {
      extraction: { enableDedup: false, maxMemoriesPerSession: 10, ...(cfgExtra.extraction ?? {}) },
      embedding: {},
      ...(cfgExtra.llm ? { llm: cfgExtra.llm } : {}),
    } as never,
    openclawConfig: undefined,
    vectorStore: undefined,
    embeddingService: undefined,
    logger: { debug: () => {}, info: (m: string) => infoLogs.push(m), warn: () => {}, error: () => {} } as unknown as Logger,
    llmRunner: fake,
  });
}

describe("L1 完成日志归属（model + sids）", () => {
  it("完成行带显式配置的 model 与全组 sid 列表", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l1runner-log-a-"));
    try {
      const infoLogs: string[] = [];
      appendL0(baseDir, "sess-A", "a1", "甲线内容", T0 + 100);
      appendL0(baseDir, "sess-B", "b1", "乙线内容", T0 + 200);
      await makeRunner(baseDir, infoLogs, { extraction: { model: "step-5-preview" } })({ sessionKey: SESSION_KEY });
      const line = infoLogs.find((m) => m.includes("L1 complete"))!;
      expect(line).toBeTruthy();
      expect(line).toContain("model=step-5-preview");
      expect(line).toContain("sids=[sess-A,sess-B]");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("无显式 model 时回退 cfg.llm.model，再回退 unknown", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l1runner-log-b-"));
    try {
      const infoLogs: string[] = [];
      appendL0(baseDir, "sess-A", "a1", "内容甲", T0 + 100);
      await makeRunner(baseDir, infoLogs, { llm: { model: "deepseek-v4.1-flash" } })({ sessionKey: SESSION_KEY });
      expect(infoLogs.find((m) => m.includes("L1 complete"))).toContain("model=deepseek-v4.1-flash");

      const infoLogs2: string[] = [];
      const baseDir2 = mkdtempSync(join(tmpdir(), "l1runner-log-c-"));
      try {
        appendL0(baseDir2, "sess-A", "a1", "内容乙", T0 + 100);
        await makeRunner(baseDir2, infoLogs2, {})({ sessionKey: SESSION_KEY });
        expect(infoLogs2.find((m) => m.includes("L1 complete"))).toContain("model=unknown");
      } finally {
        rmSync(baseDir2, { recursive: true, force: true });
      }
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
