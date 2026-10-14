// P0-Fix2（2026-10-14，v2 c32bc6b / 上游 #1395 语义移植）：L1 抽取失败 ≠ 合法空产出。
// v3 现状（红）：LLM 调用失败被 catch 后返回 success:false（组循环不检查→游标照推）；
// 结构垃圾响应（no_json/not_array）被当「合法 0 产出」返回 success:true → 游标照推。
// 目标（绿）：LLM 调用失败 → 抛 L1ExtractionFailure("llm_error")；结构垃圾 → 抛
// L1ExtractionFailure("parse_error")；合法空（LLM 正常返回空场景数组）→ 照常
// success:true 0 产出。enableDedup:false 走纯抽取路径（不经 batchDedup）。
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractL1Memories, L1ExtractionFailure } from "./l1-extractor.js";
import type { LLMRunner } from "../types.js";

const T = 1_700_000_000_000;
const MESSAGES = [
  { id: "m1", role: "user" as const, content: "游标语义验证：抽取失败必须延后重试而不是推进游标跳过内容。", timestamp: T },
];

function run(llm: LLMRunner) {
  const baseDir = mkdtempSync(join(tmpdir(), "extractor-cursor-"));
  return extractL1Memories({
    messages: MESSAGES,
    sessionKey: "zcode-default",
    sessionId: "sess-cursor",
    baseDir,
    config: {},
    options: { enableDedup: false, promptMode: "chat", llmRunner: llm },
  }).finally(() => rmSync(baseDir, { recursive: true, force: true }));
}

describe("extractL1Memories：失败不冒充空产出（#1395 语义）", () => {
  it("LLM 调用失败 → 抛 L1ExtractionFailure(reason=llm_error)，不返回 success:false", async () => {
    const failing = { run: async () => { throw new Error("fetch failed: 401 Unauthorized"); } } as unknown as LLMRunner;
    await expect(run(failing)).rejects.toMatchObject({ reason: "llm_error" });
  });

  it("LLM 调用超时 → 抛 L1ExtractionFailure(reason=llm_error)", async () => {
    const timing = { run: async () => { throw new Error("The operation was aborted due to timeout"); } } as unknown as LLMRunner;
    await expect(run(timing)).rejects.toBeInstanceOf(L1ExtractionFailure);
  });

  it("结构垃圾响应（无 JSON 数组）→ 抛 L1ExtractionFailure(reason=parse_error)，不当合法空产出", async () => {
    const garbage = { run: async () => "抱歉，我无法处理这个请求。" } as unknown as LLMRunner;
    await expect(run(garbage)).rejects.toMatchObject({ reason: "parse_error" });
  });

  it("JSON.parse 语法错误（修复器救不活）→ 抛 L1ExtractionFailure(reason=parse_error)", async () => {
    // 注意：裸 priority/尾逗号会被 repairExtractionJson 修复（v3 弹性设计，
    // resolve 属正常）——用「两对象间缺逗号」确保修复器不沾、真抛 SyntaxError。
    const broken = { run: async () => '[{"a":1} {"b":2}]' } as unknown as LLMRunner;
    await expect(run(broken)).rejects.toMatchObject({ reason: "parse_error" });
  });

  it("合法空产出 pin：LLM 正常返回空场景数组 → success:true 0 产出（不得误伤）", async () => {
    const empty = { run: async () => "[]" } as unknown as LLMRunner;
    const r = await run(empty);
    expect(r.success).toBe(true);
    expect(r.extractedCount).toBe(0);
    expect(r.storedCount).toBe(0);
  });

  it("合法零记忆场景 pin：场景有但记忆为空 → success:true 0 产出", async () => {
    const noMem = { run: async () => JSON.stringify([{ scene_name: "闲聊场景", message_ids: ["m1"], memories: [] }]) } as unknown as LLMRunner;
    const r = await run(noMem);
    expect(r.success).toBe(true);
    expect(r.extractedCount).toBe(0);
  });
});
