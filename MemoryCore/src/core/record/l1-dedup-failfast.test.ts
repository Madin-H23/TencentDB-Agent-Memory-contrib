// P0-Fix1（2026-10-14，v2 S1 移植）：dedup 失败 fail-closed 开关测试。
// 背景（上游 #1640 / v2 26de073）：batchDedup 的 LLM 判定失败被内层 catch 吞掉→
// 返回「全部 store」决策→整批免检入库——这是 L1 库重复内容的主要新增源。
// dedupFailFast=true 时查重失败必须上抛（整批延后、游标不动），而不是免检入库。
// 边界 pin（v2 2026-10-12 拍板语义）：解析降级（LLM 返回乱文本→storeAll）是
// **有意保留**的语义，fail-fast 只覆盖「调用失败」不覆盖「解析降级」——解析降级
// 由 l1-dedup-fallback-silent WARN 锚点观测。
import { describe, expect, it } from "vitest";
import { batchDedup } from "./l1-dedup.js";
import type { IMemoryStore } from "../store/types.js";
import type { LLMRunner } from "../types.js";

const MEM = {
  record_id: "new-1",
  content: "用户要求AI执行ZCode每日备份任务时任何失败必须明示原因，不许静默处理",
  type: "instruction" as const,
  priority: 90,
  scene_name: "s",
  source_message_ids: [] as string[],
  metadata: {},
};

function makeStore(opts: { ftsResults: unknown[] }): IMemoryStore {
  return {
    countL1: async () => 2546,
    isFtsAvailable: () => true,
    searchL1Vector: async () => [],
    searchL1Fts: async () => opts.ftsResults,
  } as unknown as IMemoryStore;
}

const FTS_ROW = {
  record_id: "old-1",
  content: "用户要求AI执行ZCode每日备份任务时需实际核验备份结果（退出码、份数、文件齐全）",
  type: "instruction",
  priority: 90,
  scene_name: "s",
  metadata_json: "",
  timestamp_str: "2026-09-11T00:00:00Z",
  session_key: "k",
  session_id: "d",
};

const timeoutRunner = {
  run: async () => {
    throw new Error("The operation was aborted due to timeout");
  },
} as unknown as LLMRunner;

describe("batchDedup dedupFailFast（查重失败 fail-closed）", () => {
  it("开关开 + LLM 判定失败 → batchDedup 整体 reject（不再免检 store）", async () => {
    await expect(
      batchDedup({
        memories: [MEM],
        config: {},
        dedupFailFast: true,
        vectorStore: makeStore({ ftsResults: [FTS_ROW] }),
        llmRunner: timeoutRunner,
      }),
    ).rejects.toThrow(/aborted due to timeout/);
  });

  it("开关关（缺省）→ 保持既有行为：失败降级全 store 决策，不抛", async () => {
    const decisions = await batchDedup({
      memories: [MEM],
      config: {},
      vectorStore: makeStore({ ftsResults: [FTS_ROW] }),
      llmRunner: timeoutRunner,
    });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ record_id: "new-1", action: "store" });
  });

  it("解析降级边界 pin：开关开 + LLM 返回乱文本（parse 降级）→ 仍 storeAll 不抛", async () => {
    const garbage = { run: async () => "这不是 JSON 输出" } as unknown as LLMRunner;
    const decisions = await batchDedup({
      memories: [MEM],
      config: {},
      dedupFailFast: true,
      vectorStore: makeStore({ ftsResults: [FTS_ROW] }),
      llmRunner: garbage,
    });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ action: "store" });
  });

  it("timeoutMs 透传：dedupTimeoutMs=240000 时 LLM 调用必须带 timeoutMs=240000（默认 180000）", async () => {
    const seen: Array<number | undefined> = [];
    const spyRunner = {
      run: async (p: { timeoutMs?: number }) => {
        seen.push(p.timeoutMs);
        return JSON.stringify([{ record_id: "new-1", action: "store", target_ids: [] }]);
      },
    } as unknown as LLMRunner;
    const store = makeStore({ ftsResults: [FTS_ROW] });
    await batchDedup({ memories: [MEM], config: {}, timeoutMs: 240_000, vectorStore: store, llmRunner: spyRunner });
    expect(seen).toEqual([240_000]);
    seen.length = 0;
    await batchDedup({ memories: [MEM], config: {}, vectorStore: store, llmRunner: spyRunner });
    expect(seen).toEqual([180_000]);
  });
});
