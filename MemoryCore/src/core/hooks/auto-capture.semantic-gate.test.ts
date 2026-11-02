// 票④b（exp/p1-4b-semantic-gate）：auto-capture 接线测试。
// SPEC §9：mode 三态（off 零额外 I/O / shadow 排除恒 0 但锚点有数 / on 仅 skip 排除）、
// ④×④b 叠加不重复计数、inert（provider=none / 无 vectorStore / 无 judge）、锚点格式。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performAutoCapture } from "./auto-capture.js";
import { resetSemanticGateInertLogForTests } from "./capture-semantic-gate.js";
import type { IMemoryStore, L1SearchResult, StoreCapabilities } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { LLMRunner } from "../types.js";
import type { MemoryTdaiConfig } from "../../config.js";
import { CAPTURE_SEMANTIC_GATE_DEFAULTS } from "./capture-semantic-gate.js";

// ── Test doubles ─────────────────────────────────────────────

const CAPS: StoreCapabilities = {
  vectorSearch: true, ftsSearch: true, nativeHybridSearch: false, sparseVectors: false, profileRows: true,
};

function makeStore(overrides: Partial<IMemoryStore> = {}): IMemoryStore {
  return {
    upsertL0: vi.fn(async () => true),
    getAllL1Texts: vi.fn(async () => []),
    getCapabilities: () => CAPS,
    searchL1Vector: vi.fn(async () => []),
    countL1: vi.fn(async () => 1),
    isFtsAvailable: () => true,
    ...overrides,
  } as unknown as IMemoryStore;
}

function makeEmbedding(): EmbeddingService & { embedBatch: ReturnType<typeof vi.fn>; embed: ReturnType<typeof vi.fn> } {
  const svc = {
    embed: vi.fn(async () => new Float32Array(4)),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(4))),
    getDimensions: () => 4,
    getProviderInfo: () => ({ provider: "mock", model: "mock" }),
    isReady: () => true,
    startWarmup: () => {},
  };
  return svc as unknown as EmbeddingService & { embedBatch: ReturnType<typeof vi.fn>; embed: ReturnType<typeof vi.fn> };
}

function hit(recordId: string, score: number): L1SearchResult {
  return {
    record_id: recordId, content: "在案事实", type: "episodic", priority: 50, scene_name: "s",
    score, timestamp_str: "2026-11-01T00:00:00.000Z", timestamp_start: "", timestamp_end: "",
    version: 1, session_key: "s", session_id: "sid", team_id: "default", task_id: "default",
    user_id: "default", agent_id: "default", metadata_json: "{}",
  };
}

