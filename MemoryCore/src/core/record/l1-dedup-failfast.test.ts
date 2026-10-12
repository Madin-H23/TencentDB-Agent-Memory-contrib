// S1（2026-10-12）：dedup 失败 fail-fast 开关测试。
// 背景：batchDedup 的 LLM 判定失败被内层 catch 吞掉→返回「全部 store」决策→
// 整批免检入库（10-08 起 5 天 53 次，err 可查 "defaulting all to store"）——
// 这是 L1 库重复内容的主要新增源。dedupFailFast=true 时查重失败必须上抛
// （整批延后、游标不动），而不是免检入库。
// 边界 pin：parseBatchResult 的解析降级（LLM 返回乱文本→storeAll）是**有意保留**
// 的语义（2026-10-12 拍板），fail-fast 只覆盖「调用失败」不覆盖「解析降级」。
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { batchDedup } from "./l1-dedup.js";
import { isRateLimitError } from "../../utils/rate-limit-backoff.js";
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

const rateLimitRunner = {
  run: async () => {
    throw new Error("您的账户已达到速率限制，请您控制请求频率（访问量过大）");
  },
} as unknown as LLMRunner;

describe("batchDedup dedupFailFast（查重失败 fail-closed）", () => {
  it("开关开 + LLM 判定失败 → batchDedup 整体 reject（不再免检 store）", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "dedup-failfast-"));
    try {
      await expect(
        batchDedup({
          memories: [MEM],
          config: {},
          dedupFailFast: true,
          vectorStore: makeStore({ ftsResults: [FTS_ROW] }),
          llmRunner: timeoutRunner,
        }),
      ).rejects.toThrow(/aborted due to timeout/);
      // 失败路径不得有任何写入（免检入库被关闭）
      expect(existsSync(join(baseDir, "records"))).toBe(false);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("开关关（缺省）→ 保持既有行为：失败降级全 store 决策，不抛", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "dedup-failfast-off-"));
    try {
      const decisions = await batchDedup({
        memories: [MEM],
        config: {},
        vectorStore: makeStore({ ftsResults: [FTS_ROW] }),
        llmRunner: timeoutRunner,
      });
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ record_id: "new-1", action: "store" });
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("解析降级边界 pin：开关开 + LLM 返回乱文本（parse 降级）→ 仍 storeAll 不抛", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "dedup-failfast-parse-"));
    try {
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
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("抛出的 message 保留原始错误文本（限流文案可被 isRateLimitError 命中→2/4/6min 退避）", () => {
    const composed = `L1 dedup failed: ${"您的账户已达到速率限制，请您控制请求频率（访问量过大）"}`;
    expect(isRateLimitError(composed)).toBe(true);
  });
});
