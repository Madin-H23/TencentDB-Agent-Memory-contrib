// 票 TICKETS-C-read-dedup-20261113.md（T3）：storage-tools 接线测试。
// 口径：off（缺省）=schema 与行为逐字节不变；shadow=只打 metric 行为不变；
// on=同参二次读返回缓存且不计 read-budget run 累计；write/edit 失效同 key 缓存。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageTools } from "./storage-tools.js";
import type { L2ReadDedupConfig } from "../../utils/read-dedup.js";

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** 可变内容 storage（write 真改内容，模拟真实语义）。 */
function makeMutableStorage(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  return {
    readFile: vi.fn(async (key: string) => files.get(key) ?? null),
    writeFile: vi.fn(async (key: string, content: string) => {
      files.set(key, content);
    }),
    files,
  } as any;
}

function debugLines(logger: ReturnType<typeof makeLogger>): string[] {
  return logger.debug.mock.calls.map((c) => String(c[0]));
}

const CONTENT = "alpha\nbeta\ngamma\n".repeat(10);

describe("storage-tools read 去重：off（缺省）", () => {
  it("不传配置：行为与基线逐字节一致、无 read-dedup 锚点行", async () => {
    const logger = makeLogger();
    const storage = makeMutableStorage({ "scene_blocks/a.md": CONTENT });
    const tools = createStorageTools(storage, "scene_blocks/", logger, "task-1");
    const out1 = await (tools.read as any).execute({ path: "a.md" });
    const out2 = await (tools.read as any).execute({ path: "a.md" });
    expect(out1).toBe(CONTENT);
    expect(out2).toBe(CONTENT);
    expect(debugLines(logger).some((l) => l.includes("read-dedup"))).toBe(false);
  });
});

describe("storage-tools read 去重：shadow", () => {
  const cfg: L2ReadDedupConfig = { mode: "shadow" };

  it("重复读输出仍逐字节一致（零行为变化），但打 read-dedup metric", async () => {
    const logger = makeLogger();
    const storage = makeMutableStorage({ "scene_blocks/a.md": CONTENT });
    const tools = createStorageTools(storage, "scene_blocks/", logger, "task-1", undefined, undefined, undefined, cfg);
    const out1 = await (tools.read as any).execute({ path: "a.md" });
    const out2 = await (tools.read as any).execute({ path: "a.md" });
    expect(out1).toBe(CONTENT);
    expect(out2).toBe(CONTENT);
    const lines = debugLines(logger).filter((l) => l.includes("read-dedup"));
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("would_dedup=false");
    expect(lines[1]).toContain("would_dedup=true");
    expect(lines[1]).toContain(`saved_chars=${CONTENT.length}`);
  });

  it("同文件不同窗口 → 不同键不命中", async () => {
    const logger = makeLogger();
    const storage = makeMutableStorage({ "scene_blocks/a.md": CONTENT });
    const tools = createStorageTools(storage, "scene_blocks/", logger, "task-1", undefined, undefined, undefined, cfg);
    await (tools.read as any).execute({ path: "a.md", offset: 0, limit: 10 });
    await (tools.read as any).execute({ path: "a.md", offset: 5, limit: 10 });
    const lines = debugLines(logger).filter((l) => l.includes("read-dedup"));
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.includes("would_dedup=false"))).toBe(true);
  });
});

