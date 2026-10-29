// 方案B：read 分段读（offset/limit 字符窗口）—— llm-runner 沙箱侧。
//
// 与 storage-tools.read-window.test.ts 语义同构：
//   1) 兼容钉：无 offset/limit 默认调用 = 旧实现逐字节一致（旧成功路径 = 原样返回全文）；
//   2) offset/limit 切片与标注格式；
//   3) 越界安全；
//   4) read-budget 计量口径不变（observe 记实际返回 chars，含标注行）；
//   5) 大文件（200KB）分段读。
//
// 通过 mock ai.generateText 捕获 runner 传给 SDK 的 tools，再直接调用 read.execute，
// 不依赖模型真的发起工具调用。
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const calls: Array<Record<string, unknown>> = [];

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(async (params: Record<string, unknown>) => {
      calls.push(params);
      return { text: "ok", usage: {}, steps: [] };
    }),
    streamText: vi.fn((params: Record<string, unknown>) => {
      calls.push(params);
      const result = {
        text: Promise.resolve("ok"),
        totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
        steps: Promise.resolve([]),
      };
      return Object.assign(Promise.resolve(result), result);
    }),
  };
});

const { StandaloneLLMRunner } = await import("./llm-runner.js");

const CONFIG = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "test-model",
  maxTokens: 1024,
  timeoutMs: 30_000,
};

