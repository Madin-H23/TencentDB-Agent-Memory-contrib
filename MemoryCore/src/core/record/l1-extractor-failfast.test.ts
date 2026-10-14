// P0-Fix1/Fix2（2026-10-14，v2 S1/#1395 语义移植）：extractor 层失败传播。
// vi.mock 拦截 batchDedup 断言参数透传（dedupFailFast/dedupTimeoutMs）与
// dedup 失败 → 整批延后（抛 L1ExtractionFailure reason="dedup_failed"），
// 而不是免检 storeAllDirectly。
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const captured: Array<Record<string, unknown>> = [];

vi.mock("./l1-dedup.js", () => ({
  batchDedup: async (params: Record<string, unknown>) => {
    captured.push(params);
    if (params.dedupFailFast) {
      throw new Error("The operation was aborted due to timeout");
    }
    return params.memories.map((m: { record_id: string }) => ({
      record_id: m.record_id,
      action: "store" as const,
      target_ids: [],
    }));
  },
}));

import { extractL1Memories, L1ExtractionFailure } from "./l1-extractor.js";
import type { LLMRunner } from "../types.js";

const T = 1_700_000_000_000;
const MESSAGES = [
  { id: "m1", role: "user" as const, content: "dedup 失败传播验证：查重失败必须整批延后而不是免检入库。", timestamp: T },
];
const RESPONSE = JSON.stringify([
  { scene_name: "传播验证场景", message_ids: ["m1"], memories: [{ type: "episodic", content: "验证事实内容", priority: 50 }] },
]);

function run(opts: { dedupFailFast?: boolean; dedupTimeoutMs?: number }) {
  const llm = { run: async () => RESPONSE } as unknown as LLMRunner;
  const baseDir = mkdtempSync(join(tmpdir(), "extractor-failfast-"));
  return extractL1Memories({
    messages: MESSAGES,
    sessionKey: "zcode-default",
    sessionId: "sess-ff",
    baseDir,
    config: {},
    options: {
      enableDedup: true,
      promptMode: "chat",
      llmRunner: llm,
      dedupFailFast: opts.dedupFailFast,
      dedupTimeoutMs: opts.dedupTimeoutMs,
    },
  }).finally(() => rmSync(baseDir, { recursive: true, force: true }));
}

describe("extractL1Memories：dedup 失败传播与参数透传", () => {
  it("dedupFailFast 开 + batchDedup reject → 整批抛 L1ExtractionFailure(dedup_failed)", async () => {
    captured.length = 0;
    await expect(run({ dedupFailFast: true, dedupTimeoutMs: 120_000 })).rejects.toBeInstanceOf(L1ExtractionFailure);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ dedupFailFast: true, timeoutMs: 120_000 });
  });

  it("失败异常带 reason=dedup_failed 且 message 保留原始错误文本", async () => {
    captured.length = 0;
    await expect(run({ dedupFailFast: true })).rejects.toMatchObject({
      reason: "dedup_failed",
      message: expect.stringContaining("aborted due to timeout"),
    });
  });

  it("开关关 → dedup 内部已降级为全 store 决策，extractor 正常入库不抛", async () => {
    captured.length = 0;
    const r = await run({});
    expect(r.success).toBe(true);
    expect(r.storedCount).toBe(1);
  });
});
