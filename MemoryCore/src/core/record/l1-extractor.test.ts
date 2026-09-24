import { describe, expect, it } from "vitest";
import { extractL1Memories, L1ExtractionFailure } from "./l1-extractor.js";
import type { LLMRunner, Logger } from "../types.js";

/**
 * 回归测试（对应上游 #1395；本机事故 2026-09-17）——
 * 蒸馏失败必须以「失败」上报，绝不能被当成「合法空产出」：
 * 一旦被当成空产出，L1 runner 会照常推进 checkpoint 游标，
 * 该批 L0 便再也不会被重读（静默丢弃、无重试、面板看不到）。
 *
 * 反向护栏同样重要：模型正常回答但确实「无可记」时，必须仍是成功，
 * 否则游标永不前进、会话永久卡死。
 */

const T = 1_700_000_000_000;

const MESSAGES = [
  {
    id: "m1",
    role: "user" as const,
    content: "我的长期项目代号是 Aurora-7，它是一个需要持续维护的系统，后续讨论都以这个项目为背景。",
    timestamp: T,
  },
  {
    id: "m2",
    role: "assistant" as const,
    content: "明白，我会把 Aurora-7 作为长期背景保留，并在后续对话中沿用。",
    timestamp: T + 1,
  },
  {
    id: "m3",
    role: "user" as const,
    content: "Aurora-7 是我未来一年持续维护的核心项目，优先级高于其他临时任务。",
    timestamp: T + 2,
  },
];

function runnerReturning(text: string): LLMRunner {
  return { run: async () => text } as unknown as LLMRunner;
}

function runnerThrowing(message: string): LLMRunner {
  return {
    run: async () => {
      throw new Error(message);
    },
  } as unknown as LLMRunner;
}

function extract(runner: LLMRunner, logger?: Logger) {
  return extractL1Memories({
    messages: MESSAGES,
    sessionKey: "l1-extractor-test",
    baseDir: "/tmp/l1-extractor-test",
    config: {},
    logger,
    options: { enableDedup: false, promptMode: "chat", llmRunner: runner },
  });
}

describe("extractL1Memories：失败 vs 合法空（#1395）", () => {
  it("LLM 调用失败 → 抛 L1ExtractionFailure(llm_error)，本批延后而不推进游标", async () => {
    await expect(extract(runnerThrowing("429 quota exhausted"))).rejects.toBeInstanceOf(
      L1ExtractionFailure,
    );
    await expect(extract(runnerThrowing("429 quota exhausted"))).rejects.toMatchObject({
      reason: "llm_error",
    });
  });

  it("响应不含 JSON 数组（如 max_tokens 截断）→ 抛 L1ExtractionFailure(parse_error)", async () => {
    // 现场形态：思考吃光预算，内容停在半个 JSON 上（finishReason=length）。
    const truncated = '[{"scene_name":"用户与AI讨论Aurora-7项目","message_ids":["m1","m2"';
    await expect(extract(runnerReturning(truncated))).rejects.toBeInstanceOf(L1ExtractionFailure);
    await expect(extract(runnerReturning(truncated))).rejects.toMatchObject({
      reason: "parse_error",
    });
  });

  it("模型正常回答但确无可记（空数组）→ 仍然成功（游标可推进）", async () => {
    const res = await extract(runnerReturning("[]"));
    expect(res.success).toBe(true);
    expect(res.extractedCount).toBe(0);
    expect(res.storedCount).toBe(0);
  });

  it("场景可解析但 memories 为空 → 仍然成功（游标可推进）", async () => {
    const res = await extract(
      runnerReturning('[{"scene_name":"用户在设计项目方案","message_ids":["m1"],"memories":[]}]'),
    );
    expect(res.success).toBe(true);
    expect(res.extractedCount).toBe(0);
  });

  it("空产出轮必须留 INFO 锚点（面板『最近蒸馏』以此定位轮次）", async () => {
    const infos: string[] = [];
    const logger = { info: (m: string) => infos.push(m) } as unknown as Logger;
    const res = await extract(runnerReturning("[]"), logger);
    expect(res.extractedCount).toBe(0);
    expect(infos.some((m) => m.includes("Extraction complete: extracted=0, stored=0"))).toBe(true);
  });
});

describe("确定性归属护栏（2026-09-24 事故回归）", () => {
  it("模型把第三方姓名/角色塞进姓名括号 → 入库前归一为「用户」，白名单内保留", async () => {
    const llm = runnerReturning(
      JSON.stringify([
        {
          scene_name: "我（AI）在协助处理 it-ops 资料库需求",
          message_ids: ["m1", "m2"],
          memories: [
            { content: "用户（王缘林）要求将处理人配置范围扩大到所有一级资料库", type: "instruction", priority: 80, source_message_ids: ["m1"] },
            { content: "用户（导师）于 2026-09-24 提了四条文档管理需求", type: "episodic", priority: 70, source_message_ids: ["m2"] },
            { content: "用户（何伟健）坚持先备份再动线上库", type: "instruction", priority: 85, source_message_ids: ["m1"] },
          ],
        },
      ]),
    );
    const res = await extractL1Memories({
      messages: MESSAGES,
      sessionKey: "attribution-test",
      baseDir: "D:/Develop/TencentDB-Agent-Memory/e2e-fix/data-strand",
      config: {},
      options: { enableDedup: false, promptMode: "chat", llmRunner: llm, userIdentityNames: ["何伟健"] },
    });
    const contents = res.records.map((r) => r.content);
    expect(contents).toContain("用户要求将处理人配置范围扩大到所有一级资料库");
    expect(contents).toContain("用户于 2026-09-24 提了四条文档管理需求");
    expect(contents).toContain("用户（何伟健）坚持先备份再动线上库");
  });
});
