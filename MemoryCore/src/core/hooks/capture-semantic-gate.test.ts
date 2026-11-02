// 票④b（exp/p1-4b-semantic-gate）：捕获语义门纯模块测试。
// 覆盖 SPEC §9：配置解析/阈值边界/动作白名单/伪记忆字段/fail-open 全矩阵/
// key 不进日志/长度守卫与批上限/中文与 emoji 码点/空批/并发隔离。
import { describe, it, expect, vi } from "vitest";
import {
  CAPTURE_SEMANTIC_GATE_DEFAULTS,
  evaluateSemanticGate,
  parseSemanticGateConfig,
  toPseudoMemory,
  type SemanticGateDeps,
  type SemanticGateMessage,
} from "./capture-semantic-gate.js";
import type { L1SearchResult, IMemoryStore, StoreCapabilities } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { LLMRunner } from "../types.js";

// ── Test doubles ─────────────────────────────────────────────

function hit(recordId: string, score: number, content = `cand-${recordId}`): L1SearchResult {
  return {
    record_id: recordId,
    content,
    type: "episodic",
    priority: 50,
    scene_name: "scene",
    score,
    timestamp_str: "2026-11-01T00:00:00.000Z",
    timestamp_start: "",
    timestamp_end: "",
    version: 1,
    session_key: "sess",
    session_id: "sid",
    team_id: "default",
    task_id: "default",
    user_id: "default",
    agent_id: "default",
    metadata_json: "{}",
  };
}

function makeEmbedding(opts: {
  dims?: number;
  impl?: (texts: string[]) => Promise<Float32Array[]>;
} = {}): EmbeddingService {
  const dims = opts.dims ?? 4;
  return {
    embed: vi.fn(async () => new Float32Array(dims)),
    embedBatch: vi.fn(async (texts: string[]) =>
      opts.impl ? opts.impl(texts) : texts.map(() => new Float32Array(dims)),
    ),
    getDimensions: () => dims,
    getProviderInfo: () => ({ provider: "mock", model: "mock" }),
    isReady: () => true,
    startWarmup: () => {},
  } as unknown as EmbeddingService;
}

const CAPS_VECTOR_OK: StoreCapabilities = {
  vectorSearch: true,
  ftsSearch: true,
  nativeHybridSearch: false,
  sparseVectors: false,
  profileRows: true,
};

function makeStore(opts: {
  hits?: L1SearchResult[] | ((query: Float32Array, topK: number) => L1SearchResult[]);
  caps?: Partial<StoreCapabilities>;
  searchImpl?: () => Promise<L1SearchResult[]>;
} = {}): IMemoryStore {
  const caps = { ...CAPS_VECTOR_OK, ...(opts.caps ?? {}) };
  return {
    getCapabilities: () => caps,
    searchL1Vector: vi.fn(async (q: Float32Array, topK: number) => {
      if (opts.searchImpl) return opts.searchImpl();
      if (typeof opts.hits === "function") return opts.hits(q, topK);
      return opts.hits ?? [];
    }),
    countL1: vi.fn(async () => 1),
    isFtsAvailable: () => true,
  } as unknown as IMemoryStore;
}

