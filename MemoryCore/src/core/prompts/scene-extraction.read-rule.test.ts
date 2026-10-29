// 方案B：scene-extraction 提示词追加「大文件分段读」规则。
// 红线：只追加，不删既有规则（两个 prompt family 同构追加）。
import { describe, expect, it } from "vitest";
import { buildSceneExtractionPrompt } from "./scene-extraction.js";

const BASE_PARAMS = {
  memoriesJson: "[{}]",
  sceneSummaries: "- work.md: demo",
  currentTimestamp: "2026-10-29T00:00:00Z",
  maxScenes: 8,
};

/** 既有规则的锚点（改动前已存在，追加后必须仍在）。 */
const EXISTING_RULE_ANCHORS = [
  "read 只能读取用户消息中",
  "删除文件的唯一方式",
  "禁止创建报告/整合/汇总类文件",
  "[DELETED]",
];

describe("scene-extraction 提示词：大文件分段读规则（只追加不删）", () => {
  it("chat 模式：追加分段读规则（offset/limit 预览 + oldText 必须来自已读片段）", () => {
    const { systemPrompt } = buildSceneExtractionPrompt({ ...BASE_PARAMS, promptMode: "chat" });
    expect(systemPrompt).toContain("分段预览");
    expect(systemPrompt).toContain("offset");
    expect(systemPrompt).toContain("limit");
    expect(systemPrompt).toContain("必须逐字来自已读片段");
    expect(systemPrompt).toContain("8. **大文件分段读**");
  });

  it("work 模式：同构追加分段读规则", () => {
    const { systemPrompt } = buildSceneExtractionPrompt({ ...BASE_PARAMS, promptMode: "code" });
    expect(systemPrompt).toContain("分段预览");
    expect(systemPrompt).toContain("offset");
    expect(systemPrompt).toContain("limit");
    expect(systemPrompt).toContain("必须逐字来自已读片段");
    expect(systemPrompt).toContain("8. **大文件分段读**");
  });

  it("新规则每个 family 只出现一次（追加一条，不散落多处）", () => {
    for (const promptMode of ["chat", "code"] as const) {
      const { systemPrompt } = buildSceneExtractionPrompt({ ...BASE_PARAMS, promptMode });
      const count = systemPrompt.split("8. **大文件分段读**").length - 1;
      expect(count).toBe(1);
    }
  });

  it("既有规则全部保留（chat + work 两模式）", () => {
    for (const promptMode of ["chat", "code"] as const) {
      const { systemPrompt } = buildSceneExtractionPrompt({ ...BASE_PARAMS, promptMode });
      for (const anchor of EXISTING_RULE_ANCHORS) {
        expect(systemPrompt, `promptMode=${promptMode} 缺少既有规则锚点: ${anchor}`).toContain(anchor);
      }
    }
  });

  it("追加位置在既有第 7 条之后（顺序 7 → 8）", () => {
    for (const promptMode of ["chat", "code"] as const) {
      const { systemPrompt } = buildSceneExtractionPrompt({ ...BASE_PARAMS, promptMode });
      const idx7 = systemPrompt.indexOf("7. **禁止创建报告/整合/汇总类文件**");
      const idx8 = systemPrompt.indexOf("8. **大文件分段读**");
      expect(idx7).toBeGreaterThan(-1);
      expect(idx8).toBeGreaterThan(idx7);
    }
  });
});
