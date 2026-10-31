// 票⑥（exp/p1-6-supersede-inval）：SceneExtractor 接线——opts.explicitInvalidation
// 同时驱动 (a) buildSceneExtractionPrompt 的 systemPrompt 变体、(b) LLMRunParams 透传
// （runner 工厂据此装配 read/write/edit 工具）。缺省 off 两路均与基线一致。
import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SceneExtractor } from "./scene-extractor.js";
import type { LLMRunParams } from "../../core/types.js";

function makeFakeRunner() {
  const captured: LLMRunParams[] = [];
  return {
    captured,
    run: async (params: LLMRunParams) => {
      captured.push(params);
      return "done";
    },
  } as unknown as { run: (p: LLMRunParams) => Promise<string> } & { captured: LLMRunParams[] };
}

async function extractOnce(opts: { explicitInvalidation?: boolean }) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-extractor-"));
  try {
    const fake = makeFakeRunner();
    const extractor = new SceneExtractor({
      dataDir,
      config: {} as never,
      maxScenes: 24,
      llmRunner: fake as never,
      ...(opts.explicitInvalidation !== undefined ? { explicitInvalidation: opts.explicitInvalidation } : {}),
    });
    await extractor.extract([{ content: "一条测试记忆", created_at: "2026-10-31T00:00:00.000Z", id: "m_1787881381525_2eee472e" }]);
    expect(fake.captured.length).toBe(1);
    const params = fake.captured[0]!;
    return params;
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

describe("SceneExtractor 接线：explicitInvalidation → 提示词 + LLMRunParams", () => {
  it("off（缺省）：runParams.explicitInvalidation=false，systemPrompt 无 SUPERSEDED 字样", async () => {
    const params = await extractOnce({});
    expect(params.explicitInvalidation).toBe(false);
    expect(params.systemPrompt).not.toContain("SUPERSEDED");
  });

  it("off（显式 false）：与缺省同形（双写钉）", async () => {
    const params = await extractOnce({ explicitInvalidation: false });
    expect(params.explicitInvalidation).toBe(false);
    expect(params.systemPrompt).not.toContain("SUPERSEDED");
  });

  it("on：runParams.explicitInvalidation=true，systemPrompt 含失效标记规则块", async () => {
    const params = await extractOnce({ explicitInvalidation: true });
    expect(params.explicitInvalidation).toBe(true);
    expect(params.systemPrompt).toContain("## 🚦 失效标记规则（recency-wins，显式失效）");
    expect(params.systemPrompt).toContain("[SUPERSEDED <ISO时间>]");
  });
});