function makeJudge(impl?: (params: { prompt: string; systemPrompt?: string }) => Promise<string>): LLMRunner {
  return {
    run: vi.fn(async (params: { prompt: string; systemPrompt?: string }) =>
      impl ? impl(params) : "[]",
    ),
  } as unknown as LLMRunner;
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function deps(over: Partial<SemanticGateDeps> & { embeddingService: EmbeddingService; vectorStore: IMemoryStore; judge: LLMRunner }): SemanticGateDeps {
  return {
    mode: "on",
    threshold: 0.78,
    topK: 5,
    maxMessageChars: 2000,
    maxMessagesPerBatch: 5,
    judgeTimeoutMs: 500,
    embeddingTimeoutMs: 500,
    ...over,
  };
}

const MSG = (id: string, content: string): SemanticGateMessage => ({ id, content });

/** 判定返回一条 skip 决策。 */
const skipJson = (recordId: string) =>
  JSON.stringify([{ record_id: recordId, action: "skip", target_ids: ["r1"] }]);

// ── 配置解析 ─────────────────────────────────────────────────

describe("parseSemanticGateConfig（畸形值 throw，不静默回落）", () => {
  it("缺省/undefined/false → off + 默认参数", () => {
    expect(parseSemanticGateConfig(undefined)).toEqual(CAPTURE_SEMANTIC_GATE_DEFAULTS);
    expect(parseSemanticGateConfig(false)).toEqual(CAPTURE_SEMANTIC_GATE_DEFAULTS);
    expect(parseSemanticGateConfig({})).toEqual(CAPTURE_SEMANTIC_GATE_DEFAULTS);
    expect(CAPTURE_SEMANTIC_GATE_DEFAULTS.mode).toBe("off");
  });

  it("对象 → 校验合并（缺省字段回落默认值，非默认值生效）", () => {
    const cfg = parseSemanticGateConfig({
      mode: "shadow",
      threshold: 0.91,
      topK: 9,
      maxMessageChars: 321,
      maxMessagesPerBatch: 2,
      judgeTimeoutMs: 1234,
      embeddingTimeoutMs: 567,
    });
    expect(cfg).toEqual({
      mode: "shadow", threshold: 0.91, topK: 9, maxMessageChars: 321,
      maxMessagesPerBatch: 2, judgeTimeoutMs: 1234, embeddingTimeoutMs: 567,
    });
  });

  it("mode 非法 → throw", () => {
    expect(() => parseSemanticGateConfig({ mode: "ON" })).toThrow(/captureSemanticGate\.mode/);
    expect(() => parseSemanticGateConfig({ mode: true })).toThrow(/captureSemanticGate\.mode/);
  });

  it("threshold 边界 (0,1]：0/-0.1/1.1/NaN → throw；1 与极小正数接受", () => {
    expect(() => parseSemanticGateConfig({ threshold: 0 })).toThrow(/threshold/);
    expect(() => parseSemanticGateConfig({ threshold: -0.1 })).toThrow(/threshold/);
    expect(() => parseSemanticGateConfig({ threshold: 1.1 })).toThrow(/threshold/);
    expect(() => parseSemanticGateConfig({ threshold: Number.NaN })).toThrow(/threshold/);
    expect(parseSemanticGateConfig({ threshold: 1 }).threshold).toBe(1);
    expect(parseSemanticGateConfig({ threshold: 0.0001 }).threshold).toBe(0.0001);
  });

  it("topK / maxMessageChars / maxMessagesPerBatch / 超时 ≤0 → throw", () => {
    expect(() => parseSemanticGateConfig({ topK: 0 })).toThrow(/topK/);
    expect(() => parseSemanticGateConfig({ topK: 1.5 })).toThrow(/topK/);
    expect(() => parseSemanticGateConfig({ maxMessageChars: 0 })).toThrow(/maxMessageChars/);
    expect(() => parseSemanticGateConfig({ maxMessagesPerBatch: 0 })).toThrow(/maxMessagesPerBatch/);
    expect(() => parseSemanticGateConfig({ judgeTimeoutMs: 0 })).toThrow(/judgeTimeoutMs/);
    expect(() => parseSemanticGateConfig({ embeddingTimeoutMs: -1 })).toThrow(/embeddingTimeoutMs/);
  });

  it("非对象类型（字符串/数组/null）→ throw", () => {
    expect(() => parseSemanticGateConfig("shadow")).toThrow(/captureSemanticGate/);
    expect(() => parseSemanticGateConfig([])).toThrow(/captureSemanticGate/);
    expect(() => parseSemanticGateConfig(null)).toThrow(/captureSemanticGate/);
  });
});

// ── 伪记忆字段 ───────────────────────────────────────────────

describe("toPseudoMemory（判定链所需字段完整，不落库）", () => {
  it("字段逐个钉死（非默认 type/priority 输入不参与）", () => {
    const m = toPseudoMemory({ id: "m42", content: "用户偏好深色主题" });
    expect(m).toEqual({
      record_id: "sem_m42",
      content: "用户偏好深色主题",
      type: "episodic",
      priority: 0,
      source_message_ids: ["m42"],
      metadata: {},
      scene_name: "",
    });
  });
});

// ── 阈值边界 ─────────────────────────────────────────────────

describe("阈值过滤（score = 1 - distance，含等号）", () => {
  it("score === threshold 命中；threshold - 1e-4 不命中", async () => {
    const exact = await evaluateSemanticGate([MSG("m1", "甲")], deps({
      embeddingService: makeEmbedding(),
      vectorStore: makeStore({ hits: [hit("r1", 0.78)] }),
      judge: makeJudge(async () => skipJson("sem_m1")),
    }));
    expect(exact.candidates).toBe(1);
    expect([...exact.excludedMessageIds]).toEqual(["m1"]);

    const below = await evaluateSemanticGate([MSG("m1", "甲")], deps({
      embeddingService: makeEmbedding(),
      vectorStore: makeStore({ hits: [hit("r1", 0.78 - 1e-4)] }),
      judge: makeJudge(async () => skipJson("sem_m1")),
    }));
    expect(below.candidates).toBe(0);
    expect(below.excludedMessageIds.size).toBe(0);
    expect(below.topScore).toBeCloseTo(0.7799, 10);
  });

  it("非默认阈值生效（0.9 时 0.85 的候选被滤掉）", async () => {
    const r = await evaluateSemanticGate([MSG("m1", "甲")], deps({
      threshold: 0.9,
      embeddingService: makeEmbedding(),
      vectorStore: makeStore({ hits: [hit("r1", 0.85)] }),
      judge: makeJudge(async () => skipJson("sem_m1")),
    }));
    expect(r.candidates).toBe(0);
    expect(r.topScore).toBeCloseTo(0.85, 10);
  });

  it("topScore 取所有检索结果最高分（含未过阈值的）", async () => {
    const r = await evaluateSemanticGate([MSG("m1", "甲"), MSG("m2", "乙")], deps({
      embeddingService: makeEmbedding(),
      vectorStore: makeStore({
        hits: () => [hit("r1", 0.4), hit("r2", 0.9)],
      }),
      judge: makeJudge(async () => "[]"),
    }));
    expect(r.topScore).toBeCloseTo(0.9, 10);
    expect(r.candidates).toBe(2); // 两条消息各自的检索都含 0.9 候选
  });
});

// ── 动作白名单 ───────────────────────────────────────────────

describe("动作白名单：仅 skip 排除", () => {
  for (const action of ["store", "update", "merge"] as const) {
    it(`${action} → 放行（不排除）`, async () => {
      const r = await evaluateSemanticGate([MSG("m1", "甲")], deps({
        mode: "on",
        embeddingService: makeEmbedding(),
        vectorStore: makeStore({ hits: [hit("r1", 0.9)] }),
        judge: makeJudge(async () => JSON.stringify([{ record_id: "sem_m1", action, target_ids: ["r1"] }])),
      }));
      expect(r.hits).toBe(0);
      expect(r.excludedMessageIds.size).toBe(0);
      expect(r.failopen).toBe(false);
    });
  }

  it("skip → 排除；多消息只排除 skip 那条", async () => {
    const r = await evaluateSemanticGate([MSG("m1", "甲"), MSG("m2", "乙")], deps({
      mode: "on",
      embeddingService: makeEmbedding(),
      vectorStore: makeStore({ hits: [hit("r1", 0.9)] }),
      judge: makeJudge(async () => JSON.stringify([
        { record_id: "sem_m1", action: "skip", target_ids: ["r1"] },
        { record_id: "sem_m2", action: "update", target_ids: ["r1"] },
      ])),
    }));
    expect(r.hits).toBe(1);
    expect([...r.excludedMessageIds]).toEqual(["m1"]);
  });

  it("judge 收到的 prompt 内含伪记忆 id/content 与候选池", async () => {
    let captured = "";
    await evaluateSemanticGate([MSG("m1", "用户偏好深色主题")], deps({
      embeddingService: makeEmbedding(),
      vectorStore: makeStore({ hits: [hit("r1", 0.9, "深色模式偏好")] }),
      judge: makeJudge(async (p) => {
        captured = p.prompt;
        return skipJson("sem_m1");
      }),
    }));
    expect(captured).toContain("sem_m1");
    expect(captured).toContain("用户偏好深色主题");
    expect(captured).toContain("r1");
    expect(captured).toContain("深色模式偏好");
  });

  it("mode=shadow：skip 仍计 hits，但 excludedMessageIds 恒空", async () => {
    const r = await evaluateSemanticGate([MSG("m1", "甲")], deps({
      mode: "shadow",
      embeddingService: makeEmbedding(),
      vectorStore: makeStore({ hits: [hit("r1", 0.9)] }),
      judge: makeJudge(async () => skipJson("sem_m1")),
    }));
    expect(r.hits).toBe(1);
    expect(r.candidates).toBe(1);
    expect(r.excludedMessageIds.size).toBe(0);
  });
});

// ── 长度守卫 + 批上限 ────────────────────────────────────────

describe("长度守卫与批上限（计数正确、不截断判定）", () => {
  it("超长消息直接放行并计 oversize；不进 embed、不进 judge", async () => {
    const emb = makeEmbedding();
    const judge = makeJudge(async () => skipJson("sem_m1"));
    const r = await evaluateSemanticGate(
      [MSG("m1", "短"), MSG("m2", "x".repeat(11))],
      deps({ embeddingService: emb, vectorStore: makeStore(), judge, maxMessageChars: 10 }),
    );
    expect(r.oversize).toBe(1);
    expect(emb.embedBatch).toHaveBeenCalledTimes(1);
    expect((emb.embedBatch as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]).toEqual(["短"]);
    expect(r.excludedMessageIds.size).toBe(0);
  });

  it("超长消息不截断后判定（截断片段绝不出现在 embed 入参）", async () => {
    const emb = makeEmbedding();
    const long = "头部" + "x".repeat(50);
    await evaluateSemanticGate([MSG("m1", long)], deps({
      maxMessageChars: 10,
      embeddingService: emb,
      vectorStore: makeStore(),
      judge: makeJudge(),
    }));
    expect(emb.embedBatch).not.toHaveBeenCalled();
  });

  it("批上限：6 条可判消息 maxMessagesPerBatch=4 → capped=2，只 embed 4 条", async () => {
    const emb = makeEmbedding();
    const msgs = ["a", "b", "c", "d", "e", "f"].map((s) => MSG(`m${s}`, s));
    const r = await evaluateSemanticGate(msgs, deps({
      maxMessagesPerBatch: 4,
      embeddingService: emb,
      vectorStore: makeStore({ hits: [] }),
      judge: makeJudge(),
    }));
    expect(r.capped).toBe(2);
    expect((emb.embedBatch as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]).toEqual(["a", "b", "c", "d"]);
  });

  it("全部超长 → oversize=n, capped=0，零外部调用", async () => {
    const emb = makeEmbedding();
    const judge = makeJudge();
    const r = await evaluateSemanticGate([MSG("m1", "0123456789"), MSG("m2", "0123456789")], deps({
      maxMessageChars: 5, embeddingService: emb, vectorStore: makeStore(), judge,
    }));
    expect(r.oversize).toBe(2);
    expect(r.capped).toBe(0);
    expect(emb.embedBatch).not.toHaveBeenCalled();
    expect(judge.run).not.toHaveBeenCalled();
  });

  it("中文/emoji 按码点计数：3 个 emoji 在 maxMessageChars=3 下不超限", async () => {
    const emb = makeEmbedding();
    const r = await evaluateSemanticGate([MSG("m1", "😀😀😀")], deps({
      maxMessageChars: 3, embeddingService: emb, vectorStore: makeStore(), judge: makeJudge(),
    }));
    expect(r.oversize).toBe(0);
    expect(emb.embedBatch).toHaveBeenCalledTimes(1);
  });

  it("空批 / 全空白内容 → 零调用、零计数", async () => {
    const emb = makeEmbedding();
    const judge = makeJudge();
    const r = await evaluateSemanticGate([], deps({ embeddingService: emb, vectorStore: makeStore(), judge }));
    expect(r).toMatchObject({ candidates: 0, hits: 0, oversize: 0, capped: 0, topScore: 0, failopen: false });
    expect(emb.embedBatch).not.toHaveBeenCalled();
    expect(judge.run).not.toHaveBeenCalled();
  });
});

// ── fail-open 全矩阵 ────────────────────────────────────────

describe("fail-open：任何失败整批放行且 failopen=1", () => {
  const assertReleased = (r: Awaited<ReturnType<typeof evaluateSemanticGate>>) => {
    expect(r.excludedMessageIds.size).toBe(0);
    expect(r.hits).toBe(0);
    expect(r.failopen).toBe(true);
  };

  it("embed 429 → 放行", async () => {
    const logger = makeLogger();
    const r = await evaluateSemanticGate([MSG("m1", "甲")], deps({
      logger,
      embeddingService: makeEmbedding({ impl: async () => { throw new Error("429 rate limited"); } }),
      vectorStore: makeStore({ hits: [hit("r1", 0.9)] }),
      judge: makeJudge(async () => skipJson("sem_m1")),
    }));
    assertReleased(r);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("embed 5xx → 放行", async () => {
    const r = await evaluateSemanticGate([MSG("m1", "甲")], deps({
      embeddingService: makeEmbedding({ impl: async () => { throw new Error("503 Service Unavailable"); } }),
      vectorStore: makeStore({ hits: [hit("r1", 0.9)] }),
      judge: makeJudge(async () => skipJson("sem_m1")),
    }));
    assertReleased(r);
  });

  it("embed 超时（embeddingTimeoutMs 到点）→ 放行", async () => {
    const r = await evaluateSemanticGate([MSG("m1", "甲")], deps({
      embeddingTimeoutMs: 20,
      embeddingService: makeEmbedding({
        impl: async (texts) => new Promise((resolve) => setTimeout(() => resolve(texts.map(() => new Float32Array(4))), 200)),
      }),
      vectorStore: makeStore({ hits: [hit("r1", 0.9)] }),
      judge: makeJudge(async () => skipJson("sem_m1")),
    }));
    assertReleased(r);
  });

  it("空向量 → 放行", async () => {
    const r = await evaluateSemanticGate([MSG("m1", "甲")], deps({
      embeddingService: makeEmbedding({ impl: async (texts) => texts.map(() => new Float32Array(0)) }),
      vectorStore: makeStore({ hits: [hit("r1", 0.9)] }),
      judge: makeJudge(async () => skipJson("sem_m1")),
    }));
    assertReleased(r);
  });

  it("维度不符（emb 返 3 维 vs 服务声明 4 维）→ 放行且不进 KNN", async () => {
    const store = makeStore({ hits: [hit("r1", 0.9)] });
    const r = await evaluateSemanticGate([MSG("m1", "甲")], deps({
      embeddingService: makeEmbedding({ dims: 4, impl: async (texts) => texts.map(() => new Float32Array(3)) }),
      vectorStore: store,
      judge: makeJudge(async () => skipJson("sem_m1")),
    }));
    assertReleased(r);
    expect(store.searchL1Vector).not.toHaveBeenCalled();
  });

  it("向量表未建（vectorSearch=false）→ inert 放行且零 embed", async () => {
    const emb = makeEmbedding();
    const r = await evaluateSemanticGate([MSG("m1", "甲")], deps({
      embeddingService: emb,
      vectorStore: makeStore({ caps: { vectorSearch: false } }),
      judge: makeJudge(async () => skipJson("sem_m1")),
    }));
    assertReleased(r);
    expect(emb.embedBatch).not.toHaveBeenCalled();
  });

  it("KNN 查询抛错 → 放行", async () => {
    const r = await evaluateSemanticGate([MSG("m1", "甲")], deps({
      embeddingService: makeEmbedding(),
      vectorStore: makeStore({ searchImpl: async () => { throw new Error("db corrupted"); } }),
      judge: makeJudge(async () => skipJson("sem_m1")),
    }));
    assertReleased(r);
  });

  it("判定 500 → 放行", async () => {
    const r = await evaluateSemanticGate([MSG("m1", "甲")], deps({
      embeddingService: makeEmbedding(),
      vectorStore: makeStore({ hits: [hit("r1", 0.9)] }),
      judge: makeJudge(async () => { throw new Error("500 upstream"); }),
    }));
    assertReleased(r);
  });

  it("判定超时（judgeTimeoutMs 到点）→ 放行", async () => {
    const r = await evaluateSemanticGate([MSG("m1", "甲")], deps({
      judgeTimeoutMs: 20,
      embeddingService: makeEmbedding(),
      vectorStore: makeStore({ hits: [hit("r1", 0.9)] }),
      judge: makeJudge(async () => new Promise((resolve) => setTimeout(() => resolve(skipJson("sem_m1")), 200))),
    }));
    assertReleased(r);
  });

  it("坏 JSON → 既有解析降级（全 store）→ 不排除、不抛", async () => {
    const r = await evaluateSemanticGate([MSG("m1", "甲")], deps({
      embeddingService: makeEmbedding(),
      vectorStore: makeStore({ hits: [hit("r1", 0.9)] }),
      judge: makeJudge(async () => "not-json-at-all"),
    }));
    expect(r.excludedMessageIds.size).toBe(0);
    expect(r.hits).toBe(0);
  });

  it("非法 action（delete）→ 既有归一为 store → 放行、不抛", async () => {
    const r = await evaluateSemanticGate([MSG("m1", "甲")], deps({
      embeddingService: makeEmbedding(),
      vectorStore: makeStore({ hits: [hit("r1", 0.9)] }),
      judge: makeJudge(async () => JSON.stringify([{ record_id: "sem_m1", action: "delete", target_ids: ["r1"] }])),
    }));
    expect(r.excludedMessageIds.size).toBe(0);
    expect(r.hits).toBe(0);
  });

  it("判定缺条（2 条只回 1 条）→ 缺条放行、返回条排除", async () => {
    const r = await evaluateSemanticGate([MSG("m1", "甲"), MSG("m2", "乙")], deps({
      embeddingService: makeEmbedding(),
      vectorStore: makeStore({ hits: [hit("r1", 0.9)] }),
      judge: makeJudge(async () => JSON.stringify([{ record_id: "sem_m1", action: "skip", target_ids: ["r1"] }])),
    }));
    expect([...r.excludedMessageIds]).toEqual(["m1"]);
  });

  it("key 缺失/无效（错误串含 sk-）→ 放行且日志不含 sk-", async () => {
    const logger = makeLogger();
    const r = await evaluateSemanticGate([MSG("m1", "甲")], deps({
      logger,
      embeddingService: makeEmbedding({ impl: async () => { throw new Error("401 Unauthorized: invalid key sk-test-FAKE-not-a-real-key"); } }),
      vectorStore: makeStore({ hits: [hit("r1", 0.9)] }),
      judge: makeJudge(async () => { throw new Error("401 Bearer sk-test-FAKE-not-a-real-key"); }),
    }));
    assertReleased(r);
    const all = [...logger.warn.mock.calls, ...logger.error.mock.calls, ...logger.info.mock.calls]
      .map((c) => c.join(" ")).join("\n");
    expect(all).not.toContain("sk-");
    expect(all).toContain("[redacted-key]");
  });

  it("判定错误串含 sk- → runLlmJudgment 内部失败日志也被脱敏（runner 包一层）", async () => {
    const logger = makeLogger();
    const r = await evaluateSemanticGate([MSG("m1", "甲")], deps({
      logger,
      embeddingService: makeEmbedding(),
      vectorStore: makeStore({ hits: [hit("r1", 0.9)] }),
      judge: makeJudge(async () => { throw new Error("upstream 401 for sk-test-FAKE-judge-not-a-real-key"); }),
    }));
    assertReleased(r);
    const all = [...logger.warn.mock.calls, ...logger.error.mock.calls, ...logger.info.mock.calls]
      .map((c) => c.join(" ")).join("\n");
    expect(all).not.toContain("sk-");
  });
});

// ── 并发隔离 ────────────────────────────────────────────────

describe("并发：两批互不共享可变状态", () => {
  it("一批失败、一批命中 → 结果不串", async () => {
    const ok = evaluateSemanticGate([MSG("a1", "甲")], deps({
      embeddingService: makeEmbedding(),
      vectorStore: makeStore({ hits: [hit("r1", 0.9)] }),
      judge: makeJudge(async () => skipJson("sem_a1")),
    }));
    const bad = evaluateSemanticGate([MSG("b1", "乙"), MSG("b2", "丙")], deps({
      embeddingService: makeEmbedding({ impl: async () => { throw new Error("boom"); } }),
      vectorStore: makeStore({ hits: [hit("r2", 0.9)] }),
      judge: makeJudge(async () => skipJson("sem_b1")),
    }));
    const [r1, r2] = await Promise.all([ok, bad]);
    expect([...r1.excludedMessageIds]).toEqual(["a1"]);
    expect(r1.failopen).toBe(false);
    expect(r2.excludedMessageIds.size).toBe(0);
    expect(r2.failopen).toBe(true);
  });

  it("filter 原样透传给 searchL1Vector（第 4 参数）", async () => {
    const store = makeStore({ hits: [] });
    const filter = { teamId: "t1", userId: "u1", agentId: "a1" };
    await evaluateSemanticGate([MSG("m1", "甲")], deps({
      filter,
      embeddingService: makeEmbedding(),
      vectorStore: store,
      judge: makeJudge(),
    }));
    const call = (store.searchL1Vector as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(call[3]).toEqual(filter);
  });
});

// ── shadow 观测（review §shadow 锚点要求）─────────────────────
//
// REVIEW-4b-spec-20261102 §Q4/§shadow 明确要求：锚点记录**每条消息的 top1
// 相似度（20 桶直方图）**、候选数、按 role 分层、按 action 分布——用于事后
// 不重跑即可回算任意阈值下的候选率，并抽检误杀。仅记批次 top（最大值）不够。

describe("shadow 观测：top1 直方图 / by_role / by_action / samples", () => {
  it("0.9 落第 18 桶；role 与 action 分层；samples 带 id/top1/action/target_ids", async () => {
    const r = await evaluateSemanticGate(
      [
        { id: "m1", content: "甲", role: "user" },
        { id: "m2", content: "乙", role: "assistant" },
      ],
      deps({
        threshold: 0.78,
        embeddingService: makeEmbedding(),
        vectorStore: makeStore({ hits: [hit("r1", 0.9)] }),
        judge: makeJudge(async () => JSON.stringify([
          { record_id: "sem_m1", action: "skip", target_ids: ["r1"] },
          { record_id: "sem_m2", action: "update", target_ids: ["r1"] },
        ])),
      }),
    );

    expect(r.top1Buckets).toHaveLength(20);
    expect(r.top1Buckets[18]).toBe(2); // floor(0.9/0.05)=18
    expect(r.byRole).toEqual({
      user: { candidates: 1, hits: 1 },
      assistant: { candidates: 1, hits: 0 },
    });
    expect(r.byAction).toEqual({ store: 0, update: 1, merge: 0, skip: 1, none: 0 });
    expect(r.samples).toEqual([
      { id: "m1", role: "user", top1: 0.9, action: "skip", targetIds: ["r1"] },
      { id: "m2", role: "assistant", top1: 0.9, action: "update", targetIds: ["r1"] },
    ]);
  });

  it("未达阈值：top1 仍进直方图（action=none），不进 samples/不调 judge", async () => {
    const judge = makeJudge();
    const r = await evaluateSemanticGate(
      [{ id: "m1", content: "甲", role: "user" }],
      deps({
        threshold: 0.78,
        embeddingService: makeEmbedding(),
        vectorStore: makeStore({ hits: [hit("r1", 0.4)] }),
        judge,
      }),
    );

    expect(r.candidates).toBe(0);
    expect(r.top1Buckets[8]).toBe(1); // floor(0.4/0.05)=8
    expect(r.byAction).toEqual({ store: 0, update: 0, merge: 0, skip: 0, none: 1 });
    expect(r.byRole).toEqual({ user: { candidates: 0, hits: 0 } });
    expect(r.samples).toEqual([]);
    expect(judge.run).not.toHaveBeenCalled();
  });

  it("role 缺省归 unknown；1.0 归入最后一桶（19）", async () => {
    const r = await evaluateSemanticGate(
      [MSG("m1", "甲")],
      deps({
        embeddingService: makeEmbedding(),
        vectorStore: makeStore({ hits: [hit("r1", 1.0)] }),
        judge: makeJudge(async () => skipJson("sem_m1")),
      }),
    );
    expect(r.top1Buckets[19]).toBe(1);
    expect(r.byRole).toEqual({ unknown: { candidates: 1, hits: 1 } });
  });

  it("by_len 按码点分桶（<200 / 200-1000 / >1000；REVIEW §shadow）", async () => {
    const r = await evaluateSemanticGate(
      [
        { id: "m1", content: "甲", role: "user" },
        { id: "m2", content: "x".repeat(500), role: "user" },
        { id: "m3", content: "x".repeat(1500), role: "user" },
      ],
      deps({
        maxMessageChars: 2000,
        embeddingService: makeEmbedding(),
        vectorStore: makeStore({ hits: [] }),
        judge: makeJudge(),
      }),
    );
    expect(r.byLen).toEqual({ lt200: 1, mid: 1, gt1000: 1 });
  });

  it("failopen：新聚合字段归零/清空（批次已放行，不得留下半截观测）", async () => {
    const r = await evaluateSemanticGate(
      [{ id: "m1", content: "甲", role: "user" }],
      deps({
        embeddingService: makeEmbedding({ impl: async () => { throw new Error("boom"); } }),
        vectorStore: makeStore({ hits: [hit("r1", 0.9)] }),
        judge: makeJudge(async () => skipJson("sem_m1")),
      }),
    );
    expect(r.failopen).toBe(true);
    expect(r.top1Buckets).toEqual(new Array(20).fill(0));
    expect(r.byRole).toEqual({});
    expect(r.byAction).toEqual({ store: 0, update: 0, merge: 0, skip: 0, none: 0 });
    expect(r.byLen).toEqual({ lt200: 0, mid: 0, gt1000: 0 });
    expect(r.samples).toEqual([]);
  });
});
