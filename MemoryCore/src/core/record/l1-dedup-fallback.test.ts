// 去重候选召回的降级回归（2026-09-29 治理第 1 步）。
//
// 生产事故形态：embedding.provider=none 时向量表 l1_vec 从未写入（0 行），但
// batchDedup 的 hasVectorData 判定用的是 countL1()（统计 l1_records，恒 >0），
// 于是只要 embeddingService 存在就走 Tier 1 向量召回——查空表得 0 候选——
// 判定「无相似记录」全部 store。FTS Tier 2 从未被执行（网关日志：vector
// recall 446 次 / FTS recall 0 次，update/merge/skip 恒为 0）。
//
// 修复语义：Tier 1 候选全空时降级 Tier 2 FTS 重召一次；两条路都空才 storeAll。
// 这对「向量表有数据」的正常部署无损（Tier 1 空即真无相似，FTS 兜底多查一次），
// 对 provider=none 的部署则恢复整条去重链路。
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

/** countL1 报告 l1_records 行数（>0，生产 2546），searchL1Vector 模拟空向量表。 */
function makeStore(opts: { vecResults: unknown[]; ftsResults: unknown[] }): IMemoryStore {
  return {
    countL1: async () => 2546,
    isFtsAvailable: () => true,
    searchL1Vector: async () => opts.vecResults,
    searchL1Fts: async () => opts.ftsResults,
  } as unknown as IMemoryStore;
}

const noopEmbedding = { embedBatch: async () => [[0.1, 0.2]] } as never;

const judgeRunner = {
  run: async () =>
    JSON.stringify([{ record_id: "new-1", action: "update", target_ids: ["old-1"], merged_content: "合并后的备份纪律" }]),
} as unknown as LLMRunner;

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

describe("batchDedup：Tier1 向量召回空结果时降级 Tier2 FTS", () => {
  it("向量表空但 FTS 可召回相似记录 → 走 LLM 判定而不是全部 store", async () => {
    const decisions = await batchDedup({
      memories: [MEM],
      config: {},
      vectorStore: makeStore({ vecResults: [], ftsResults: [FTS_ROW] }),
      embeddingService: noopEmbedding,
      llmRunner: judgeRunner,
    });
    const d = decisions.find((x) => x.record_id === "new-1");
    expect(d?.action, "FTS 有候选时必须交给 LLM 判定（修复前恒为 store）").toBe("update");
  });

  it("向量与 FTS 都无候选 → 保持全部 store（真无相似不受降级影响）", async () => {
    const decisions = await batchDedup({
      memories: [MEM],
      config: {},
      vectorStore: makeStore({ vecResults: [], ftsResults: [] }),
      embeddingService: noopEmbedding,
      llmRunner: judgeRunner,
    });
    expect(decisions.every((x) => x.action === "store")).toBe(true);
  });

  it("降级时 FTS 候选会过滤掉本批自身（不与自己判冲突）", async () => {
    // FTS 返回里混入本批 record_id —— findCandidatesByFts 的 self-batch 过滤必须仍然生效
    const decisions = await batchDedup({
      memories: [MEM],
      config: {},
      vectorStore: makeStore({ vecResults: [], ftsResults: [{ ...FTS_ROW, record_id: "new-1" }] }),
      embeddingService: noopEmbedding,
      llmRunner: judgeRunner,
    });
    expect(decisions.every((x) => x.action === "store")).toBe(true);
  });
});
