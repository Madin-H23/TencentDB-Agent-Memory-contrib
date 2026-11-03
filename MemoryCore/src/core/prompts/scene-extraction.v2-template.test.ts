// 票⑨（exp/p1-9-scene-v2-migration）：提示词去冲突。
// v2 on：v1 模板整块不再输出、改用三段模板；三条格式纪律注入；过期 1500 文案改为
// 实际 sceneCharCap；edit-only 护栏追加 v2 段路由提示。off：v1 模板逐字节保留
// （回归由 scene-extraction.v2-pin.test.ts 的 07d9057 基线钉负责）。
import { describe, expect, it } from "vitest";
import { buildSceneExtractionPrompt } from "./scene-extraction.js";

function build(mode: "chat" | "code", opts: {
  sceneFormatV2?: boolean;
  explicitInvalidation?: boolean;
  sceneCharCap?: number;
  maxScenes?: number;
} = {}) {
  return buildSceneExtractionPrompt({
    memoriesJson: '[]',
    sceneSummaries: "(无已有场景)",
    currentTimestamp: "2026-11-03T00:00:00.000Z",
    maxScenes: opts.maxScenes ?? 24,
    promptMode: mode,
    ...(opts.sceneFormatV2 !== undefined ? { sceneFormatV2: opts.sceneFormatV2 } : {}),
    ...(opts.explicitInvalidation !== undefined ? { explicitInvalidation: opts.explicitInvalidation } : {}),
    ...(opts.sceneCharCap !== undefined ? { sceneCharCap: opts.sceneCharCap } : {}),
  });
}

const V1_CHAT_HEADINGS = ["## 用户基础信息", "## 用户核心特征", "## 用户偏好", "## 隐性信号", "## 核心叙事", "## 演变轨迹", "## 待确认/矛盾点"];
const V1_WORK_HEADINGS = ["## 工作场景", "## 适用条件", "## 核心 SOP", "## 判断逻辑", "## 禁忌与反模式", "## 关键事实依据", "## 相关任务与资产", "## 演化记录", "## 待确认问题"];

describe("chat v2 on：v2 模板替换 v1 模板整块", () => {
  const on = build("chat", { sceneFormatV2: true, sceneCharCap: 300_000 }).systemPrompt;

  it("含三段模板与 v2 规则块", () => {
    expect(on).toContain("## 🗂️ 场景文件格式 v2（三层结构）");
    expect(on).toContain("## 要点");
    expect(on).toContain("## 事实");
    expect(on).toContain("## 活动");
    expect(on).toContain("summary: [30-40 words concise summary for indexing]");
  });

  it("不含 v1 模板任何章节标题 / 结构骨架表述", () => {
    for (const h of V1_CHAT_HEADINGS) expect(on).not.toContain(h);
    expect(on).not.toContain("作为结构骨架");
    expect(on).not.toContain("## User Core Traits");
  });

  it("三条格式纪律齐全（单点存储/轨迹合并/系统自动迁移）", () => {
    expect(on).toContain("**单点存储**");
    expect(on).toContain("**轨迹合并**");
    expect(on).toContain("**系统会自动迁移旧格式**");
    expect(on).toContain("无需整写迁移");
  });

  it("过期 1500 文案改为实际 sceneCharCap；未传 cap 时不出现 1500", () => {
    expect(on).toContain("每个 md 控制在 300000 字符内");
    expect(on).not.toContain("每个md控制在1500字符内");
    expect(on).not.toContain("每个 md 控制在 1500 字符内");
    const noCap = build("chat", { sceneFormatV2: true }).systemPrompt;
    expect(noCap).not.toContain("每个md控制在1500字符内");
    expect(noCap).not.toContain("每个 md 控制在");
  });

  it("edit-only 护栏保留并追加 v2 段路由提示", () => {
    expect(on).toContain("已存在且未完整读过的文件**禁止**用 write 整体重写");
    expect(on).toContain("更新一律 edit");
    expect(on).toContain("若文件已是 v2 格式（含 `## 要点`），允许按 v2 段路由直接 edit；系统会自动处理旧格式迁移。");
  });

  it("v2 单开不引入 SUPERSEDED 字样；与 ⑥ 同开时衔接失效规则", () => {
    expect(on).not.toContain("SUPERSEDED");
    const both = build("chat", { sceneFormatV2: true, explicitInvalidation: true }).systemPrompt;
    expect(both).toContain("## 🚦 失效标记规则");
    expect(both).toContain("原地**加 `[SUPERSEDED <ISO时间>]` 前缀标记失效（**不移入");
  });
});

describe("chat off：v1 模板逐字节保留（非默认路径复查）", () => {
  const off = build("chat").systemPrompt;

  it("含 v1 模板章节与 1500 文案；不含 v2 段落", () => {
    for (const h of V1_CHAT_HEADINGS) expect(off).toContain(h);
    expect(off).toContain("每个md控制在1500字符内");
    expect(off).not.toContain("## 要点");
    expect(off).not.toContain("场景文件格式 v2");
    expect(off).not.toContain("系统会自动迁移旧格式");
    expect(off).not.toContain("系统会自动处理旧格式迁移");
    expect(off).toContain("作为结构骨架");
  });

  it("off 不读取 sceneCharCap（传了也不出现在提示词）", () => {
    const offWithCap = build("chat", { sceneCharCap: 12345 }).systemPrompt;
    expect(offWithCap).not.toContain("12345");
    expect(offWithCap).toBe(off);
  });
});

describe("work（code）v2 on：模板同步 gate", () => {
  const on = build("code", { sceneFormatV2: true, sceneCharCap: 300_000 }).systemPrompt;

  it("含三段模板；不含 v1 工作模板章节", () => {
    expect(on).toContain("## 🗂️ 场景文件格式 v2（三层结构）");
    expect(on).toContain("## 要点");
    expect(on).toContain("## 事实");
    expect(on).toContain("## 活动");
    for (const h of V1_WORK_HEADINGS) expect(on).not.toContain(h);
    expect(on).not.toContain("结构骨架");
  });

  it("1500 文案改为实际 cap；护栏追加 v2 提示；三条纪律齐全", () => {
    expect(on).toContain("每个 md 控制在 300000 字符内");
    expect(on).not.toContain("每个 md 控制在 1500 字符内");
    expect(on).toContain("若文件已是 v2 格式（含 `## 要点`），允许按 v2 段路由直接 edit；系统会自动处理旧格式迁移。");
    expect(on).toContain("**单点存储**");
    expect(on).toContain("**轨迹合并**");
    expect(on).toContain("**系统会自动迁移旧格式**");
  });

  it("work off：v1 模板与 1500 文案保留、无 v2 段", () => {
    const off = build("code").systemPrompt;
    for (const h of V1_WORK_HEADINGS) expect(off).toContain(h);
    expect(off).toContain("每个 md 控制在 1500 字符内");
    expect(off).not.toContain("## 要点");
    expect(off).not.toContain("系统会自动处理旧格式迁移");
  });
});

describe("userPrompt 不随 v2 开关变化", () => {
  it("chat/code 两族 on/off userPrompt 逐字节一致", () => {
    for (const mode of ["chat", "code"] as const) {
      expect(build(mode, { sceneFormatV2: true }).userPrompt).toBe(build(mode).userPrompt);
      expect(build(mode, { sceneFormatV2: true, sceneCharCap: 300_000 }).userPrompt).toBe(
        build(mode).userPrompt,
      );
    }
  });
});
