// 来源归属护栏：全部来源均为 assistant 的记忆不入库（2026-09-25 面板走查发现）
//
// 现场问题（生产 L1 实测）：AI 自己做的技术工作被记成了「用户的事实」——
//   「用户在 2026-09-25 修复了其覆盖度重排算法的一个边界缺陷：原实现给每个
//     查询词单独扫 200 条…」
//   「用户在 2026-09-25 修复了自己造成的记忆索引损坏…」
//   「用户要求 AI 重启网关进程（PID 6388）…」（PID 早已失效，仍会误导后续操作）
// 这些记忆的文字确实来自源消息，**只是源消息是 assistant 写的**，所以上游
// #266 的「内容可追溯性」检查（≥30% bigram 出现在源消息中）会放它们过关。
//
// 判定：**source_message_ids 里的每一条来源都来自 assistant** → 该记忆没有用户
// 依据，不入库。若来源里混有用户消息则保留——那正是上游 #706/#778 要解决的
// 「用户纠正后由 assistant 陈述最终结论」的情形，混源即视为有用户依据。
//
// 与已有护栏的关系：sanitizeUserAttribution 管「用户（X）」括号里的姓名归属；
// 本护栏管「整条记忆的来源归属」，两者互补、互不替代。
import { describe, expect, it } from "vitest";
import { extractL1Memories } from "./l1-extractor.js";
import type { LLMRunner, Logger } from "../types.js";

const T = 1_700_000_000_000;

const MESSAGES = [
  { id: "u1", role: "user" as const, content: "继续排查召回排序的问题。", timestamp: T },
  { id: "a1", role: "assistant" as const, content: "已修复覆盖度重排的边界缺陷：原实现每个词扫 200 条，触达上限时应跳过重排。提交 99098df。", timestamp: T + 1 },
  { id: "a2", role: "assistant" as const, content: "另外你之前要求重启网关 PID 6388，已完成，管线 idle。", timestamp: T + 2 },
  { id: "u2", role: "user" as const, content: "以后 handoff 时把开场提示词一起附上。", timestamp: T + 3 },
];

function runnerReturning(text: string): LLMRunner {
  return { run: async () => text } as unknown as LLMRunner;
}

function scene(memories: Array<{ content: string; src: string[]; type?: string }>) {
  return JSON.stringify([
    {
      scene_name: "我（AI）在协助处理召回排序问题",
      message_ids: ["u1", "a1", "a2", "u2"],
      memories: memories.map((m) => ({
        content: m.content,
        type: m.type ?? "episodic",
        priority: 70,
        source_message_ids: m.src,
      })),
    },
  ]);
}

async function extract(memories: Array<{ content: string; src: string[]; type?: string }>, logger?: Logger) {
  return extractL1Memories({
    messages: MESSAGES,
    sessionKey: "source-attribution-test",
    baseDir: "/tmp/l1-source-attribution-test",
    config: {},
    logger,
    options: { enableDedup: false, promptMode: "chat", llmRunner: runnerReturning(scene(memories)), userIdentityNames: ["何伟健"] },
  });
}

describe("来源归属护栏：纯 assistant 来源的记忆不入库", () => {
  it("来源全是 assistant → 丢弃（AI 的技术工作不得记成用户事实）", async () => {
    const res = await extract([{ content: "用户修复了覆盖度重排的边界缺陷，原实现每个词扫 200 条。", src: ["a1"] }]);
    expect(res.extractedCount).toBe(0);
    expect(res.records).toHaveLength(0);
  });

  it("来源全是 assistant（多条）→ 同样丢弃", async () => {
    const res = await extract([{ content: "用户要求重启网关进程 PID 6388。", src: ["a1", "a2"] }]);
    expect(res.extractedCount).toBe(0);
  });

  it("混入用户来源 → 保留（用户纠正后由 assistant 陈述最终结论，属 #706/#778 要救的场景）", async () => {
    const res = await extract([{ content: "用户纠正了召回排序口径后，结论改为覆盖度优先。", src: ["u1", "a1"] }]);
    expect(res.extractedCount).toBe(1);
    expect(res.records[0].content).toContain("覆盖度优先");
  });

  it("纯用户来源 → 保留（正常路径不受影响）", async () => {
    const res = await extract([{ content: "用户要求以后 handoff 附开场提示词。", src: ["u2"], type: "instruction" }]);
    expect(res.extractedCount).toBe(1);
  });

  it("无来源标注（source_message_ids 为空）→ 保守保留，不误杀", async () => {
    const res = await extract([{ content: "用户偏好简洁的结论先行。", src: [] }]);
    expect(res.extractedCount).toBe(1);
  });

  it("来源 id 指向不存在的消息 → 保守保留（不因未知而误杀）", async () => {
    const res = await extract([{ content: "用户提出过某项要求。", src: ["ghost-1"] }]);
    expect(res.extractedCount).toBe(1);
  });

  it("部分来源未知、部分为 assistant → 保留（不作纯 assistant 判定）", async () => {
    const res = await extract([{ content: "用户确认了某项结论。", src: ["ghost-1", "a1"] }]);
    expect(res.extractedCount).toBe(1);
  });

  it("丢弃时留下可审计锚点（知道丢了什么、依据什么判定）", async () => {
    const infos: string[] = [];
    const logger = { info: (m: string) => infos.push(m), warn: () => {}, debug: () => {}, error: () => {} } as unknown as Logger;
    await extract([{ content: "用户修复了某个缺陷。", src: ["a1"] }], logger);
    expect(infos.some((m) => m.includes("source-attribution") && m.includes("a1"))).toBe(true);
  });
});
