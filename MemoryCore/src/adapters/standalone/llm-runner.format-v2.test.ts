// 票⑤（exp/p1-5-scene-format-v2）：本地沙箱（createSandboxedTools，经 StandaloneLLMRunner）
// 的 v2 双层化——与 storage-tools.format-v2.test.ts 同构（枚举面 = 本地 fs）。
// 经 mock ai.generateText 捕获 tools 后直调 execute（同票⑥测试式样）。
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

interface LoggerSpy {
  debug?: (m: string) => void;
  info?: (m: string) => void;
  warn?: (m: string) => void;
  error: (m: string) => void;
  infos: string[];
}

function makeLogger(): LoggerSpy {
  const infos: string[] = [];
  return { info: (m: string) => infos.push(m), error: (m: string) => void m, infos };
}

async function makeRunnerTools(opts: { sceneFormatV2?: boolean; logger?: LoggerSpy }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-formatv2-"));
  const runner = new StandaloneLLMRunner({
    config: CONFIG,
    model: "test-model",
    enableTools: true,
    logger: opts.logger,
  });
  await runner.run({
    systemPrompt: "s",
    prompt: "p",
    taskId: "format-v2-test",
    workspaceDir: dir,
    ...(opts.sceneFormatV2 !== undefined ? { sceneFormatV2: opts.sceneFormatV2 } : {}),
  });
  const tools = (calls[calls.length - 1] as any)?.tools;
  return { dir, tools };
}

const V2_FILE = [
  "-----META-START-----",
  "summary: 旧的流水账摘要",
  "-----META-END-----",
  "",
  "## 要点",
  "沙箱要点。",
  "",
  "## 事实",
  "- 事实 m_1787881381525_2eee472e",
  "",
  "## 活动",
  "归档叙事。",
].join("\n");

describe("沙箱 v2：off 钉 / on 读视图 / 写同步", () => {
  it("off：schema 无 includeArchive；v2 文件原文逐字节返回", async () => {
    const { dir, tools } = await makeRunnerTools({});
    try {
      await fs.writeFile(path.join(dir, "a.md"), V2_FILE, "utf-8");
      expect(JSON.stringify(tools.read.inputSchema)).not.toContain("includeArchive");
      expect(await tools.read.execute({ path: "a.md" })).toBe(V2_FILE);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("on：默认 read = 两层视图（活动段折叠）；includeArchive:true 全量原文", async () => {
    const { dir, tools } = await makeRunnerTools({ sceneFormatV2: true });
    try {
      await fs.writeFile(path.join(dir, "a.md"), V2_FILE, "utf-8");
      expect(JSON.stringify(tools.read.inputSchema)).toContain("includeArchive");
      const def = await tools.read.execute({ path: "a.md" });
      expect(def).toContain("## 要点");
      expect(def).not.toContain("## 活动");
      expect(def.length).toBeLessThan(V2_FILE.length);
      expect(await tools.read.execute({ path: "a.md", includeArchive: true })).toBe(V2_FILE);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("on：write v2 内容 → 落盘字节已同步 META.summary + metric=l2_format_v2", async () => {
    const { dir, tools } = await makeRunnerTools({ sceneFormatV2: true, logger: makeLogger() });
    try {
      await tools.write.execute({ path: "a.md", content: V2_FILE });
      const persisted = await fs.readFile(path.join(dir, "a.md"), "utf-8");
      expect(persisted).toContain("summary: 沙箱要点。");
      expect(persisted).toContain("## 活动");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("on：v1 文件 read/write 均原样（混合语料）", async () => {
    const v1 = "META\n## 用户核心特征\n正文";
    const { dir, tools } = await makeRunnerTools({ sceneFormatV2: true });
    try {
      await fs.writeFile(path.join(dir, "v1.md"), v1, "utf-8");
      expect(await tools.read.execute({ path: "v1.md" })).toBe(v1);
      await tools.write.execute({ path: "n.md", content: v1 });
      expect(await fs.readFile(path.join(dir, "n.md"), "utf-8")).toBe(v1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("on：metric 行仅在 v2 写入时打点一次", async () => {
    const logger = makeLogger();
    const { dir, tools } = await makeRunnerTools({ sceneFormatV2: true, logger });
    try {
      await tools.write.execute({ path: "a.md", content: V2_FILE });
      await tools.write.execute({ path: "v1.md", content: "纯 v1 无段" });
      expect(logger.infos.filter((m) => m.includes("metric=l2_format_v2 value=1"))).toHaveLength(1);
      expect(logger.infos.some((m) => m.includes("path=a.md"))).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
