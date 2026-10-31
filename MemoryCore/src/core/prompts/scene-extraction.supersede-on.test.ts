/**
 * 票⑥ on 变体断言：explicitInvalidation=true 时系统提示词改为「标记失效而非删除」。
 * 覆盖两个 prompt family（chat/code）；off 逐字节见 scene-extraction.supersede-pin.test.ts。
 */
import { describe, expect, it } from "vitest";
import { buildSceneExtractionPrompt } from "./scene-extraction.js";

function build(mode: "chat" | "code", explicitInvalidation: boolean) {
  return buildSceneExtractionPrompt({
    memoriesJson: "[]",
    sceneSummaries: "(无已有场景)",
    currentTimestamp: "2026-10-31T00:00:00.000Z",
    maxScenes: 24,
    promptMode: mode,
    explicitInvalidation,
  });
}

describe.each(["chat", "code"] as const)("票⑥ on 提示词变体（%s family）", (mode) => {
  const on = build(mode, true).systemPrompt;
  const off = build(mode, false).systemPrompt;

  it("含失效标记规则块（标记格式/锚点红线/read 过滤/不计帽）", () => {
    expect(on).toContain("## 🚦 失效标记规则（recency-wins，显式失效）");
    expect(on).toContain("[SUPERSEDED <ISO时间>]");
    expect(on).toContain("锚点行永不物理删除");
    expect(on).toContain("includeInvalidated: true");
    expect(on).toContain("失效行不计入文件尺寸帽");
  });
  it("删除类指令已替换为迁移锚点变体（无裸删除指令残留）", () => {
    expect(on).toContain("先迁移锚点再删除");
    expect(on).toContain("anchor_loss_forbidden");
    expect(on).not.toContain("合并后必须删除旧文件");
    expect(on).not.toContain("并删除被合并的旧文件");
  });
  it("off 与 on 输出不同（on 是追加+替换，非空操作）", () => {
    expect(on).not.toBe(off);
    expect(on.length).toBeGreaterThan(off.length);
  });
});

describe("票⑥ on：chat family 特有（示例 B 迁移步骤）", () => {
  it("示例 B 标题与关键步骤为迁移变体", () => {
    const on = build("chat", true).systemPrompt;
    expect(on).toContain("MERGE — 先迁移锚点再删除旧文件");
    expect(on).toContain("步骤 3 的锚点迁移必须先于步骤 5-6");
    expect(on).not.toContain("步骤 5-6 是必须的！不执行删除");
  });
});
