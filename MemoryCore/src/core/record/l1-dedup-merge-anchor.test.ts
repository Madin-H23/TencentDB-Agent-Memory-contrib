// 票 11（2026-10-24）：线上误合观测锚点——L1 applyDecisions 对 merge/update 落库
// 打 INFO 锚点（l1-dedup-merge-decision），使「不该合的合了」（金标 60% 条件误合，
// D2 重复率观测盲区）可回溯；锚点即票 12 污染审计的增量数据源。
// 判定行为零变化：只加日志行（id/动作/长度，不打正文防 PII 进日志）。
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractL1Memories } from "./l1-extractor.js";
import type { IMemoryStore } from "../store/types.js";
import type { LLMRunner } from "../types.js";

const infoLines: string[] = [];
const logger = {
  info: (m: string) => infoLines.push(m),
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const T = 1_700_000_000_000;
const MESSAGES = [
  { id: "m1", role: "user" as const, content: "用户偏好把汇报写成结论先行再补细节", timestamp: T },
];
// 被合并的旧记录（候选召回返回它 → LLM 判 merge/update 指向它）
const TARGET_ROW = {
  record_id: "m_target_old",
  content: "汇报要结论先行",
  type: "instruction",
  priority: 80,
  scene_name: "",
  score: 0.9,
  timestamp_str: "",
  version: 0,
  session_key: "zcode-default",
};

function makeStore() {
  return {
    countL1: async () => 5,
    isFtsAvailable: () => true,
    searchL1Fts: async () => [TARGET_ROW],
    queryL1Records: async () => [{ record_id: TARGET_ROW.record_id, version: 0 }],
    deleteL1Batch: async () => {},
    upsertL1: async () => ({ record_id: "m_new" }),
  } as unknown as IMemoryStore;
}

function responseFor(action: string, newId: string) {
  const item: Record<string, unknown> = { record_id: newId, action, target_ids: ["m_target_old"] };
  if (action === "merge" || action === "update") item.merged_content = "汇报格式：结论先行再补细节（演进版）";
  return JSON.stringify([item]);
}

function run(action: string) {
  // 链路里 LLM 被调两次：①记忆抽取（scene+memories 格式）→ ②冲突判定（决策数组）。
  // 新记忆 record_id 由抽取器在判定前分配（m_<ts>_<hex>），判定 prompt 里才出现——
  // mock 从第二次调用的 prompt 动态抓取（候选 m_target_old 不匹配该格式）。
  let call = 0;
  const llm = {
    run: async (p: { prompt: string }) => {
      call++;
      if (call === 1) {
        return JSON.stringify([
          { scene_name: "汇报偏好", message_ids: ["m1"], memories: [{ type: "instruction", content: "用户偏好把汇报写成结论先行再补细节", priority: 80 }] },
        ]);
      }
      const idMatch = p.prompt.match(/m_\d+_[a-f0-9]+/);
      return responseFor(action, idMatch ? idMatch[0] : "unknown");
    },
  } as unknown as LLMRunner;
  const baseDir = mkdtempSync(join(tmpdir(), "t11-anchor-"));
  infoLines.length = 0;
  return extractL1Memories({
    messages: MESSAGES,
    sessionKey: "zcode-default",
    sessionId: "sess-t11",
    baseDir,
    config: {},
    logger,
    options: {
      enableDedup: true,
      promptMode: "chat",
      llmRunner: llm,
      dedupRecallRerank: "lexical",
      vectorStore: makeStore(),
    },
  }).finally(() => rmSync(baseDir, { recursive: true, force: true }));
}

describe("票11：l1-dedup-merge-decision 误合观测锚点（判定行为零变化）", () => {
  it("merge 决策落库 → INFO 锚点含 action=merge 与 targets（整形断言防内容泄漏回归）", async () => {
    const r = await run("merge");
    expect(r.success).toBe(true);
    const hit = infoLines.find((l) => l.includes("l1-dedup-merge-decision"));
    expect(hit).toBeTruthy();
    // 整形断言（审查 P2-1）：锚点只允许 id/动作/长度字段——未来任何内容字段泄漏即红
    expect(hit).toMatch(
      /l1-dedup-merge-decision record=\S+ action=merge targets=\S+ contentLen=\d+ sessionKey=zcode-default sessionId=sess-t11 model=\(default\) — 合并\/更新决策落库（误合观测锚点）$/,
    );
    expect(hit).not.toContain("用户偏好"); // 新记忆正文
    expect(hit).not.toContain("汇报格式"); // merged_content
    expect(hit).not.toContain("汇报要结论先行"); // 目标正文
  });

  it("update 决策落库 → 同锚点 action=update", async () => {
    const r = await run("update");
    expect(r.success).toBe(true);
    const hit = infoLines.find((l) => l.includes("l1-dedup-merge-decision"));
    expect(hit).toBeTruthy();
    expect(hit).toContain("action=update");
  });

  it("targets 为空数组 → 锚点打 (none)（审查 P2-2 分支覆盖）", async () => {
    let call = 0;
    const llm = {
      run: async (p: { prompt: string }) => {
        call++;
        if (call === 1) {
          return JSON.stringify([
            { scene_name: "汇报偏好", message_ids: ["m1"], memories: [{ type: "instruction", content: "用户偏好把汇报写成结论先行再补细节", priority: 80 }] },
          ]);
        }
        const idMatch = p.prompt.match(/m_\d+_[a-f0-9]+/);
        return JSON.stringify([{ record_id: idMatch ? idMatch[0] : "unknown", action: "merge", target_ids: [], merged_content: "x" }]);
      },
    } as unknown as LLMRunner;
    const baseDir = mkdtempSync(join(tmpdir(), "t11-anchor-empty-"));
    infoLines.length = 0;
    try {
      const r = await extractL1Memories({
        messages: MESSAGES, sessionKey: "zcode-default", sessionId: "sess-t11e", baseDir, config: {}, logger,
        options: { enableDedup: true, promptMode: "chat", llmRunner: llm, dedupRecallRerank: "lexical", vectorStore: makeStore() },
      });
      expect(r.success).toBe(true);
      const hit = infoLines.find((l) => l.includes("l1-dedup-merge-decision"));
      expect(hit).toBeTruthy();
      expect(hit).toContain("targets=(none)");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("store 决策 → 不打该锚点（量由 extracted/stored 总数覆盖）", async () => {
    const r = await run("store");
    expect(r.success).toBe(true);
    expect(infoLines.find((l) => l.includes("l1-dedup-merge-decision"))).toBeUndefined();
  });
});
