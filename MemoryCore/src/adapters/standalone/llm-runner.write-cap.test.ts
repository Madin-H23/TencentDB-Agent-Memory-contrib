// 方案C（exp/l2-plan-c-write-cap）：本地沙箱（createSandboxedTools，经 StandaloneLLMRunner）
// 的 write/edit 写入后像尺寸帽。
//
// 通过 mock ai.generateText 捕获 runner 传给 SDK 的 tools，再直接调用 write/edit.execute，
// 不依赖模型真的发起工具调用。sceneCharCap 由 LLMRunParams 传入（只有 L2 场景抽取装配点传，
// L3 persona 不传 → 不受限）。
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
const { SCENE_CHAR_CAP_HINT } = await import("../../utils/scene-char-cap.js");

const CONFIG = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "test-model",
  maxTokens: 1024,
  timeoutMs: 30_000,
};

async function makeRunnerTools(sceneCharCap?: number) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-write-cap-"));
  const runner = new StandaloneLLMRunner({
    config: CONFIG,
    model: "test-model",
    enableTools: true,
  });
  await runner.run({
    systemPrompt: "s",
    prompt: "p",
    taskId: "write-cap-test",
    workspaceDir: dir,
    ...(sceneCharCap !== undefined ? { sceneCharCap } : {}),
  });
  const tools = (calls[calls.length - 1] as any)?.tools;
  return { dir, tools };
}

function parseOut(out: string): Record<string, unknown> {
  return JSON.parse(out) as Record<string, unknown>;
}

const CAP = 1000;

describe("llm-runner 沙箱 write/edit 写入后像尺寸帽（方案C）", () => {
  it("write 超帽 → 拒绝且不落盘（文件不创建）", async () => {
    const { dir, tools } = await makeRunnerTools(CAP);
    try {
      const out = await tools.write.execute({ path: "s1.md", content: "x".repeat(CAP + 1) });
      expect(parseOut(out).error).toBe("over_scene_char_cap");
      await expect(fs.readFile(path.join(dir, "s1.md"), "utf-8")).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("edit 超帽（后像 1001）→ 拒绝且文件保持原样", async () => {
    const { dir, tools } = await makeRunnerTools(CAP);
    try {
      const original = "A".repeat(990);
      await fs.writeFile(path.join(dir, "s2.md"), original, "utf-8");
      const out = await tools.edit.execute({
        path: "s2.md",
        edits: [{ oldText: "A", newText: "B".repeat(12) }], // 990-1+12=1001
      });
      expect(parseOut(out).error).toBe("over_scene_char_cap");
      expect(await fs.readFile(path.join(dir, "s2.md"), "utf-8")).toBe(original);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("write 帽内（恰好等于帽）→ 放行", async () => {
    const { dir, tools } = await makeRunnerTools(CAP);
    try {
      const out = await tools.write.execute({ path: "s3.md", content: "x".repeat(CAP) });
      expect(parseOut(out).success).toBe(true);
      expect(await fs.readFile(path.join(dir, "s3.md"), "utf-8")).toBe("x".repeat(CAP));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("edit 帽内（后像恰好等于帽）→ 放行", async () => {
    const { dir, tools } = await makeRunnerTools(CAP);
    try {
      await fs.writeFile(path.join(dir, "s4.md"), "A".repeat(990), "utf-8");
      const out = await tools.edit.execute({
        path: "s4.md",
        edits: [{ oldText: "A", newText: "B".repeat(11) }], // 990-1+11=1000
      });
      expect(parseOut(out).success).toBe(true);
      expect(await fs.readFile(path.join(dir, "s4.md"), "utf-8")).toBe("B".repeat(11) + "A".repeat(989));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("write 内容为 '[DELETED]' → 不受帽限制", async () => {
    const { dir, tools } = await makeRunnerTools(5);
    try {
      const out = await tools.write.execute({ path: "s5.md", content: "[DELETED]" });
      expect(parseOut(out).success).toBe(true);
      expect(await fs.readFile(path.join(dir, "s5.md"), "utf-8")).toBe("[DELETED]");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("sceneCharCap 未传（L3 persona 装配路径）→ 关闭", async () => {
    const { dir, tools } = await makeRunnerTools(undefined);
    try {
      const out = await tools.write.execute({ path: "s6.md", content: "x".repeat(50_000) });
      expect(parseOut(out).success).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("sceneCharCap=0 → 关闭", async () => {
    const { dir, tools } = await makeRunnerTools(0);
    try {
      const out = await tools.write.execute({ path: "s7.md", content: "x".repeat(50_000) });
      expect(parseOut(out).success).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("拒绝响应是合法 JSON 且字段完整（含 hint）", async () => {
    const { tools } = await makeRunnerTools(CAP);
    const out = await tools.write.execute({ path: "s8.md", content: "x".repeat(CAP + 7) });
    expect(parseOut(out)).toMatchObject({
      error: "over_scene_char_cap",
      chars: CAP + 7,
      cap: CAP,
      overflow: 7,
      hint: SCENE_CHAR_CAP_HINT,
    });
  });
});
