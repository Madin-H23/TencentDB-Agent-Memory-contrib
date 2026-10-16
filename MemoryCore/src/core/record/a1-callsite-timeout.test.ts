// A1（2026-10-16，继续中断的 A/B/C）：调用点不得硬编码 timeoutMs=180_000。
// 历史（v2 7a93b9d 教训）：runner 曾写死 180s，小于 yaml 各层 timeoutMs（l1 300s/
// dedup 240s/l2·l3 600s），所有超时配置自 10-09 起实为虚设；v3 移植时 extractor
// 两处与 persona 一处又带回 180_000 硬编码——10-15 晚 persona 连续三次整 180s
// 中止即此。修法：删硬编码，回落 params.timeoutMs ?? config.timeoutMs（分层解析
// 值：l1 300s / l3 600s），由 llm-runner.ts:376 的优先级链兑现。
// 本文件钉「调用点不再传 timeoutMs」——用假 runner 捕获实传参数。
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractL1Memories } from "./l1-extractor.js";
import { PersonaGenerator } from "../persona/persona-generator.js";
import type { LLMRunner, LLMLLMRunParams } from "../types.js";

const T = 1_700_000_000_000;

describe("A1：L1 抽取调用点不硬编码 timeoutMs", () => {
  it("llmRunner 路径：run 参数无 timeoutMs（回落 l1 层 300s 解析值）", async () => {
    let captured: LLMRunParams | undefined;
    const llm = {
      run: async (params: LLMRunParams) => {
        captured = params;
        return JSON.stringify([
          { scene_name: "s", message_ids: ["m1"], memories: [{ type: "episodic", content: "x", priority: 50 }] },
        ]);
      },
    } as unknown as LLMRunner;
    const baseDir = mkdtempSync(join(tmpdir(), "a1-extract-"));
    await extractL1Memories({
      messages: [{ id: "m1", role: "user" as const, content: "触发", timestamp: T }],
      sessionKey: "zcode-default",
      sessionId: "sess-a1",
      baseDir,
      config: {},
      options: { enableDedup: false, promptMode: "chat", llmRunner: llm },
    }).finally(() => rmSync(baseDir, { recursive: true, force: true }));
    expect(captured).toBeDefined();
    expect(captured!.timeoutMs).toBeUndefined();
  });

  it("fallback 路径同样不传（两条路径一致，防只修一半）", async () => {
    // fallback 路径（CleanContextRunner）无法注入假 runner，用源码级哨兵把守：
    // l1-extractor 与 persona-generator 全文不得再出现 180_000 硬编码。
    const here = fileURLToPath(new URL(".", import.meta.url));
    for (const rel of [
      "./l1-extractor.ts",
      "../persona/persona-generator.ts",
    ]) {
      const src = readFileSync(join(here, rel), "utf-8");
      expect(src, `${rel} 不得残留 timeoutMs: 180_000 硬编码`).not.toMatch(/timeoutMs:\s*180_000/);
    }
  });
});

describe("A1：persona 生成调用点不硬编码 timeoutMs", () => {
  it("runner.run 参数无 timeoutMs（回落 l3 层 600s 解析值）", async () => {
    let captured: LLMRunParams | undefined;
    const llm = {
      run: async (params: LLMRunParams) => {
        captured = params;
        return "";
      },
    } as unknown as LLMRunner;
    const baseDir = mkdtempSync(join(tmpdir(), "a1-persona-"));
    mkdirSync(join(baseDir, "profiles"), { recursive: true });
    const gen = new PersonaGenerator({
      dataDir: baseDir,
      config: {},
      llmRunner: llm,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
    });
    const out = await gen.generateLocalPersona("a1-test").finally(() =>
      rmSync(baseDir, { recursive: true, force: true }),
    );
    // 后处理读不到 LLM 写的 persona.md → failed 无妨；run 已在失败前被调用
    expect(out).toBe("failed");
    expect(captured).toBeDefined();
    expect(captured!.timeoutMs).toBeUndefined();
  });
});
