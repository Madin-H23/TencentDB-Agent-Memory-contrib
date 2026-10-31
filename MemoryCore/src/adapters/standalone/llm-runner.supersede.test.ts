// 票⑥（exp/p1-6-supersede-inval）：本地沙箱（createSandboxedTools，经 StandaloneLLMRunner）
// 的显式失效语义——与 storage-tools.supersede.test.ts 同构（枚举面 = 本地 fs）。
// 经 mock ai.generateText 捕获 tools 后直调 execute（同方案C 测试式样）。
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
  warns: string[];
}

function makeLogger(): LoggerSpy {
  const infos: string[] = [];
  const warns: string[] = [];
  return {
    info: (m: string) => infos.push(m),
    warn: (m: string) => warns.push(m),
    error: (m: string) => void m,
    infos,
    warns,
  };
}

async function makeRunnerTools(opts: { explicitInvalidation?: boolean; sceneCharCap?: number; logger?: LoggerSpy }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-supersede-"));
  const runner = new StandaloneLLMRunner({
    config: CONFIG,
    model: "test-model",
    enableTools: true,
    logger: opts.logger,
  });
  await runner.run({
    systemPrompt: "s",
    prompt: "p",
    taskId: "supersede-test",
    workspaceDir: dir,
    ...(opts.sceneCharCap !== undefined ? { sceneCharCap: opts.sceneCharCap } : {}),
    ...(opts.explicitInvalidation !== undefined ? { explicitInvalidation: opts.explicitInvalidation } : {}),
  });
  const tools = (calls[calls.length - 1] as any)?.tools;
  return { dir, tools };
}

function parseOut(out: string): Record<string, unknown> {
  return JSON.parse(out) as Record<string, unknown>;
}

const MARK = "[SUPERSEDED 2026-10-31T10:00:00.000Z]";
const SCENE_A = "## 叙事\n- 旧事实 m_1787881381525_2eee472e\n尾行";

