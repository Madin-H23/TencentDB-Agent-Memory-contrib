// 票 origin#36 第三分票（QA·auto-recall 覆盖增强）：nativeBm25 能力面异常契约钉住。
// 审查 P3-2 记录：nativeBm25Search=true 时通道异常在 executeMemorySearch catch 内
// rethrow（auto-recall.ts:548）→ performAutoRecallInner 经 toRecallFailure 转成
// 结构化 RecallResult.error（普通 Error → code=90001/category=internal）；能力面
// off 时同异常走 return emptyResult 静默降级 undefined。两条不同的可观测契约
// 此前零测试钉住——第二分票只覆盖了 off 侧的降级 undefined。
import { describe, expect, it } from "vitest";
import { performAutoRecall, type RecallResult } from "./auto-recall.js";
import { RecallErrors } from "./recall-errors.js";
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

// 能力面 on 的 store：getCapabilities().nativeBm25Search=true
function makeBm25Store(over: {
  throwOnSearch?: boolean;
  thrown?: unknown;
  ftsResults?: L1FtsResult[];
}) {
  return {
    getCapabilities: () => ({ nativeBm25Search: true }),
    isFtsAvailable: () => true,
    searchL1Fts: async () => {
      if (over.thrown !== undefined) throw over.thrown;
      if (over.throwOnSearch) throw new Error("bm25 backend exploded");
      return over.ftsResults ?? [];
    },
    searchL1Vector: async () => [],
  } as unknown as IMemoryStore;
}

// 能力面 off 的 store（对照组）：nativeBm25Search=false
function makeOffStore(over: { throwOnSearch?: boolean }) {
  return {
    getCapabilities: () => ({ nativeBm25Search: false }),
    isFtsAvailable: () => true,
    searchL1Fts: async () => {
      if (over.throwOnSearch) throw new Error("bm25 backend exploded");
      return [];
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

function makeLogger(logs: string[]) {
  return {
    debug: (m: string) => logs.push(`D ${m}`),
    info: (m: string) => logs.push(`I ${m}`),
    warn: (m: string) => logs.push(`W ${m}`),
    error: (m: string) => logs.push(`E ${m}`),
  };
}

function baseParams(over: { store?: IMemoryStore; cfg?: unknown; logger?: never }) {
  return {
    userText: "测试召回问题",
    actorId: "default",
    sessionKey: "sess-bm25-contract",
    cfg: (over.cfg ?? makeCfg()) as never,
    pluginDataDir: mkdtempSync(join(tmpdir(), "bm25-contract-")),
    logger: undefined,
    vectorStore: over.store,
    embeddingService: undefined,
    storage: undefined,
  } as never;
}

describe("nativeBm25 能力面异常契约（origin#36 第三分票）", () => {
  it("on + 普通 Error 抛出 → 结构化 error code=90001/category=internal/retryable=false + 安全默认字段 + warn/error 日志", async () => {
    const logs: string[] = [];
    const store = makeBm25Store({ throwOnSearch: true });
    const params = baseParams({ store }) as Record<string, unknown>;
    params.logger = makeLogger(logs);
    const result = (await performAutoRecall(params as never)) as RecallResult;

    expect(result).toBeDefined();
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(90001);
    expect(result.error!.category).toBe("internal");
    expect(result.error!.retryable).toBe(false);
    expect(result.error!.message).toBe("Internal recall error"); // 安全消息：无路径/堆栈/凭据
    expect(result.prependContext).toBe(""); // 安全默认（下游不 NPE）
    expect(result.appendSystemContext).toBe("");
    expect(result.recalledL1Memories).toEqual([]);
    expect(result.recalledL3Persona).toBeNull();
    // 结构化 error 分支特有的两级日志（与 off 侧静默降级区分）
    expect(logs.some((l) => l.includes("recall failed: code=90001 category=internal"))).toBe(true);
    expect(logs.some((l) => l.includes("unexpected recall error cause"))).toBe(true);
  });

  it("on + 已分类 RecallFailure(dependencyTimeout 20001) → 透传 code=20001（不被 internal 二次包装）", async () => {
    const logs: string[] = [];
    const store = makeBm25Store({ thrown: RecallErrors.dependencyTimeout("bm25") });
    const params = baseParams({ store }) as Record<string, unknown>;
    params.logger = makeLogger(logs);
    const result = (await performAutoRecall(params as never)) as RecallResult;

    expect(result).toBeDefined();
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(20001); // toRecallFailure pass-through
    expect(result.error!.category).toBe("dependency");
    expect(result.error!.retryable).toBe(true);
    expect(logs.some((l) => l.includes("code=20001 category=dependency"))).toBe(true);
    // 已分类错误 cause 缺省 → 不打 internal cause 转储日志
    expect(logs.some((l) => l.includes("unexpected recall error cause"))).toBe(false);
  });

  it("on + 正常命中 → 走 native 分支返回格式化行+error undefined（与异常契约形成对照）", async () => {
    const store = makeBm25Store({
      ftsResults: [ftsHit("m_1794000000000_aaaa0001", 0.9, "native bm25 命中内容")],
    });
    const result = (await performAutoRecall(baseParams({ store }))) as RecallResult;
    expect(result).toBeDefined();
    expect(result.error).toBeUndefined();
    expect(result.prependContext).toContain("[fact|研究场景] native bm25 命中内容");
    expect(result.prependContext).toContain("<relevant-memories>");
  });

  it("对照组 off + 同异常 → undefined 降级（非结构化 error）——契约差异由能力面决定", async () => {
    const logs: string[] = [];
    const store = makeOffStore({ throwOnSearch: true });
    const params = baseParams({ store }) as Record<string, unknown>;
    params.logger = makeLogger(logs);
    const result = await performAutoRecall(params as never) as RecallResult | undefined;

    expect(result).toBeUndefined(); // 通道级吞错降级（第二分票已钉）
    expect(logs.some((l) => l.includes("metric=recall_channel_error"))).toBe(true);
    // off 侧不打结构化 error 的两级日志
    expect(logs.some((l) => l.includes("recall failed: code=90001"))).toBe(false);
  });
});
