// 方案B：read 分段读（offset/limit 字符窗口）—— storage-tools 侧。
//
// 兼容钉（最重要）：无 offset/limit 的默认调用必须与旧实现逐字节一致。
// 旧实现（改动前 storage-tools.ts read execute 成功路径）的返回值语义：
//   文件存在 → 原样返回全文，无任何追加。
// 本文件同时覆盖：
//   1) 默认调用 = 旧实现（语料逐项对比，含空文件/CJK/emoji/形似标注内容）；
//   2) offset/limit 切片与标注格式；
//   3) 越界安全；
//   4) read-budget 计量口径不变（observe 记实际返回 chars，含标注行）；
//   5) 大文件（200KB）分段读。
import { describe, expect, it, vi } from "vitest";
import { createStorageTools } from "./storage-tools.js";

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeStorage(content: string) {
  return {
    readFile: vi.fn(async () => content),
    writeFile: vi.fn(async () => {}),
  } as any;
}

/** 旧实现（改动前）的 read 成功路径返回值：逐字返回全文，无任何追加。 */
async function oldReadReturn(content: string): Promise<string> {
  return content;
}

function debugLines(logger: ReturnType<typeof makeLogger>): string[] {
  return logger.debug.mock.calls.map((c) => String(c[0]));
}

const CORPUS: Array<{ name: string; content: string }> = [
  { name: "空文件", content: "" },
  { name: "短 ASCII", content: "hello world" },
  { name: "多行+尾换行", content: "line1\nline2\nline3\n" },
  { name: "CJK", content: "零一二三四五六七八九" },
  { name: "emoji（代理对）", content: "a👍b🎉c" },
  { name: "内容本身形似截断标注", content: "abc[... omitted 1 chars, offset=0 limit=1 of 2 total ...]xyz" },
  { name: "32K 整", content: "x".repeat(32_000) },
];

describe("storage-tools read 兼容钉（无 offset/limit = 旧实现逐字节一致）", () => {
  for (const { name, content } of CORPUS) {
    it(`默认调用逐字节一致：${name}`, async () => {
      const tools = createStorageTools(makeStorage(content), "scene_blocks/", makeLogger());
      const out = await (tools.read as any).execute({ path: "f.md" });
      expect(out).toBe(await oldReadReturn(content));
    });
  }

  it("默认调用（只传 path）不追加任何截断标注", async () => {
    const content = "abc[... omitted 1 chars, offset=0 limit=1 of 2 total ...]xyz";
    const tools = createStorageTools(makeStorage(content), "scene_blocks/", makeLogger());
    const out = await (tools.read as any).execute({ path: "f.md" });
    expect(out).toBe(content);
  });
});