describe("沙箱 read：off 钉 / on 过滤", () => {
  it("off：schema 无 includeInvalidated；含失效行原文逐字节返回", async () => {
    const { dir, tools } = await makeRunnerTools({});
    try {
      const raw = `A\n${MARK} B\nC`;
      await fs.writeFile(path.join(dir, "a.md"), raw, "utf-8");
      expect(JSON.stringify(tools.read.inputSchema)).not.toContain("includeInvalidated");
      const out = await tools.read.execute({ path: "a.md" });
      expect(out).toBe(raw);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("on：默认过滤失效行；includeInvalidated:true 全量逐字", async () => {
    const { dir, tools } = await makeRunnerTools({ explicitInvalidation: true });
    try {
      const raw = `A\n${MARK} B m_1787881381525_2eee472e\nC`;
      await fs.writeFile(path.join(dir, "a.md"), raw, "utf-8");
      expect(JSON.stringify(tools.read.inputSchema)).toContain("includeInvalidated");
      expect(await tools.read.execute({ path: "a.md" })).toBe("A\nC");
      expect(await tools.read.execute({ path: "a.md", includeInvalidated: true })).toBe(raw);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("沙箱 write/edit：锚点守卫", () => {
  it("off：edit 删锚点行照常成功（基线行为）", async () => {
    const { dir, tools } = await makeRunnerTools({});
    try {
      await fs.writeFile(path.join(dir, "a.md"), SCENE_A, "utf-8");
      const out = await tools.edit.execute({ path: "a.md", edits: [{ oldText: "- 旧事实 m_1787881381525_2eee472e\n", newText: "" }] });
      expect(parseOut(out).success).toBe(true);
      expect(await fs.readFile(path.join(dir, "a.md"), "utf-8")).toBe("## 叙事\n尾行");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("on：edit 丢锚 → anchor_loss_forbidden 且文件原样；加 [SUPERSEDED] 前缀放行", async () => {
    const { dir, tools } = await makeRunnerTools({ explicitInvalidation: true });
    try {
      await fs.writeFile(path.join(dir, "a.md"), SCENE_A, "utf-8");
      const out = await tools.edit.execute({ path: "a.md", edits: [{ oldText: "- 旧事实 m_1787881381525_2eee472e\n", newText: "" }] });
      expect(parseOut(out).error).toBe("anchor_loss_forbidden");
      expect(await fs.readFile(path.join(dir, "a.md"), "utf-8")).toBe(SCENE_A);

      const out2 = await tools.edit.execute({
        path: "a.md",
        edits: [{ oldText: "- 旧事实 m_1787881381525_2eee472e", newText: `${MARK} - 旧事实 m_1787881381525_2eee472e` }],
      });
      expect(parseOut(out2).success).toBe(true);
      expect(await fs.readFile(path.join(dir, "a.md"), "utf-8")).toBe(`## 叙事\n${MARK} - 旧事实 m_1787881381525_2eee472e\n尾行`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("on：write 整体重写丢锚拒绝且不落盘；新建文件不受限", async () => {
    const { dir, tools } = await makeRunnerTools({ explicitInvalidation: true });
    try {
      await fs.writeFile(path.join(dir, "a.md"), SCENE_A, "utf-8");
      const out = await tools.write.execute({ path: "a.md", content: "全新内容无锚" });
      expect(parseOut(out).error).toBe("anchor_loss_forbidden");
      expect(await fs.readFile(path.join(dir, "a.md"), "utf-8")).toBe(SCENE_A);
      expect(parseOut(await tools.write.execute({ path: "new.md", content: "新建" })).success).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("on：[DELETED] 锚点未迁移 → 拒绝且文件保持原内容；已迁移 → 放行", async () => {
    const { dir, tools } = await makeRunnerTools({ explicitInvalidation: true });
    try {
      await fs.writeFile(path.join(dir, "a.md"), SCENE_A, "utf-8");
      await fs.writeFile(path.join(dir, "b.md"), "无关场景", "utf-8");
      const out = await tools.write.execute({ path: "a.md", content: "[DELETED]" });
      expect(parseOut(out).error).toBe("anchor_loss_forbidden");
      expect(await fs.readFile(path.join(dir, "a.md"), "utf-8")).toBe(SCENE_A);

      await fs.writeFile(path.join(dir, "b.md"), `合并目标\n${MARK} - 旧事实 m_1787881381525_2eee472e`, "utf-8");
      const out2 = await tools.write.execute({ path: "a.md", content: "[DELETED]" });
      expect(parseOut(out2).success).toBe(true);
      expect(await fs.readFile(path.join(dir, "a.md"), "utf-8")).toBe("[DELETED]");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("沙箱 metric 与失效帽排除口径", () => {
  it("on：edit 引入失效行 → metric=l2_supersede value 正确；off → 零 metric", async () => {
    const base = "- 旧1 m_1787881381525_2eee472e\n- 旧2 m_1788449899823_245dfba6\n";
    const logger = makeLogger();
    const { dir, tools } = await makeRunnerTools({ explicitInvalidation: true, logger });
    try {
      await fs.writeFile(path.join(dir, "a.md"), base, "utf-8");
      await tools.edit.execute({
        path: "a.md",
        edits: [{ oldText: "- 旧1 m_1787881381525_2eee472e", newText: `${MARK} - 旧1 m_1787881381525_2eee472e` }],
      });
      expect(logger.infos.filter((m) => m.includes("metric=l2_supersede value=1")).length).toBe(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }

    const logger2 = makeLogger();
    const { dir: dir2, tools: tools2 } = await makeRunnerTools({ logger: logger2 });
    try {
      await fs.writeFile(path.join(dir2, "a.md"), base, "utf-8");
      await tools2.edit.execute({
        path: "a.md",
        edits: [{ oldText: "- 旧1 m_1787881381525_2eee472e", newText: `${MARK} - 旧1 m_1787881381525_2eee472e` }],
      });
      expect(logger2.infos.some((m) => m.includes("metric="))).toBe(false);
    } finally {
      await fs.rm(dir2, { recursive: true, force: true });
    }
  });

  it("on：失效多活内容小放行（帽 100）；活超帽拒绝体带 superseded 键", async () => {
    const dead = Array.from({ length: 50 }, (_, i) => `${MARK} 旧事实${i}`).join("\n");
    const { dir, tools } = await makeRunnerTools({ explicitInvalidation: true, sceneCharCap: 100 });
    try {
      expect(parseOut(await tools.write.execute({ path: "a.md", content: `${dead}\nlive` })).success).toBe(true);
      const r = parseOut(await tools.write.execute({ path: "b.md", content: `${dead}\n${"y".repeat(150)}` }));
      expect(r.error).toBe("over_scene_char_cap");
      expect(r.chars).toBe(150);
      expect(r.supersededLines).toBe(50);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
