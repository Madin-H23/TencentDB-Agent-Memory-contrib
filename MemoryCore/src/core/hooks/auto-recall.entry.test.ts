// 票 origin#36 第二分票（QA·auto-recall 覆盖增强）：入口降级路径+契约钉住。
// performAutoRecall 是每轮对话召回入口——H-15 超时归一化（code 20001）+异常结构化
// （不炸对话）+空结果 undefined——三条路径此前零测试钉住（故障语义=用户感受面）。
// 钉行为跑通=回归防护；失败=真缺陷修复。
import { describe, expect, it } from "vitest";
import { performAutoRecall, type RecallResult } from "./auto-recall.js";
import type { IMemoryStore, L1FtsResult } from "../store/types.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeCfg(timeoutMs = 5_000) {
  return {
    recall: {
      enabled: true,
      timeoutMs,
      strategy: "keyword",
      maxResults: 5,
      scoreThreshold: 0.1,
      maxCharsPerMemory: 400,
      maxTotalRecallChars: 4_000,
    },
  } as never;
}

function makeStore(over: {
  fts?: boolean;
  ftsResults?: L1FtsResult[];
  hang?: boolean;
  throwOnSearch?: boolean;
}) {
  return {
    isFtsAvailable: () => over.fts ?? true,
    searchL1Fts: async () => {
      if (over.throwOnSearch) throw new Error("fts backend exploded");
      if (over.hang) return new Promise(() => {}); // 永挂
      return over.ftsResults ?? [];
    },
    searchL1Vector: async () => [],
  } as unknown as IMemoryStore;
}

function ftsHit(id: string, score: number, content: string): L1FtsResult {
  return {
    record_id: id,
    score,
    content,
    type: "fact",
    scene_name: "研究场景",
    timestamp_str: "2026-11-16T20:30:00.000Z",
    metadata_json: "{}",
  } as unknown as L1FtsResult;
}

function baseParams(over: { store?: IMemoryStore; cfg?: unknown; logger?: never }) {
  return {
    userText: "测试召回问题",
    actorId: "default",
    sessionKey: "sess-recall-test",
    cfg: (over.cfg ?? makeCfg()) as never,
    pluginDataDir: mkdtempSync(join(tmpdir(), "recall-test-")), // 空目录=persona/scene 读空·降级
    logger: undefined,
    vectorStore: over.store,
    embeddingService: undefined,
    storage: undefined,
  } as never;
}

describe("performAutoRecall 入口契约：降级路径（origin#36 第二分票）", () => {
  it("超时路径：search 永挂+timeoutMs=20 → RecallResult.error.code=20001+安全默认字段", async () => {
    const store = makeStore({ hang: true });
    const result = (await performAutoRecall(baseParams({ store, cfg: makeCfg(20) }))) as RecallResult;
    expect(result).toBeDefined();
    expect(result!.error?.code).toBe(20001); // dependencyTimeout
    expect(result!.prependContext).toBe(""); // 安全默认（下游不 NPE）
    expect(result!.recalledL1Memories).toEqual([]);
    expect(result!.recalledL3Persona).toBeNull();
  });

  it("异常路径：store 抛错 → 通道级降级 undefined（不 throw 不炸对话·降级语义钉住）+metric 行可观测", async () => {
    const logs: string[] = [];
    const logger = {
      debug: (m: string) => logs.push(`D ${m}`),
      info: (m: string) => logs.push(`I ${m}`),
      warn: (m: string) => logs.push(`W ${m}`),
      error: (m: string) => logs.push(`E ${m}`),
    };
    const store = makeStore({ throwOnSearch: true });
    const params = baseParams({ store }) as Record<string, unknown>;
    params.logger = logger; // 捕获 metric 行（baseParams 缺省 undefined logger）
    const result = await performAutoRecall(params as never) as RecallResult | undefined;
    expect(result).toBeUndefined(); // 通道级吞错降级（设计语义：不炸对话）
    expect(logs.some((l) => l.includes("Memory search failed"))).toBe(true);
    // [origin#36 第二分票增强] 降级可观测：metric=recall_channel_error 行（零行为改动）
    expect(logs.some((l) => l.includes("metric=recall_channel_error"))).toBe(true);
  });

  it("空结果路径：FTS 无命中 → undefined（无内容可注入）", async () => {
    const store = makeStore({ ftsResults: [] });
    const result = await performAutoRecall(baseParams({ store }));
    expect(result).toBeUndefined();
  });

  it("成功路径：FTS 命中 → prependContext 含格式化行+recalledL1Memories+error undefined", async () => {
    const store = makeStore({
      ftsResults: [ftsHit("m_1794000000000_aaaa0001", 0.9, "冷事实内容"), ftsHit("m_1794000000001_bbbb0002", 0.8, "另一条")],
    });
    const result = (await performAutoRecall(baseParams({ store }))) as RecallResult;
    expect(result).toBeDefined();
    expect(result!.error).toBeUndefined(); // 成功路径零 error
    // 格式化行不含锚点 id（formatMemoryLine 输出 type/content/时间——id 不进上下文）
    expect(result!.prependContext).toContain("[fact|研究场景] 冷事实内容");
    expect(result!.prependContext).toContain("<relevant-memories>"); // 包裹信封
    expect(result!.recalledL1Memories!.length).toBe(2);
  });
});
