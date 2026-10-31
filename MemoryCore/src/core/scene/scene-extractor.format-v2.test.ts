// 票⑤（exp/p1-5-scene-format-v2）：SceneExtractor 接线——opts.sceneFormatV2
// 同时驱动 (a) buildSceneExtractionPrompt 的 systemPrompt 变体、(b) LLMRunParams
// 透传（runner 工厂据此装配 read/write/edit 工具）。缺省 off 两路均与基线一致。
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

async function extractOnce(opts: { sceneFormatV2?: boolean }) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-extractor-v2-"));
  try {
    const fake = makeFakeRunner();
    const extractor = new SceneExtractor({
      dataDir,
      config: {} as never,
      maxScenes: 24,
      llmRunner: fake as never,
      ...(opts.sceneFormatV2 !== undefined ? { sceneFormatV2: opts.sceneFormatV2 } : {}),
    });
    await extractor.extract([{ content: "一条测试记忆", created_at: "2026-10-31T00:00:00.000Z", id: "m_1787881381525_2eee472e" }]);
    expect(fake.captured.length).toBe(1);
    return fake.captured[0]!;
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

describe("SceneExtractor 接线：sceneFormatV2 → 提示词 + LLMRunParams", () => {
  it("off（缺省）：runParams.sceneFormatV2=false，systemPrompt 无 v2 规则块", async () => {
    const params = await extractOnce({});
    expect(params.sceneFormatV2).toBe(false);
    expect(params.systemPrompt).not.toContain("场景文件格式 v2");
  });

  it("off（显式 false）：与缺省同形（双写钉）", async () => {
    const params = await extractOnce({ sceneFormatV2: false });
    expect(params.sceneFormatV2).toBe(false);
    expect(params.systemPrompt).not.toContain("场景文件格式 v2");
  });

  it("on：runParams.sceneFormatV2=true，systemPrompt 含 v2 三层结构规则块", async () => {
    const params = await extractOnce({ sceneFormatV2: true });
    expect(params.sceneFormatV2).toBe(true);
    expect(params.systemPrompt).toContain("## 🗂️ 场景文件格式 v2（三层结构）");
    expect(params.systemPrompt).toContain("## 事实");
  });
});