/** judge 回显 prompt 里所有 sem_ 记录的 skip 决策。 */
function skipAllJudge(): LLMRunner & { run: ReturnType<typeof vi.fn> } {
  const judge = {
    run: vi.fn(async (params: { prompt: string }) => {
      const ids = [...params.prompt.matchAll(/record_id: (sem_[^\s")\n,]+)/g)].map((m) => m[1]!);
      return JSON.stringify(ids.map((id) => ({ record_id: id, action: "skip", target_ids: ["r1"] })));
    }),
  };
  return judge as unknown as LLMRunner & { run: ReturnType<typeof vi.fn> };
}

function makeCfg(over: {
  gate?: boolean;
  semantic?: Record<string, unknown> | undefined;
} = {}): MemoryTdaiConfig {
  return {
    extraction: {
      captureDedupGate: over.gate,
      captureSemanticGate: over.semantic === undefined
        ? { ...CAPTURE_SEMANTIC_GATE_DEFAULTS }
        : { ...CAPTURE_SEMANTIC_GATE_DEFAULTS, ...over.semantic } as never,
    },
  } as unknown as MemoryTdaiConfig;
}

const CONTENT = "部署网关端口8420";

function makeMessages(tsBase = 1_700_000_000_000): unknown[] {
  return [
    { role: "user", content: CONTENT, timestamp: tsBase },
    { role: "assistant", content: `收到：${CONTENT}`, timestamp: tsBase + 1 },
  ];
}

function anchorLines(logger: { info: ReturnType<typeof vi.fn> }): string[] {
  return logger.info.mock.calls
    .map((c: unknown[]) => String(c[0]))
    .filter((s: string) => s.includes("metric=capture_semantic_gate"));
}

describe("performAutoCapture × ④b 语义门接线", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tdai-semgate-"));
    registry = new Set<Promise<void>>();
    resetSemanticGateInertLogForTests();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** shadow 语义门是后台任务：测试用共享 registry 等待其完成（on 为内联，无任务）。 */
  let registry: Set<Promise<void>>;

  async function drain(): Promise<void> {
    while (registry.size > 0) {
      await Promise.allSettled([...registry]);
    }
  }

  function run(params: {
    cfg: MemoryTdaiConfig;
    store?: IMemoryStore;
    embedding?: EmbeddingService;
    judge?: LLMRunner;
    logger?: ReturnType<typeof makeLogger>;
    messages?: unknown[];
  }) {
    return performAutoCapture({
      messages: params.messages ?? makeMessages(),
      sessionKey: "sess-sem",
      cfg: params.cfg,
      pluginDataDir: dir,
      scheduler: { notifyConversation: vi.fn(async () => {}) } as never,
      vectorStore: params.store,
      embeddingService: params.embedding,
      semanticGateJudge: params.judge,
      bgTaskRegistry: registry,
      logger: params.logger as never,
    });
  }

  function makeLogger() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  }

  // ── off ──────────────────────────────────────────────────

  it("off（缺省）：零额外 I/O、零锚点、返回形状与基线逐字节一致", async () => {
    const emb = makeEmbedding();
    const store = makeStore();
    const judge = skipAllJudge();
    const logger = makeLogger();

    const result = await run({ cfg: makeCfg(), store, embedding: emb, judge, logger });

    expect(emb.embedBatch).not.toHaveBeenCalled();
    expect(store.searchL1Vector).not.toHaveBeenCalled();
    expect(judge.run).not.toHaveBeenCalled();
    expect(anchorLines(logger)).toEqual([]);
    expect(Object.keys(result)).toEqual(["schedulerNotified", "l0RecordedCount", "l0VectorsWritten", "filteredMessages"]);
  });

  it("off 双版本等价：explicit mode=off 与缺省键结果 deepEqual", async () => {
    const a = await run({ cfg: makeCfg(), store: makeStore(), embedding: makeEmbedding() });
    const b = await run({
      cfg: makeCfg({ semantic: { mode: "off" } }),
      store: makeStore(), embedding: makeEmbedding(), messages: makeMessages(1_700_000_100_000),
    });
    const strip = (r: { filteredMessages: unknown[] }) => ({
      schedulerNotified: r.schedulerNotified,
      l0RecordedCount: r.l0RecordedCount,
      l0VectorsWritten: r.l0VectorsWritten,
      filtered: r.filteredMessages.length,
    });
    expect(strip(a)).toEqual(strip(b));
  });

  // ── shadow ───────────────────────────────────────────────

  it("shadow：完整执行判定但排除恒 0（upsertL0 全量），锚点有数且 skipped=0", async () => {
    const emb = makeEmbedding();
    const store = makeStore({ searchL1Vector: vi.fn(async () => [hit("r1", 0.9)]) });
    const judge = skipAllJudge();
    const logger = makeLogger();

    const result = await run({
      cfg: makeCfg({ semantic: { mode: "shadow" } }),
      store, embedding: emb, judge, logger,
    });

    expect(result.gateExcludedCount).toBeUndefined();
    expect((store.upsertL0 as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect(result.l0VectorsWritten).toBe(2);

    await drain(); // shadow 为后台任务
    expect(judge.run).toHaveBeenCalledTimes(1);
    const anchor = anchorLines(logger)[0]!;
    expect(anchor).toMatch(/metric=capture_semantic_gate mode=shadow value=2 hits=2 skipped=0 oversize=0 capped=0 top=0\.90 failopen=0/);
  });

  it("shadow：判定返回 store/update/merge → hits=0、skipped=0", async () => {
    const emb = makeEmbedding();
    const store = makeStore({ searchL1Vector: vi.fn(async () => [hit("r1", 0.9)]) });
    const judge = { run: vi.fn(async () => "[]") } as unknown as LLMRunner;
    const logger = makeLogger();

    await run({ cfg: makeCfg({ semantic: { mode: "shadow" } }), store, embedding: emb, judge, logger });
    await drain();
    const anchor = anchorLines(logger)[0]!;
    expect(anchor).toContain("hits=0");
    expect(anchor).toContain("skipped=0");
  });

  it("shadow 后台化：judge 挂起时 performAutoCapture 已返回、upsertL0 已调用、锚点尚未出现", async () => {
    let release!: (v: string) => void;
    const gateResponse = new Promise<string>((res) => { release = res; });
    const emb = makeEmbedding();
    const store = makeStore({ searchL1Vector: vi.fn(async () => [hit("r1", 0.9)]) });
    const judge = { run: vi.fn(() => gateResponse) } as unknown as LLMRunner;
    const logger = makeLogger();

    const t0 = Date.now();
    const result = await run({ cfg: makeCfg({ semantic: { mode: "shadow" } }), store, embedding: emb, judge, logger });
    const elapsed = Date.now() - t0;

    // 内联路径（L0 向量 + notify）已完成，而判定尚未 resolve
    expect(result.schedulerNotified).toBe(true);
    expect((store.upsertL0 as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect(anchorLines(logger)).toEqual([]);
    expect(registry.size).toBe(1); // 后台任务登记在册
    expect(elapsed).toBeLessThan(1000);

    release(JSON.stringify([{ record_id: "sem_x", action: "skip", target_ids: ["r1"] }]));
    await drain();
    const anchor = anchorLines(logger)[0]!;
    expect(anchor).toContain("mode=shadow");
    expect(anchor).toContain("skipped=0"); // 后台完成也不排除
  });

  it("shadow 后台化：bgTaskRegistry 缺省时仍不内联、不产生 unhandled rejection", async () => {
    let release!: (v: string) => void;
    const gateResponse = new Promise<string>((res) => { release = res; });
    const store = makeStore({ searchL1Vector: vi.fn(async () => [hit("r1", 0.9)]) });
    const judge = { run: vi.fn(() => gateResponse) } as unknown as LLMRunner;
    const logger = makeLogger();

    const result = await performAutoCapture({
      messages: makeMessages(1_700_000_300_000),
      sessionKey: "sess-sem",
      cfg: makeCfg({ semantic: { mode: "shadow" } }),
      pluginDataDir: dir,
      scheduler: { notifyConversation: vi.fn(async () => {}) } as never,
      vectorStore: store,
      embeddingService: makeEmbedding(),
      semanticGateJudge: judge,
      // 故意不传 bgTaskRegistry
      logger: logger as never,
    });

    expect(result.l0VectorsWritten).toBe(2);
    expect(anchorLines(logger)).toEqual([]);
    release(JSON.stringify([{ record_id: "sem_x", action: "skip", target_ids: [] }]));
    await new Promise((r) => setTimeout(r, 20));
    expect(anchorLines(logger)[0]).toContain("mode=shadow");
  });

  it("on 保持内联：judge 挂起时 performAutoCapture 不返回，resolve 后 skip 才生效", async () => {
    let release!: (v: string) => void;
    const gateResponse = new Promise<string>((res) => { release = res; });
    let capturedPrompt = "";
    const store = makeStore({ searchL1Vector: vi.fn(async () => [hit("r1", 0.9)]) });
    const judge = {
      run: vi.fn((params: { prompt: string }) => {
        capturedPrompt = params.prompt;
        return gateResponse;
      }),
    } as unknown as LLMRunner;
    const logger = makeLogger();

    const pending = run({ cfg: makeCfg({ semantic: { mode: "on" } }), store, embedding: makeEmbedding(), judge, logger });
    let settled = false;
    void pending.then(() => { settled = true; });

    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false); // 内联等待判定
    expect((store.upsertL0 as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);

    // 回显 prompt 里的真实 sem_ 记录 id
    const ids = [...capturedPrompt.matchAll(/record_id: (sem_[^\s")\n,]+)/g)].map((m) => m[1]!);
    expect(ids.length).toBe(2);
    release(JSON.stringify(ids.map((id) => ({ record_id: id, action: "skip", target_ids: ["r1"] }))));
    const result = await pending;
    expect(result.l0VectorsWritten).toBe(0);
  });

  // ── on ───────────────────────────────────────────────────

  it("on：skip 命中 → 该消息跳过 upsertL0，L0 记录数仍含它；锚点 skipped=2", async () => {
    const emb = makeEmbedding();
    const store = makeStore({ searchL1Vector: vi.fn(async () => [hit("r1", 0.9)]) });
    const judge = skipAllJudge();
    const logger = makeLogger();

    const result = await run({ cfg: makeCfg({ semantic: { mode: "on" } }), store, embedding: emb, judge, logger });

    expect(result.l0RecordedCount).toBe(2); // L0 JSONL 已留痕
    expect(result.l0VectorsWritten).toBe(0); // 不进蒸馏源（跳过 upsertL0）
    expect((store.upsertL0 as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    const anchor = anchorLines(logger)[0]!;
    expect(anchor).toContain("mode=on");
    expect(anchor).toContain("skipped=2");
  });

  it("on：store/update/merge → 放行（upsertL0 照常、无 writeMemory）", async () => {
    const emb = makeEmbedding();
    const store = makeStore({ searchL1Vector: vi.fn(async () => [hit("r1", 0.9)]) });
    const judge = { run: vi.fn(async () => JSON.stringify([
      { record_id: "sem_x", action: "store", target_ids: [] },
    ])) } as unknown as LLMRunner;
    const logger = makeLogger();

    const result = await run({ cfg: makeCfg({ semantic: { mode: "on" } }), store, embedding: emb, judge, logger });
    expect((store.upsertL0 as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect(result.l0VectorsWritten).toBe(2);
    expect(anchorLines(logger)[0]).toContain("skipped=0");
  });

  it("on：无候选（相似度低于阈值）→ 不调 judge、全放行", async () => {
    const emb = makeEmbedding();
    const store = makeStore({ searchL1Vector: vi.fn(async () => [hit("r1", 0.5)]) });
    const judge = skipAllJudge();
    const logger = makeLogger();

    await run({ cfg: makeCfg({ semantic: { mode: "on", threshold: 0.78 } }), store, embedding: emb, judge, logger });
    expect(judge.run).not.toHaveBeenCalled();
    expect(anchorLines(logger)[0]).toContain("value=0 hits=0 skipped=0");
  });

  // ── ④ × ④b 叠加 ─────────────────────────────────────────

  it("④ 已排除的消息不进 ④b（不重复计数/不重复 embedding）", async () => {
    const emb = makeEmbedding();
    const store = makeStore({
      getAllL1Texts: vi.fn(async () => [
        { record_id: "m_hit", content: CONTENT, updated_time: "2026-10-31T00:00:00.000Z" },
        { record_id: "m_hit2", content: `收到：${CONTENT}`, updated_time: "2026-10-31T00:00:00.000Z" },
      ]),
      searchL1Vector: vi.fn(async () => [hit("r1", 0.9)]),
    });
    const judge = skipAllJudge();
    const logger = makeLogger();

    const result = await run({
      cfg: makeCfg({ gate: true, semantic: { mode: "on" } }),
      store, embedding: emb, judge, logger,
    });

    // ④ 整批命中 → 短路，④b 不执行（无锚点）
    expect(result.shortcircuited).toBe(true);
    expect(anchorLines(logger)).toEqual([]);
    expect(emb.embedBatch).not.toHaveBeenCalled();
  });

  it("④ 部分排除 → ④b 只判剩余消息；两锚点计数不重叠", async () => {
    const emb = makeEmbedding();
    const store = makeStore({
      getAllL1Texts: vi.fn(async () => [
        { record_id: "m_old", content: CONTENT, updated_time: "2026-10-31T00:00:00.000Z" },
      ]),
      searchL1Vector: vi.fn(async () => [hit("r1", 0.9)]),
    });
    const judge = skipAllJudge();
    const logger = makeLogger();

    const messages = [
      { role: "user", content: CONTENT, timestamp: 1_700_000_000_000 },
      { role: "assistant", content: "这是全新的一句", timestamp: 1_700_000_000_001 },
    ];
    const result = await run({
      cfg: makeCfg({ gate: true, semantic: { mode: "on" } }),
      store, embedding: emb, judge, logger, messages,
    });

    // ④ 排除 1 条（消息级），只把剩余 1 条喂给 ④b
    expect(result.gateExcludedCount).toBe(1);
    expect((emb.embedBatch as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toEqual(["这是全新的一句"]);

    const dedupAnchor = logger.info.mock.calls.map((c: unknown[]) => String(c[0])).find((s: string) => s.includes("metric=capture_dedup_excluded"));
    const semAnchor = anchorLines(logger)[0]!;
    expect(dedupAnchor).toContain("value=1");
    expect(semAnchor).toContain("value=1"); // ④b 只看 1 条
    expect(semAnchor).toContain("skipped=1");
    // 合并后的跳过生效：④ 的 1 条 + ④b 的 1 条 = 0 条向量
    expect(result.l0VectorsWritten).toBe(0);
  });

  // ── inert ────────────────────────────────────────────────

  it("mode=on 但无 embeddingService → inert（不崩、不排除），锚点每进程只打一次", async () => {
    const store = makeStore({ searchL1Vector: vi.fn(async () => [hit("r1", 0.9)]) });
    const judge = skipAllJudge();
    const logger = makeLogger();

    const r1 = await run({ cfg: makeCfg({ semantic: { mode: "on" } }), store, judge, logger });
    const r2 = await run({
      cfg: makeCfg({ semantic: { mode: "on" } }), store, judge, logger,
      messages: makeMessages(1_700_000_200_000),
    });

    expect(r1.l0VectorsWritten).toBe(2);
    expect(r2.l0VectorsWritten).toBe(2);
    expect(judge.run).not.toHaveBeenCalled();
    const lines = anchorLines(logger);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("skipped=inert");
  });

  it("mode=on 但无 judge → inert（仍算 embedding 不发起？否：先判 deps 完整再执行）", async () => {
    const emb = makeEmbedding();
    const store = makeStore({ searchL1Vector: vi.fn(async () => [hit("r1", 0.9)]) });
    const logger = makeLogger();

    const r = await run({ cfg: makeCfg({ semantic: { mode: "on" } }), store, embedding: emb, logger });
    expect(r.l0VectorsWritten).toBe(2);
    expect(emb.embedBatch).not.toHaveBeenCalled();
    expect(anchorLines(logger)[0]).toContain("skipped=inert");
  });

  it("mode=on 但 vectorSearch=false（表未建）→ inert", async () => {
    const emb = makeEmbedding();
    const store = makeStore({
      getCapabilities: () => ({ ...CAPS, vectorSearch: false }),
      searchL1Vector: vi.fn(async () => [hit("r1", 0.9)]),
    });
    const judge = skipAllJudge();
    const logger = makeLogger();

    const r = await run({ cfg: makeCfg({ semantic: { mode: "on" } }), store, embedding: emb, judge, logger });
    expect(r.l0VectorsWritten).toBe(2);
    expect(emb.embedBatch).not.toHaveBeenCalled();
    expect(anchorLines(logger)[0]).toContain("skipped=inert");
  });

  it("门内异常 → 放行且 failopen=1（不影响捕获）", async () => {
    const emb = makeEmbedding();
    (emb.embedBatch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("network down"));
    const store = makeStore({ searchL1Vector: vi.fn(async () => [hit("r1", 0.9)]) });
    const judge = skipAllJudge();
    const logger = makeLogger();

    const r = await run({ cfg: makeCfg({ semantic: { mode: "on" } }), store, embedding: emb, judge, logger });
    expect(r.schedulerNotified).toBe(true);
    expect(r.l0VectorsWritten).toBe(2);
    expect(anchorLines(logger)[0]).toContain("failopen=1");
  });

  it("长度守卫锚点：超长消息计 oversize 且不参与判定", async () => {
    const emb = makeEmbedding();
    const store = makeStore({ searchL1Vector: vi.fn(async () => [hit("r1", 0.9)]) });
    const judge = skipAllJudge();
    const logger = makeLogger();

    const long = "x".repeat(50);
    await run({
      cfg: makeCfg({ semantic: { mode: "shadow", maxMessageChars: 10 } }),
      store, embedding: emb, judge, logger,
      messages: [{ role: "user", content: long, timestamp: 1_700_000_000_000 }],
    });
    await drain();
    expect((emb.embedBatch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? []).not.toContain(long);
    expect(anchorLines(logger)[0]).toContain("oversize=1");
  });
});