/** 旧实现（改动前）的 read 成功路径返回值：逐字返回全文，无任何追加。 */
async function oldReadReturn(content: string): Promise<string> {
  return content;
}

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function withSandbox(contentByFile: Record<string, string>, fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-read-window-"));
  try {
    for (const [name, content] of Object.entries(contentByFile)) {
      await fs.writeFile(path.join(dir, name), content, "utf-8");
    }
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function getReadTool(dir: string, logger: ReturnType<typeof makeLogger>) {
  const runner = new StandaloneLLMRunner({
    config: CONFIG,
    model: "test-model",
    enableTools: true,
    logger,
  });
  await runner.run({ systemPrompt: "s", prompt: "p", workspaceDir: dir });
  const tools = (calls[calls.length - 1] as any)?.tools;
  expect(tools?.read?.execute).toBeTypeOf("function");
  return tools.read;
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

describe("llm-runner 沙箱 read 兼容钉（无 offset/limit = 旧实现逐字节一致）", () => {
  for (const { name, content } of CORPUS) {
    it(`默认调用逐字节一致：${name}`, async () => {
      await withSandbox({ "f.md": content }, async (dir) => {
        const logger = makeLogger();
        const read = await getReadTool(dir, logger);
        const out = await read.execute({ path: "f.md" });
        expect(out).toBe(await oldReadReturn(content));
      });
    });
  }
});

describe("llm-runner 沙箱 read 分段读（offset/limit）", () => {
  it("offset+limit 切片正确并追加标注", async () => {
    await withSandbox({ "f.md": "0123456789" }, async (dir) => {
      const read = await getReadTool(dir, makeLogger());
      const out = await read.execute({ path: "f.md", offset: 3, limit: 4 });
      expect(out).toBe("3456\n[... omitted 6 chars, offset=3 limit=4 of 10 total ...]");
    });
  });

  it("只传 offset：读到文件尾，标注含生效 limit", async () => {
    await withSandbox({ "f.md": "0123456789" }, async (dir) => {
      const read = await getReadTool(dir, makeLogger());
      const out = await read.execute({ path: "f.md", offset: 7 });
      expect(out).toBe("789\n[... omitted 7 chars, offset=7 limit=3 of 10 total ...]");
    });
  });

  it("只传 limit：从头截取", async () => {
    await withSandbox({ "f.md": "0123456789" }, async (dir) => {
      const read = await getReadTool(dir, makeLogger());
      const out = await read.execute({ path: "f.md", limit: 5 });
      expect(out).toBe("01234\n[... omitted 5 chars, offset=0 limit=5 of 10 total ...]");
    });
  });

  it("中段截取：标注 N = 前后省略字符总数", async () => {
    await withSandbox({ "f.md": "a".repeat(1000) }, async (dir) => {
      const read = await getReadTool(dir, makeLogger());
      const out = await read.execute({ path: "f.md", offset: 200, limit: 300 });
      expect(out).toBe(`${"a".repeat(300)}\n[... omitted 700 chars, offset=200 limit=300 of 1000 total ...]`);
    });
  });

  it("offset 越界（= 总长）返回空串+标注", async () => {
    await withSandbox({ "f.md": "0123456789" }, async (dir) => {
      const read = await getReadTool(dir, makeLogger());
      const out = await read.execute({ path: "f.md", offset: 10 });
      expect(out).toBe("[... omitted 10 chars, offset=10 limit=0 of 10 total ...]");
    });
  });

  it("offset 越界（> 总长）返回空串+标注", async () => {
    await withSandbox({ "f.md": "0123456789" }, async (dir) => {
      const read = await getReadTool(dir, makeLogger());
      const out = await read.execute({ path: "f.md", offset: 42 });
      expect(out).toBe("[... omitted 10 chars, offset=42 limit=0 of 10 total ...]");
    });
  });

  it("offset=0 且 limit=总长：全文无标注（未截断）", async () => {
    await withSandbox({ "f.md": "0123456789" }, async (dir) => {
      const read = await getReadTool(dir, makeLogger());
      const out = await read.execute({ path: "f.md", offset: 0, limit: 10 });
      expect(out).toBe("0123456789");
    });
  });

  it("limit 超过总长：全文无标注", async () => {
    await withSandbox({ "f.md": "0123456789" }, async (dir) => {
      const read = await getReadTool(dir, makeLogger());
      const out = await read.execute({ path: "f.md", limit: 99 });
      expect(out).toBe("0123456789");
    });
  });

  it("负 offset 视为 0：全文无标注", async () => {
    await withSandbox({ "f.md": "0123456789" }, async (dir) => {
      const read = await getReadTool(dir, makeLogger());
      const out = await read.execute({ path: "f.md", offset: -5 });
      expect(out).toBe("0123456789");
    });
  });

  it("负 limit 视为 0：空串+标注", async () => {
    await withSandbox({ "f.md": "0123456789" }, async (dir) => {
      const read = await getReadTool(dir, makeLogger());
      const out = await read.execute({ path: "f.md", limit: -3 });
      expect(out).toBe("[... omitted 10 chars, offset=0 limit=0 of 10 total ...]");
    });
  });

  it("CJK 按 UTF-16 码元切片", async () => {
    await withSandbox({ "f.md": "零一二三四五六七八九" }, async (dir) => {
      const read = await getReadTool(dir, makeLogger());
      const out = await read.execute({ path: "f.md", offset: 3, limit: 4 });
      expect(out).toBe("三四五六\n[... omitted 6 chars, offset=3 limit=4 of 10 total ...]");
    });
  });

  it("代理对中间切分外扩到码点边界（P2 穿透）：offset=1 limit=1 返回整对 👍", async () => {
    await withSandbox({ "f.md": "a👍b🎉c" }, async (dir) => {
      const read = await getReadTool(dir, makeLogger());
      const out = await read.execute({ path: "f.md", offset: 1, limit: 1 });
      expect(out).toBe("👍\n[... omitted 5 chars, offset=1 limit=2 of 7 total ...]");
    });
  });

  it("大文件（200KB）分段读切片精确", async () => {
    const big = Array.from({ length: 20_000 }, (_, i) => `line-${i}`).join("\n");
    await withSandbox({ "big.md": big }, async (dir) => {
      const read = await getReadTool(dir, makeLogger());
      const out = await read.execute({ path: "big.md", offset: 1000, limit: 2000 });
      const expectedSlice = big.slice(1000, 3000);
      const omitted = big.length - 2000;
      expect(out).toBe(
        `${expectedSlice}\n[... omitted ${omitted} chars, offset=1000 limit=2000 of ${big.length} total ...]`,
      );
    });
  });

  it("空文件默认调用返回空串", async () => {
    await withSandbox({ "empty.md": "" }, async (dir) => {
      const read = await getReadTool(dir, makeLogger());
      const out = await read.execute({ path: "empty.md" });
      expect(out).toBe("");
    });
  });
});

describe("llm-runner 沙箱 read 分段读的计量与日志（口径不变）", () => {
  it("read-budget observe 记实际返回 chars（含标注行），分段读不触发 over_file", async () => {
    const big = Array.from({ length: 20_000 }, (_, i) => `line-${i}`).join("\n");
    await withSandbox({ "big.md": big }, async (dir) => {
      const logger = makeLogger();
      const read = await getReadTool(dir, logger);
      const out = await read.execute({ path: "big.md", offset: 1000, limit: 2000 });
      const budgetLine = debugLines(logger).find((l) => l.includes("read-budget"));
      expect(budgetLine).toBeDefined();
      expect(budgetLine).toContain(`chars=${out.length}`);
      expect(budgetLine).toContain("over_file=false");
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  it("首个 debug 行仍记文件总 chars（日志格式不变）", async () => {
    await withSandbox({ "f.md": "0123456789" }, async (dir) => {
      const logger = makeLogger();
      const read = await getReadTool(dir, logger);
      await read.execute({ path: "f.md", offset: 3, limit: 4 });
      expect(debugLines(logger).some((l) => l.includes(`read: "f.md" → 10 chars`))).toBe(true);
    });
  });

  it("默认调用（33K）仍触发 over_file=true 告警（口径不变）", async () => {
    const big = "x".repeat(33_000);
    await withSandbox({ "big.md": big }, async (dir) => {
      const logger = makeLogger();
      const read = await getReadTool(dir, logger);
      const out = await read.execute({ path: "big.md" });
      expect(out).toBe(big);
      const lines = logger.warn.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes("read-budget") && l.includes("over_file=true"))).toBe(true);
    });
  });
});
