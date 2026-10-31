import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performAutoCapture } from "./auto-capture.js";
import { captureGateForStore } from "../../utils/capture-dedup-gate.js";
import { VectorStore } from "../store/sqlite/memory-store.js";
import type { MemoryRecord } from "../record/l1-writer.js";
import type { IMemoryStore } from "../../core/store/types.js";
import type { MemoryTdaiConfig } from "../../config.js";

// ── Test doubles ─────────────────────────────────────────────

function makeVectorStore(overrides: Partial<IMemoryStore> = {}): IMemoryStore {
  return {
    upsertL0: vi.fn(async () => true),
    getAllL1Texts: vi.fn(async () => []),
    ...overrides,
  } as unknown as IMemoryStore;
}

function makeScheduler() {
  return { notifyConversation: vi.fn(async () => {}) } as never;
}

function makeCfg(gate: boolean | undefined): MemoryTdaiConfig {
  return {
    extraction: { captureDedupGate: gate },
  } as unknown as MemoryTdaiConfig;
}

const CONTENT = "部署网关端口8420";
const CONTENT_VARIANT = "部署网关　端口：８４２０！"; // 全半角/空白/标点变体

function makeMessages(content: string, tsBase = 1_700_000_000_000): unknown[] {
  return [
    { role: "user", content, timestamp: tsBase },
    { role: "assistant", content: `收到：${content}`, timestamp: tsBase + 1 },
  ];
}

/** 在案种子：user 句 + assistant 回执句都入案（命中=全批命中）。 */
function seedFor(content: string, ids = ["m_hit", "m_hit2"]) {
  return [
    { record_id: ids[0], content, updated_time: "2026-10-31T00:00:00.000Z" },
    { record_id: ids[1], content: `收到：${content}`, updated_time: "2026-10-31T00:00:00.000Z" },
  ];
}