describe("storage-tools read 分段读（offset/limit）", () => {
  const content = "0123456789";

  it("offset+limit 切片正确并追加标注", async () => {
    const tools = createStorageTools(makeStorage(content), "scene_blocks/", makeLogger());
    const out = await (tools.read as any).execute({ path: "f.md", offset: 3, limit: 4 });
    expect(out).toBe("3456\n[... omitted 6 chars, offset=3 limit=4 of 10 total ...]");
  });

  it("只传 offset：读到文件尾，标注含生效 limit", async () => {
    const tools = createStorageTools(makeStorage(content), "scene_blocks/", makeLogger());
    const out = await (tools.read as any).execute({ path: "f.md", offset: 7 });
    expect(out).toBe("789\n[... omitted 7 chars, offset=7 limit=3 of 10 total ...]");
  });

  it("只传 limit：从头截取", async () => {
    const tools = createStorageTools(makeStorage(content), "scene_blocks/", makeLogger());
    const out = await (tools.read as any).execute({ path: "f.md", limit: 5 });
    expect(out).toBe("01234\n[... omitted 5 chars, offset=0 limit=5 of 10 total ...]");
  });

  it("中段截取：标注 N = 前后省略字符总数", async () => {
    const big = "a".repeat(1000);
    const tools = createStorageTools(makeStorage(big), "scene_blocks/", makeLogger());
    const out = await (tools.read as any).execute({ path: "f.md", offset: 200, limit: 300 });
    expect(out).toBe(`${"a".repeat(300)}\n[... omitted 700 chars, offset=200 limit=300 of 1000 total ...]`);
  });

  it("offset 越界（= 总长）返回空串+标注", async () => {
    const tools = createStorageTools(makeStorage(content), "scene_blocks/", makeLogger());
    const out = await (tools.read as any).execute({ path: "f.md", offset: 10 });
    expect(out).toBe("[... omitted 10 chars, offset=10 limit=0 of 10 total ...]");
  });

  it("offset 越界（> 总长）返回空串+标注", async () => {
    const tools = createStorageTools(makeStorage(content), "scene_blocks/", makeLogger());
    const out = await (tools.read as any).execute({ path: "f.md", offset: 42 });
    expect(out).toBe("[... omitted 10 chars, offset=42 limit=0 of 10 total ...]");
  });

  it("offset=0 且 limit=总长：全文无标注（未截断）", async () => {
    const tools = createStorageTools(makeStorage(content), "scene_blocks/", makeLogger());
    const out = await (tools.read as any).execute({ path: "f.md", offset: 0, limit: 10 });
    expect(out).toBe(content);
  });

  it("limit 超过总长：全文无标注", async () => {
    const tools = createStorageTools(makeStorage(content), "scene_blocks/", makeLogger());
    const out = await (tools.read as any).execute({ path: "f.md", limit: 99 });
    expect(out).toBe(content);
  });

  it("负 offset 视为 0：全文无标注", async () => {
    const tools = createStorageTools(makeStorage(content), "scene_blocks/", makeLogger());
    const out = await (tools.read as any).execute({ path: "f.md", offset: -5 });
    expect(out).toBe(content);
  });

  it("负 limit 视为 0：空串+标注", async () => {
    const tools = createStorageTools(makeStorage(content), "scene_blocks/", makeLogger());
    const out = await (tools.read as any).execute({ path: "f.md", limit: -3 });
    expect(out).toBe("[... omitted 10 chars, offset=0 limit=0 of 10 total ...]");
  });

  it("CJK 按 UTF-16 码元切片", async () => {
    const cjk = "零一二三四五六七八九";
    const tools = createStorageTools(makeStorage(cjk), "scene_blocks/", makeLogger());
    const out = await (tools.read as any).execute({ path: "f.md", offset: 3, limit: 4 });
    expect(out).toBe("三四五六\n[... omitted 6 chars, offset=3 limit=4 of 10 total ...]");
  });

  it("代理对中间切分外扩到码点边界（P2 穿透）：offset=1 limit=1 返回整对 👍", async () => {
    const tools = createStorageTools(makeStorage("a👍b🎉c"), "scene_blocks/", makeLogger());
    const out = await (tools.read as any).execute({ path: "f.md", offset: 1, limit: 1 });
    expect(out).toBe("👍\n[... omitted 5 chars, offset=1 limit=2 of 7 total ...]");
  });

  it("大文件（200KB）分段读切片精确", async () => {
    const big = Array.from({ length: 20_000 }, (_, i) => `line-${i}`).join("\n");
    const tools = createStorageTools(makeStorage(big), "scene_blocks/", makeLogger());
    const out = await (tools.read as any).execute({ path: "big.md", offset: 1000, limit: 2000 });
    const expectedSlice = big.slice(1000, 3000);
    const omitted = big.length - 2000;
    expect(out).toBe(`${expectedSlice}\n[... omitted ${omitted} chars, offset=1000 limit=2000 of ${big.length} total ...]`);
  });

  it("空文件默认调用返回空串", async () => {
    const tools = createStorageTools(makeStorage(""), "scene_blocks/", makeLogger());
    const out = await (tools.read as any).execute({ path: "empty.md" });
    expect(out).toBe("");
  });
});

describe("storage-tools read 分段读的计量与日志（口径不变）", () => {
  it("read-budget observe 记实际返回 chars（含标注行），分段读不触发 over_file", async () => {
    const big = Array.from({ length: 20_000 }, (_, i) => `line-${i}`).join("\n");
    const logger = makeLogger();
    const tools = createStorageTools(makeStorage(big), "scene_blocks/", logger);
    const out = await (tools.read as any).execute({ path: "big.md", offset: 1000, limit: 2000 });
    const budgetLine = debugLines(logger).find((l) => l.includes("read-budget"));
    expect(budgetLine).toBeDefined();
    expect(budgetLine).toContain(`chars=${out.length}`);
    expect(budgetLine).toContain("over_file=false");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("首个 debug 行仍记文件总 chars（日志格式不变）", async () => {
    const content = "0123456789";
    const logger = makeLogger();
    const tools = createStorageTools(makeStorage(content), "scene_blocks/", logger);
    await (tools.read as any).execute({ path: "f.md", offset: 3, limit: 4 });
    expect(debugLines(logger).some((l) => l.includes(`read: "f.md" → ${content.length} chars`))).toBe(true);
  });

  it("默认调用（33K）仍触发 over_file=true 告警（口径不变）", async () => {
    const logger = makeLogger();
    const tools = createStorageTools(makeStorage("x".repeat(33_000)), "scene_blocks/", logger);
    const out = await (tools.read as any).execute({ path: "big.md" });
    expect(out).toBe("x".repeat(33_000));
    const lines = logger.warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("read-budget") && l.includes("over_file=true"))).toBe(true);
  });
});
