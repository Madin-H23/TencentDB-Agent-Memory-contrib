// D2（2026-10-14，v2 4db48bf 移植）：召回重排纯函数 + batchDedup lexical 模式集成。
import { describe, it, expect } from "vitest";
import {
  normalizeForFingerprint,
  fingerprintOf,
  rerankCandidatesBySimilarity,
} from "./l1-recall-rerank.js";
import { batchDedup } from "./l1-dedup.js";
import type { IMemoryStore } from "../store/types.js";
import type { LLMRunner } from "../types.js";

describe("rerankCandidatesBySimilarity：词汇重排", () => {
  it("被 BM25 序挤出的真重复（排第 6）被捞回 top-1", () => {
    const newMem = "用户决定 TDAI 网关 v3 迁移采用灰度方式切换";
    // 前 5 名=无关内容（FTS 序），真重复在第 6
    const candidates = Array.from({ length: 5 }, (_, i) => ({
      id: `noise-${i}`,
      content: `用户讨论了完全不同的主题编号${i}，涉及部署与监控平台的细节安排`,
    }));
    candidates.push({ id: "true-dup", content: "用户决定 TDAI 网关 v3 迁移使用灰度方式 切换" });
    const top = rerankCandidatesBySimilarity(newMem, candidates, 5);
    expect(top[0]!.id).toBe("true-dup");
  });

  it("同分保持原序（稳定排序）、topK 截断生效", () => {
    const candidates = [
      { id: "a", content: "完全相同的内容文本" },
      { id: "b", content: "完全相同的内容文本" },
      { id: "c", content: "另一个话题" },
    ];
    const top = rerankCandidatesBySimilarity("完全相同的内容文本", candidates, 2);
    expect(top.map((c) => c.id)).toEqual(["a", "b"]);
    expect(top).toHaveLength(2);
  });
});

describe("指纹归一化", () => {
  it("去空白与中英文标点后 sha1；同文不同标点同指纹", () => {
    expect(fingerprintOf("用户 决定：上线！")).toBe(fingerprintOf("用户决定上线"));
    expect(fingerprintOf("")).toBeNull();
    expect(fingerprintOf("，。！？")).toBeNull();
    expect(normalizeForFingerprint("a，b。c")).toBe("abc");
  });
});

describe("batchDedup lexical 模式集成", () => {
  const MEM = {
    record_id: "new-1",
    content: "用户决定 TDAI 网关 v3 迁移采用灰度方式切换",
    type: "episodic" as const,
    priority: 80,
    scene_name: "s",
    source_message_ids: [] as string[],
    metadata: {},
  };
  const okRunner = {
    run: async () => JSON.stringify([{ record_id: "new-1", action: "merge", target_ids: ["true-dup"], merged_content: "x" }]),
  } as unknown as LLMRunner;

  function makeStore(opts: { capturedLimits: number[]; rows: unknown[] }): IMemoryStore {
    return {
      countL1: async () => 100,
      isFtsAvailable: () => true,
      searchL1Vector: async () => [],
      searchL1Fts: async (_q: string, limit?: number) => {
        opts.capturedLimits.push(limit ?? -1);
        return opts.rows as never;
      },
    } as unknown as IMemoryStore;
  }

  it("lexical：超额召回（limit≥50）且真重复（第 6 名）进入判定候选", async () => {
    const captured: number[] = [];
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => ({
        record_id: `noise-${i}`, content: `用户讨论了完全不同的主题编号${i}，涉及部署与监控平台细节`,
        type: "episodic", priority: 80, scene_name: "", metadata_json: "", timestamp_str: "", session_key: "k", session_id: "d",
      })),
      { record_id: "true-dup", content: "用户决定 TDAI 网关 v3 迁移使用灰度方式 切换", type: "episodic", priority: 80, scene_name: "", metadata_json: "", timestamp_str: "", session_key: "k", session_id: "d" },
    ];
    const decisions = await batchDedup({
      memories: [MEM], config: {}, logger: undefined, promptMode: "chat",
      llmRunner: okRunner, dedupFailFast: true,
      dedupRecallRerank: "lexical", conflictRecallTopK: 5,
      vectorStore: makeStore({ capturedLimits: captured, rows }),
    });
    expect(captured.every((l) => l >= 50)).toBe(true); // 超额召回生效
    expect(decisions[0]).toMatchObject({ action: "merge", target_ids: ["true-dup"] }); // 真重复进判定
  });

  it("none：旧行为（limit≤10，仅召回序头部进候选）", async () => {
    const captured: number[] = [];
    const rows = Array.from({ length: 8 }, (_, i) => ({
      record_id: `r-${i}`, content: `第${i}条：用户讨论了部署与监控平台等无关主题的细节`,
      type: "episodic", priority: 80, scene_name: "", metadata_json: "", timestamp_str: "", session_key: "k", session_id: "d",
    }));
    await batchDedup({
      memories: [MEM], config: {}, promptMode: "chat",
      llmRunner: okRunner, dedupRecallRerank: "none", conflictRecallTopK: 5,
      vectorStore: makeStore({ capturedLimits: captured, rows }),
    });
    expect(captured.every((l) => l <= 10)).toBe(true);
  });
});
