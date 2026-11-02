// 票④b 前置 A3（exp/p1-4b-semantic-gate）：向量回填接线。
// `embedding_meta` 在 initSchema 末尾即写入新 provider，回填失败后下次重启不会再
// 重试 → 必须在检测到 needsReindex 的同一次启动完成；失败只 warn + 锚点。
import { describe, it, expect, vi } from "vitest";
import { startEmbeddingBackfill } from "./embedding-backfill.js";
import type { IMemoryStore } from "./types.js";
import type { EmbeddingService } from "./embedding.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeEmbedding(): EmbeddingService & { embed: ReturnType<typeof vi.fn> } {
  return {
    embed: vi.fn(async () => new Float32Array([1, 0, 0, 0])),
    embedBatch: vi.fn(async (t: string[]) => t.map(() => new Float32Array(4))),
    getDimensions: () => 4,
    getProviderInfo: () => ({ provider: "mock", model: "mock" }),
    isReady: () => true,
    startWarmup: () => {},
  } as unknown as EmbeddingService & { embed: ReturnType<typeof vi.fn> };
}

function makeStore(impl?: () => Promise<{ l1Count: number; l0Count: number }>) {
  const reindexAll = vi.fn(impl ?? (async () => ({ l1Count: 3, l0Count: 7 })));
  return { store: { reindexAll } as unknown as IMemoryStore, reindexAll };
}

describe("startEmbeddingBackfill", () => {
  it("needsReindex=false → 不触发（返回 undefined、零调用）", () => {
    const { store, reindexAll } = makeStore();
    const p = startEmbeddingBackfill({
      needsReindex: false,
      vectorStore: store,
      embeddingService: makeEmbedding(),
      logger: makeLogger(),
    });
    expect(p).toBeUndefined();
    expect(reindexAll).not.toHaveBeenCalled();
  });

  it("needsReindex=true 但缺 store/embedding → 不触发", () => {
    const logger = makeLogger();
    expect(startEmbeddingBackfill({ needsReindex: true, embeddingService: makeEmbedding(), logger })).toBeUndefined();
    expect(startEmbeddingBackfill({ needsReindex: true, vectorStore: makeStore().store, logger })).toBeUndefined();
  });

  it("needsReindex=true → 调 reindexAll 一次；调用方不 await（非阻塞）", async () => {
    let release!: (v: { l1Count: number; l0Count: number }) => void;
    const deferred = new Promise<{ l1Count: number; l0Count: number }>((res) => { release = res; });
    const { store, reindexAll } = makeStore(() => deferred);
    const emb = makeEmbedding();
    const logger = makeLogger();

    const p = startEmbeddingBackfill({
      needsReindex: true,
      reindexReason: "model: a → b",
      vectorStore: store,
      embeddingService: emb,
      logger,
    });

    expect(p).toBeInstanceOf(Promise);
    expect(reindexAll).toHaveBeenCalledTimes(1);
    // 非阻塞：函数返回时 reindexAll 仍在进行中
    const raced = await Promise.race([p!.then(() => "done"), Promise.resolve("pending")]);
    expect(raced).toBe("pending");

    // embedFn 委托给 embeddingService.embed
    const embedFn = (reindexAll.mock.calls[0] as unknown[])[0] as (t: string) => Promise<Float32Array>;
    await embedFn("文本");
    expect(emb.embed).toHaveBeenCalledWith("文本");

    release({ l1Count: 3, l0Count: 7 });
    await p;
    const anchors = logger.info.mock.calls.map((c) => String(c[0]));
    expect(anchors.some((s) => s.includes("metric=embedding_reindex status=start") && s.includes("model: a → b"))).toBe(true);
    expect(anchors.some((s) => s.includes("metric=embedding_reindex status=ok") && s.includes("l1=3") && s.includes("l0=7"))).toBe(true);
  });

  it("reindexAll 抛错 → 吞掉（promise resolve）+ warn 锚点 status=failed", async () => {
    const { store } = makeStore(async () => { throw new Error("api exploded"); });
    const logger = makeLogger();
    const p = startEmbeddingBackfill({
      needsReindex: true,
      vectorStore: store,
      embeddingService: makeEmbedding(),
      logger,
    });
    await expect(p).resolves.toBeUndefined();
    const warns = logger.warn.mock.calls.map((c) => String(c[0]));
    expect(warns.some((s) => s.includes("metric=embedding_reindex status=failed") && s.includes("api exploded"))).toBe(true);
  });

  it("reindexAll 内部吞错返回全 0（needsReindex=true 下等价全失败）→ status=failed", async () => {
    const { store } = makeStore(async () => ({ l1Count: 0, l0Count: 0 }));
    const logger = makeLogger();
    const p = startEmbeddingBackfill({
      needsReindex: true,
      vectorStore: store,
      embeddingService: makeEmbedding(),
      logger,
    });
    await p;
    const warns = logger.warn.mock.calls.map((c) => String(c[0]));
    expect(warns.some((s) => s.includes("metric=embedding_reindex status=failed"))).toBe(true);
    const infos = logger.info.mock.calls.map((c) => String(c[0]));
    expect(infos.some((s) => s.includes("status=ok"))).toBe(false);
  });

  it("进度每 N 条打一次（默认 100；N=2 时 4 条打 2 次）", async () => {
    const { store, reindexAll } = makeStore(async () => ({ l1Count: 4, l0Count: 0 }));
    reindexAll.mockImplementation(async (_fn: unknown, onProgress?: (d: number, t: number, l: "L1" | "L0") => void) => {
      onProgress?.(1, 4, "L1");
      onProgress?.(2, 4, "L1");
      onProgress?.(3, 4, "L1");
      onProgress?.(4, 4, "L1");
      return { l1Count: 4, l0Count: 0 };
    });
    const logger = makeLogger();
    await startEmbeddingBackfill({
      needsReindex: true, progressEvery: 2,
      vectorStore: store, embeddingService: makeEmbedding(), logger,
    });
    const progress = logger.info.mock.calls.map((c) => String(c[0])).filter((s) => s.includes("status=progress"));
    expect(progress.length).toBe(2);
    expect(progress[0]).toContain("done=2");
    expect(progress[1]).toContain("done=4");
  });

  it("注册进 bgTaskRegistry 并在完成后移除（destroy 前可 drain）", async () => {
    const { store, reindexAll } = makeStore();
    const registry = new Set<Promise<void>>();
    const p = startEmbeddingBackfill({
      needsReindex: true, vectorStore: store, embeddingService: makeEmbedding(),
      logger: makeLogger(), bgTaskRegistry: registry,
    });
    expect(registry.has(p!)).toBe(true);
    await p;
    await Promise.resolve();
    expect(registry.has(p!)).toBe(false);
    expect(reindexAll).toHaveBeenCalledTimes(1);
  });
});
