import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performAutoCapture } from "./auto-capture.js";
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

  it("on+部分未命中（一旧一新）：放行（新内容零误杀）", async () => {
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
    expect(result.shortcircuited).toBeUndefined();
    expect(result.schedulerNotified).toBe(true);
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
});