describe("performAutoCapture × capture-dedup-gate（票④）", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tdai-gate-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(params: {
    cfg: MemoryTdaiConfig;
    vectorStore?: IMemoryStore;
    content?: string;
    tsBase?: number;
    logger?: { info: ReturnType<typeof vi.fn>; warn?: ReturnType<typeof vi.fn>; debug?: ReturnType<typeof vi.fn>; error?: ReturnType<typeof vi.fn> };
  }) {
    return performAutoCapture({
      messages: makeMessages(params.content ?? CONTENT, params.tsBase),
      sessionKey: "sess-gate",
      cfg: params.cfg,
      pluginDataDir: dir,
      scheduler: makeScheduler(),
      vectorStore: params.vectorStore ?? makeVectorStore(),
      logger: params.logger as never,
    });
  }

  // ── off 兼容钉 ────────────────────────────────────────────

  it("off 兼容钉：开关未传时结果与基线同形同序、零额外 I/O（不查在案、不推热度）", async () => {
    const store = makeVectorStore();
    const result = await run({ cfg: makeCfg(undefined), vectorStore: store });

    // 基线返回形状：四键、同序、无新增键（JSON 逐字节钉）
    expect(Object.keys(result)).toEqual([
      "schedulerNotified",
      "l0RecordedCount",
      "l0VectorsWritten",
      "filteredMessages",
    ]);
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      schedulerNotified: true,
      l0RecordedCount: 2,
      l0VectorsWritten: 2,
      filteredMessages: expect.any(Array),
    });
    expect((result as { scheduler?: unknown }).scheduler).toBeUndefined();
    // 零额外 I/O：在案查询与热度触达均不发生
    expect(store.getAllL1Texts).not.toHaveBeenCalled();
    expect((store as { touchL1Heat?: unknown }).touchL1Heat).toBeUndefined();
    expect((store.upsertL0 as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("off 兼容钉：显式 false 与未传行为一致", async () => {
    const store = makeVectorStore();
    const result = await run({ cfg: makeCfg(false), vectorStore: store });
    expect(result.schedulerNotified).toBe(true);
    expect(Object.keys(result)).not.toContain("shortcircuited");
    expect(store.getAllL1Texts).not.toHaveBeenCalled();
  });

  // ── on：命中短路 ──────────────────────────────────────────

  it("on+命中：短路免蒸馏（不 notify、不写向量）、推热度、返回结构化结果+锚点行", async () => {
    const touchL1Heat = vi.fn(async () => true);
    const store = makeVectorStore({
      getAllL1Texts: vi.fn(async () => seedFor(CONTENT_VARIANT)),
      touchL1Heat,
    });
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const result = await run({ cfg: makeCfg(true), vectorStore: store, logger });

    // 结构化短路语义
    expect(result.shortcircuited).toBe(true);
    expect(result.matchedId).toBe("m_hit");
    expect(result.schedulerNotified).toBe(false);
    expect(result.l0RecordedCount).toBe(2); // L0 原始日志仍留痕
    expect(result.l0VectorsWritten).toBe(0); // 蒸馏前置的向量写入也省掉
    // 蒸馏触发被跳过；热度被推送
    expect((store.upsertL0 as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect(touchL1Heat).toHaveBeenCalledWith("m_hit", expect.any(String));
    // 观测锚点行（与在役 metric 行同格式，可面板解析）
    const anchor = logger.info.mock.calls.map((c: unknown[]) => String(c[0])).find((s: string) => s.includes("metric=capture_dedup_shortcircuit"));
    expect(anchor).toBeTruthy();
    expect(anchor).toContain("value=1");
    expect(anchor).toContain("matched=m_hit");
  });

  it("on+命中：store 无 touchL1Heat 能力 → 仍短路（能力可选，不误伤）", async () => {
    const store = makeVectorStore({
      getAllL1Texts: vi.fn(async () => seedFor(CONTENT)),
    });
    const result = await run({ cfg: makeCfg(true), vectorStore: store });
    expect(result.shortcircuited).toBe(true);
    expect(result.matchedId).toBe("m_hit");
  });

  it("on+命中：touchL1Heat 抛错 → 短路语义不受影响（非致命）", async () => {
    const store = makeVectorStore({
      getAllL1Texts: vi.fn(async () => seedFor(CONTENT)),
      touchL1Heat: vi.fn(async () => {
        throw new Error("touch failed");
      }),
    });
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const result = await run({ cfg: makeCfg(true), vectorStore: store, logger });
    expect(result.shortcircuited).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });

  // ── on：未命中放行 ────────────────────────────────────────

  it("on+未命中：原路径放行（notify 正常、无短路键）", async () => {
    const store = makeVectorStore({
      getAllL1Texts: vi.fn(async () => [
        { record_id: "m_other", content: "完全不相干的在案记忆", updated_time: "2026-10-31T00:00:00.000Z" },
      ]),
    });
    const result = await run({ cfg: makeCfg(true), vectorStore: store });
    expect(result.shortcircuited).toBeUndefined();
    expect(result.schedulerNotified).toBe(true);
    expect(result.l0VectorsWritten).toBe(2);
    expect(Object.keys(result)).toEqual([
      "schedulerNotified",
      "l0RecordedCount",
      "l0VectorsWritten",
      "filteredMessages",
    ]);
  });

  it("on+部分命中（一旧一新）：消息级排除——旧消息不写向量，新消息照常写+notify（新内容零误杀）", async () => {
    const store = makeVectorStore({
      getAllL1Texts: vi.fn(async () => [
        { record_id: "m_old", content: CONTENT, updated_time: "2026-10-31T00:00:00.000Z" },
      ]),
    });
    const result = await performAutoCapture({
      messages: [
        { role: "user", content: CONTENT, timestamp: 1_700_000_000_000 },
        { role: "assistant", content: "这是全新的一句", timestamp: 1_700_000_000_001 },
      ],
      sessionKey: "sess-gate",
      cfg: makeCfg(true),
      pluginDataDir: dir,
      scheduler: makeScheduler(),
      vectorStore: store,
    });
    expect(result.shortcircuited).toBeUndefined(); // 整批未短路（还有新内容要蒸馏）
    expect(result.schedulerNotified).toBe(true);
    expect(result.l0RecordedCount).toBe(2); // L0 原始日志两条都留痕
    expect(result.l0VectorsWritten).toBe(1); // 仅新消息写向量（旧消息消息级排除）
    expect(result.gateExcludedCount).toBe(1);
    const upsertCalls = (store.upsertL0 as ReturnType<typeof vi.fn>).mock.calls as Array<[{ messageText: string }]>;
    expect(upsertCalls.length).toBe(1);
    expect(upsertCalls[0][0].messageText).toBe("这是全新的一句");
  });

  it("on+畸形输入（空/纯标点消息）：不误杀、原路径放行", async () => {
    const store = makeVectorStore();
    const result = await performAutoCapture({
      messages: [
        { role: "user", content: "。。！！", timestamp: 1_700_000_000_000 },
        { role: "assistant", content: "", timestamp: 1_700_000_000_001 },
      ],
      sessionKey: "sess-gate",
      cfg: makeCfg(true),
      pluginDataDir: dir,
      scheduler: makeScheduler(),
      vectorStore: store,
    });
    expect(result.shortcircuited).toBeUndefined();
    expect(result.schedulerNotified).toBe(true);
  });

  it("on+连发同文：第二次提交短路到 pending 占位（蒸馏未落库窗口，跨调用生效）", async () => {
    const store = makeVectorStore(); // 在案为空：第一轮放行
    const first = await run({ cfg: makeCfg(true), vectorStore: store, tsBase: 1_700_000_000_000 });
    expect(first.shortcircuited).toBeUndefined();
    expect(first.schedulerNotified).toBe(true);

    // 新时间戳（否则检查点游标推进 → 第二轮零新消息，闸不适用）
    const second = await run({ cfg: makeCfg(true), vectorStore: store, tsBase: 1_700_000_100_000 });
    expect(second.shortcircuited).toBe(true);
    expect((second.matchedId as string).startsWith("pending:")).toBe(true);
  });

  it("on+getAllL1Texts 抛错：闸降级放行（非致命，不阻塞捕获）", async () => {
    const store = makeVectorStore({
      getAllL1Texts: vi.fn(async () => {
        throw new Error("store read failed");
      }),
    });
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const result = await run({ cfg: makeCfg(true), vectorStore: store, logger });
    expect(result.shortcircuited).toBeUndefined();
    expect(result.schedulerNotified).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("on+getRecentL0Texts 抛错：整体降级放行（fail-safe，与在案读取失败同向）", async () => {
    const store = makeVectorStore({
      getRecentL0Texts: vi.fn(async () => {
        throw new Error("l0 probe failed");
      }),
    });
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const result = await run({ cfg: makeCfg(true), vectorStore: store, logger });
    expect(result.shortcircuited).toBeUndefined();
    expect(result.schedulerNotified).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ── v2（复核修复轮）：sqlite 真库集成（持久近窗/增量种子/大库连发/消息级） ──

describe("performAutoCapture × capture-dedup-gate v2（sqlite 真库）", () => {
  const UT = "2026-10-23T00:00:00.000Z";

  function l1rec(id: string, content: string): MemoryRecord {
    return {
      id,
      content,
      type: "instruction",
      priority: 80,
      scene_name: "闸测试场景",
      source_message_ids: [id],
      metadata: {},
      timestamps: [UT],
      createdAt: UT,
      updatedAt: UT,
      sessionKey: "sess-gate",
      sessionId: "sess-gate",
    } as MemoryRecord;
  }

  async function makeSqliteStore(): Promise<{ store: VectorStore; dir: string }> {
    const dir = mkdtempSync(join(tmpdir(), "tdai-gate-sqlite-"));
    const store = new VectorStore(join(dir, "vectors.db"), 0);
    await store.init();
    return { store, dir };
  }

  function cleanupSqlite(store: VectorStore, dir: string) {
    try { store.close(); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  it("P1-1 大库连发（L1=250>window）：二过闸短路、全量种子仅首拍、增量不重复计数", async () => {
    const { store, dir } = await makeSqliteStore();
    try {
      for (let i = 0; i < 250; i++) await store.upsertL1(l1rec(`m_${i}`, `在案记忆第${i}条内容`));
      const spyAll = vi.spyOn(store, "getAllL1Texts");

      const first = await performAutoCapture({
        messages: makeMessages("大库连发新内容甲", Date.now() - 3600_000),
        sessionKey: "sess-gate",
        cfg: makeCfg(true),
        pluginDataDir: dir,
        scheduler: makeScheduler(),
        vectorStore: store,
      });
      expect(first.shortcircuited).toBeUndefined(); // 首过闸放行
      expect(spyAll).toHaveBeenCalledTimes(1); // 全量种子仅首拍

      const second = await performAutoCapture({
        messages: makeMessages("大库连发新内容甲", Date.now()),
        sessionKey: "sess-gate",
        cfg: makeCfg(true),
        pluginDataDir: dir,
        scheduler: makeScheduler(),
        vectorStore: store,
      });
      expect(second.shortcircuited).toBe(true); // 旧实现：pending 被 250 条种子挤出 200 窗口 → 放行
      expect(spyAll).toHaveBeenCalledTimes(1); // 仍是 1 次：第二批走增量
      expect(captureGateForStore(store).stats().archive).toBe(250); // 增量重种不重复计数
    } finally {
      cleanupSqlite(store, dir);
    }
  });

  it("持久近窗（跨重启）：新 store 实例全量种子后，同文短路到 l0 记录 id（28.9% 冗余的接住点）", async () => {
    const { store, dir } = await makeSqliteStore();
    try {
      // 「上一进程」：捕获 X（放行，写入 l0_conversations；ts 贴近当前——近窗 TTL 锚定真实时间）
      await performAutoCapture({
        messages: makeMessages("跨重启重投的内容", Date.now() - 3600_000),
        sessionKey: "sess-gate",
        cfg: makeCfg(true),
        pluginDataDir: dir,
        scheduler: makeScheduler(),
        vectorStore: store,
      });
      const l0Row = store
        .getAllL0Texts()
        .find((r) => r.message_text === "跨重启重投的内容");
      expect(l0Row).toBeTruthy();

      // 重启模拟：全新 store 实例（WeakMap 新闸）打开同一库
      const store2 = new VectorStore(join(dir, "vectors.db"), 0);
      await store2.init();
      try {
        const touchL1Heat = vi.spyOn(store2, "touchL1Heat").mockResolvedValue(true);
        const result = await performAutoCapture({
          messages: makeMessages("跨重启重投的内容", Date.now()),
          sessionKey: "sess-gate",
          cfg: makeCfg(true),
          pluginDataDir: dir,
          scheduler: makeScheduler(),
          vectorStore: store2,
        });
        expect(result.shortcircuited).toBe(true);
        expect(result.matchedId).toBe(l0Row!.record_id); // 持久近窗命中=真实 L0 记录 id
        expect(touchL1Heat).not.toHaveBeenCalled(); // 持久命中非 L1：不推热度
      } finally {
        store2.close();
      }
    } finally {
      cleanupSqlite(store, dir);
    }
  });

  it("消息级排除（sqlite 真库）：批内[已有 L0, 新内容]→旧消息零向量写入，新消息照常+notify", async () => {
    const { store, dir } = await makeSqliteStore();
    try {
      // 预置「上一批放行」的 L0 行（持久近窗来源）
      await store.upsertL0({
        id: "l0_prev_1",
        sessionKey: "other-session",
        sessionId: "sess-gate",
        role: "user",
        messageText: "批内旧消息内容",
        recordedAt: new Date(Date.now() - 3600_000).toISOString(),
        timestamp: Date.now() - 3600_000,
      });

      const spyUpsert = vi.spyOn(store, "upsertL0");
      const result = await performAutoCapture({
        messages: [
          { role: "user", content: "批内旧消息内容", timestamp: 1_700_000_300_000 },
          { role: "user", content: "批内全新的一句", timestamp: 1_700_000_300_001 },
        ],
        sessionKey: "sess-gate",
        cfg: makeCfg(true),
        pluginDataDir: dir,
        scheduler: makeScheduler(),
        vectorStore: store,
      });
      expect(result.shortcircuited).toBeUndefined(); // 整批不短路（新内容要蒸馏）
      expect(result.schedulerNotified).toBe(true);
      expect(result.gateExcludedCount).toBe(1);
      expect(result.l0VectorsWritten).toBe(1); // 仅新消息
      const upsertTexts = (spyUpsert.mock.calls as Array<[{ messageText: string }]>).map((c) => c[0].messageText);
      expect(upsertTexts).toEqual(["批内全新的一句"]); // 旧消息零重复写入
    } finally {
      cleanupSqlite(store, dir);
    }
  });
});