describe("storage-tools read 去重：on", () => {
  const cfg: L2ReadDedupConfig = { mode: "on" };

  it("同参二次读返回缓存字节串；storage.readFile 只被调一次", async () => {
    const logger = makeLogger();
    const storage = makeMutableStorage({ "scene_blocks/a.md": CONTENT });
    const tools = createStorageTools(storage, "scene_blocks/", logger, "task-1", undefined, undefined, undefined, cfg);
    const out1 = await (tools.read as any).execute({ path: "a.md" });
    const out2 = await (tools.read as any).execute({ path: "a.md" });
    expect(out1).toBe(CONTENT);
    expect(out2).toBe(CONTENT);
    expect(storage.readFile).toHaveBeenCalledTimes(1);
  });

  it("on 命中不计 read-budget run 累计（三次同参读只计一次）", async () => {
    const logger = makeLogger();
    // 每次读 30K：off 时三次 = 90K 破 80K run 帽（crossed_run 出现）；on 时只计 30K 不破
    const big = "x".repeat(30_000);
    const storage = makeMutableStorage({ "scene_blocks/a.md": big });
    const toolsOn = createStorageTools(storage, "scene_blocks/", logger, "task-1", undefined, undefined, undefined, cfg);
    await (toolsOn.read as any).execute({ path: "a.md" });
    await (toolsOn.read as any).execute({ path: "a.md" });
    await (toolsOn.read as any).execute({ path: "a.md" });
    const warnLines = logger.warn.mock.calls.map((c) => String(c[0]));
    expect(warnLines.some((l) => l.includes("crossed_run=true"))).toBe(false);

    const logger2 = makeLogger();
    const storage2 = makeMutableStorage({ "scene_blocks/a.md": big });
    const toolsOff = createStorageTools(storage2, "scene_blocks/", logger2, "task-1");
    await (toolsOff.read as any).execute({ path: "a.md" });
    await (toolsOff.read as any).execute({ path: "a.md" });
    await (toolsOff.read as any).execute({ path: "a.md" });
    const warnLines2 = logger2.warn.mock.calls.map((c) => String(c[0]));
    expect(warnLines2.some((l) => l.includes("crossed_run=true"))).toBe(true);
  });

  it("write 后同参读失效：拿到新内容（不命中陈旧缓存）", async () => {
    const logger = makeLogger();
    const storage = makeMutableStorage({ "scene_blocks/a.md": CONTENT });
    const tools = createStorageTools(storage, "scene_blocks/", logger, "task-1", undefined, undefined, undefined, cfg);
    await (tools.read as any).execute({ path: "a.md" });
    const NEW = "全新内容\n";
    await (tools.write as any).execute({ path: "a.md", content: NEW });
    const out = await (tools.read as any).execute({ path: "a.md" });
    expect(out).toBe(NEW);
  });

  it("edit 后同参读失效", async () => {
    const logger = makeLogger();
    const storage = makeMutableStorage({ "scene_blocks/a.md": CONTENT });
    const tools = createStorageTools(storage, "scene_blocks/", logger, "task-1", undefined, undefined, undefined, cfg);
    await (tools.read as any).execute({ path: "a.md" });
    // edit 工具存在性：不管其实现细节，只要调 invalidate 就行——此处直接验证 edit 后 read 不返回旧缓存
    if ((tools as any).edit) {
      await (tools.edit as any).execute({ path: "a.md", edits: [{ oldText: "alpha", newText: "ALPHA" }] });
      const out = await (tools.read as any).execute({ path: "a.md" });
      expect(out).toContain("ALPHA");
    }
  });

  it("on 模式 metric 行含 would_dedup=true 与 dedup_count 递增", async () => {
    const logger = makeLogger();
    const storage = makeMutableStorage({ "scene_blocks/a.md": CONTENT });
    const tools = createStorageTools(storage, "scene_blocks/", logger, "task-1", undefined, undefined, undefined, cfg);
    await (tools.read as any).execute({ path: "a.md" });
    await (tools.read as any).execute({ path: "a.md" });
    const lines = debugLines(logger).filter((l) => l.includes("read-dedup"));
    expect(lines[1]).toContain("would_dedup=true");
    expect(lines[1]).toContain("dedup_count=1");
  });

  it("不同文件互不干扰", async () => {
    const logger = makeLogger();
    const storage = makeMutableStorage({
      "scene_blocks/a.md": CONTENT,
      "scene_blocks/b.md": "其他文件\n",
    });
    const tools = createStorageTools(storage, "scene_blocks/", logger, "task-1", undefined, undefined, undefined, cfg);
    await (tools.read as any).execute({ path: "a.md" });
    const outB = await (tools.read as any).execute({ path: "b.md" });
    expect(outB).toBe("其他文件\n");
  });
});
