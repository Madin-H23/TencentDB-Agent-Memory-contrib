// L1 提示词：纠正结论例外（上游 #706 的落地方案，PR #778）
//
// 背景：现行规则把「AI 助手自身的行为或输出」整体排除。它挡住了 AI 的幻觉与
// 临时分析，但也误伤一类重要事实——用户纠正了某个认知、AI 依据纠正给出最终结论时，
// 完整事实只出现在 assistant 消息里，结果 L1 只留下「用户指出了偏差」这类外围行为。
// 上游 #706 提出该缺口，#778 给出方案：在 chat 提示词里加一条**受约束的例外**。
//
// 2026-09-25 方案 B 起该条款受 extraction.correctionException 开关控制、默认关闭：
// 单独启用 A/B 无可测提升，且其产出的「用户确认：…」记忆常只挂 assistant 来源，
// 会与来源归属护栏对撞；须配合 attributionGuard="batch-confirm" 使用。
import { describe, expect, it } from "vitest";
import {
  CORRECTION_EXCEPTION_CLAUSE,
  EXTRACT_MEMORIES_SYSTEM_PROMPT,
  EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT,
  getExtractMemoriesSystemPrompt,
} from "./l1-extraction.js";

describe("L1 提示词纠正结论例外（#706 / PR #778，受开关控制默认关闭）", () => {
  it("默认（不传 opts）不注入例外条款——与 2026-09-25 前行为一致", () => {
    const chatPrompt = getExtractMemoriesSystemPrompt("chat");
    expect(chatPrompt).not.toContain("纠正结论例外");
  });

  it("correctionException: false 显式关闭同样不注入", () => {
    expect(getExtractMemoriesSystemPrompt("chat", { correctionException: false })).not.toContain("纠正结论例外");
  });

  it("开启后 chat 提示词包含纠正结论例外", () => {
    const chatPrompt = getExtractMemoriesSystemPrompt("chat", { correctionException: true });
    expect(chatPrompt).toContain("纠正结论例外");
  });

  it("指导模型用「用户确认：…」句式承载最终结论", () => {
    const chatPrompt = getExtractMemoriesSystemPrompt("chat", { correctionException: true });
    expect(chatPrompt).toContain("用户确认：[纠正后的最终事实]");
  });

  it("要求 source_message_ids 同时覆盖用户纠正与 AI 确认两条消息", () => {
    const chatPrompt = getExtractMemoriesSystemPrompt("chat", { correctionException: true });
    expect(chatPrompt).toContain("同时包含用户的纠正消息与 AI 的确认消息");
  });

  it("例外只覆盖被用户纠正/确认锚定的最终事实，单方面 AI 输出仍排除", () => {
    const chatPrompt = getExtractMemoriesSystemPrompt("chat", { correctionException: true });
    expect(chatPrompt).toContain("只提取被用户纠正/确认锚定的最终事实");
    expect(chatPrompt).toContain("AI 单方面提出的新方案");
  });

  it("原有的「不提取 AI 自身行为/输出」总规则仍然保留（例外不是取消）", () => {
    const chatPrompt = getExtractMemoriesSystemPrompt("chat", { correctionException: true });
    expect(chatPrompt).toContain("AI助手自身的行为或输出");
  });

  it("work/team(code) 提示词即使开启也不注入例外（其口径是人工采纳确认，另有一套）", () => {
    const codePrompt = getExtractMemoriesSystemPrompt("code", { correctionException: true });
    expect(codePrompt).toBe(EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT);
    expect(codePrompt).not.toContain("纠正结论例外");
  });

  it("注入位置落在 episodic 规则段内（「3. 全局指令记忆」之前）", () => {
    const p = getExtractMemoriesSystemPrompt("chat", { correctionException: true });
    const episodicIdx = p.indexOf('客观事件记忆 (type: "episodic")');
    const exceptionIdx = p.indexOf("纠正结论例外");
    const instructionIdx = p.indexOf('全局指令记忆 (type: "instruction")');
    expect(exceptionIdx).toBeGreaterThan(episodicIdx);
    expect(exceptionIdx).toBeLessThan(instructionIdx);
  });

  it("注入不破坏既有规则文本：除插入条款外其余内容逐字保留", () => {
    const base = getExtractMemoriesSystemPrompt("chat");
    const withEx = getExtractMemoriesSystemPrompt("chat", { correctionException: true });
    const injected = withEx.replace("\n" + CORRECTION_EXCEPTION_CLAUSE, "");
    expect(injected).toBe(base);
  });

  it("未开启的原始模板本身不含例外文本（条款只存在于常量与注入结果）", () => {
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).not.toContain("纠正结论例外");
    expect(CORRECTION_EXCEPTION_CLAUSE).toContain("纠正结论例外");
  });

  it("常量与 getter（不传 opts）暴露的是同一份文本（避免两条导出路径漂移）", () => {
    expect(getExtractMemoriesSystemPrompt("chat")).toBe(EXTRACT_MEMORIES_SYSTEM_PROMPT);
  });
});
