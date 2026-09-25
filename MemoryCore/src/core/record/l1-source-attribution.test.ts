// Source-attribution guard: memories whose sources are all assistant-authored
// are not stored (2026-09-25).
//
// Why: the extraction prompt already tells the model not to extract the
// assistant's own behaviour/output, but in production that rule did not stop the
// model from restating the assistant's work as a user fact — e.g. "the user fixed
// the coverage-rerank boundary defect" or "the user asked to restart gateway
// process PID 6388" (that PID was already stale, so recalling it gives wrong
// operational guidance).
//
// A source-traceability check does not catch these: their words genuinely come
// from the source messages. What is missing is *whose* statements they were.
//
// Rule: every id in source_message_ids is an assistant message → no user
// grounding → drop. Mixed sources are kept on purpose, because that is the
// "user corrected it, assistant stated the final conclusion" case from #706/#778.
// Empty and unknown ids are kept: the guard only acts on positively-known
// assistant-only sourcing, it never guesses.
import { describe, expect, it } from "vitest";
import { extractL1Memories } from "./l1-extractor.js";
import type { LLMRunner, Logger } from "../types.js";

const T = 1_700_000_000_000;

const MESSAGES = [
  { id: "u1", role: "user" as const, content: "Please keep digging into the recall ordering issue.", timestamp: T },
  { id: "a1", role: "assistant" as const, content: "Found it: the per-token scan was capped at 200 rows, so a saturated token must skip re-ranking. Shipped in 99098df.", timestamp: T + 1 },
  { id: "a2", role: "assistant" as const, content: "Also, you had asked to restart gateway PID 6388 earlier; that is done and the pipeline is idle.", timestamp: T + 2 },
  { id: "u2", role: "user" as const, content: "Good. From now on, attach the opening-prompt path whenever you hand off.", timestamp: T + 3 },
];

function runnerReturning(text: string): LLMRunner {
  return { run: async () => text } as unknown as LLMRunner;
}

function scene(memories: Array<{ content: string; src: string[]; type?: string }>) {
  return JSON.stringify([
    {
      scene_name: "我（AI）在协助排查召回排序问题",
      message_ids: ["u1", "a1", "a2", "u2"],
      memories: memories.map((m) => ({
        content: m.content,
        type: m.type ?? "episodic",
        priority: 70,
        source_message_ids: m.src,
      })),
    },
  ]);
}

async function extract(memories: Array<{ content: string; src: string[]; type?: string }>, logger?: Logger) {
  return extractL1Memories({
    messages: MESSAGES,
    sessionKey: "source-attribution-test",
    baseDir: "/tmp/l1-source-attribution-test",
    config: {},
    logger,
    options: { enableDedup: false, promptMode: "chat", llmRunner: runnerReturning(scene(memories)) },
  });
}

describe("source-attribution guard: assistant-only sources are dropped", () => {
  it("drops a memory whose every source is an assistant message", async () => {
    const res = await extract([
      { content: "用户修复了覆盖度重排的边界缺陷，原实现每个词只扫 200 条。", src: ["a1"] },
    ]);
    expect(res.extractedCount).toBe(0);
    expect(res.records).toHaveLength(0);
  });

  it("drops it when several assistant messages are cited", async () => {
    const res = await extract([{ content: "用户要求重启网关进程 PID 6388。", src: ["a1", "a2"] }]);
    expect(res.extractedCount).toBe(0);
  });

  it("keeps a memory with mixed sources (user correction + assistant conclusion, #706/#778)", async () => {
    const res = await extract([
      { content: "用户纠正了召回排序口径后，结论改为覆盖度优先。", src: ["u1", "a1"] },
    ]);
    expect(res.extractedCount).toBe(1);
    expect(res.records[0].content).toContain("覆盖度优先");
  });

  it("keeps a user-only memory (normal path unaffected)", async () => {
    const res = await extract([{ content: "用户要求以后 handoff 附开场提示词。", src: ["u2"], type: "instruction" }]);
    expect(res.extractedCount).toBe(1);
  });

  it("keeps memories with no source ids (never drops on absence of evidence)", async () => {
    const res = await extract([{ content: "用户偏好结论先行。", src: [] }]);
    expect(res.extractedCount).toBe(1);
  });

  it("keeps memories citing ids that are not in this batch (unknown ≠ assistant)", async () => {
    const res = await extract([{ content: "用户提出过某项要求。", src: ["ghost-1"] }]);
    expect(res.extractedCount).toBe(1);
  });

  it("keeps a memory when only some sources are unknown (not a proven assistant-only case)", async () => {
    const res = await extract([{ content: "用户确认了某项结论。", src: ["ghost-1", "a1"] }]);
    expect(res.extractedCount).toBe(1);
  });

  it("leaves an auditable anchor when dropping (what was dropped, and on what evidence)", async () => {
    const infos: string[] = [];
    const logger = { info: (m: string) => infos.push(m), warn: () => {}, debug: () => {}, error: () => {} } as unknown as Logger;
    await extract([{ content: "用户修复了某个缺陷。", src: ["a1"] }], logger);
    expect(infos.some((m) => m.includes("source-attribution") && m.includes("a1"))).toBe(true);
  });
});
