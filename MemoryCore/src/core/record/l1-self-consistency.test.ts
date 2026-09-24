import { describe, expect, it } from "vitest";
import { extractL1Memories, L1ExtractionFailure } from "./l1-extractor.js";
import type { LLMRunner, Logger } from "../types.js";

/**
 * L1 多采样并集（self-consistency，2026-09-24）
 *
 * 起因（当日隔离回放实测）：同一批 L0 跑两次，模型给出的记忆集合不同——
 * llm-runner 与 l1-extractor 都没有固定 temperature/seed，走上游默认采样，
 * 于是「同输入不同输出」成了 L1 漏记的主因之一（金标回测：单次 recall 24~29%，
 * 两次并集 35%）。本文件钉住「同批采样 N 次取并集」的行为与失效边界。
 *
 * 不变量：
 *  - 默认 samplesPerBatch=1 时行为与改动前完全一致（只调一次 LLM）；
 *  - 全采样失败仍按 #1395 抛 L1ExtractionFailure，游标不推进（绝不静默跳过）；
 *  - 部分失败可用其余样本的并集继续，但必须留下告警锚点；
 *  - 非法参数一律钳到 1（不猜、不静默改语义）。
 */

const T = 1_700_000_000_000;

const MESSAGES = [
  { id: "m1", role: "user" as const, content: "我的长期项目代号是 Aurora-7，后续讨论都以它为背景。", timestamp: T },
  { id: "m2", role: "assistant" as const, content: "明白，我会把 Aurora-7 作为长期背景保留。", timestamp: T + 1 },
  { id: "m3", role: "user" as const, content: "Aurora-7 优先级高于其他临时任务。", timestamp: T + 2 },
];

/** 按调用顺序吐出预设响应；元素为 Error 时抛出。 */
function queuedRunner(responses: (string | Error)[]): LLMRunner & { calls: number } {
  const runner = {
    calls: 0,
    run: async () => {
      const item = responses[Math.min(runner.calls, responses.length - 1)];
      runner.calls += 1;
      if (item instanceof Error) throw item;
      return item;
    },
  };
  return runner as unknown as LLMRunner & { calls: number };
}

function scene(name: string, contents: string[]) {
  return JSON.stringify([
    {
      scene_name: name,
      message_ids: ["m1", "m2"],
      memories: contents.map((c, i) => ({
        content: c,
        type: i === 0 ? "instruction" : "episodic",
        priority: 70,
        source_message_ids: ["m1"],
      })),
    },
  ]);
}

function extract(runner: LLMRunner, samplesPerBatch?: number, logger?: Logger, maxMemoriesPerSession?: number) {
  return extractL1Memories({
    messages: MESSAGES,
    sessionKey: "l1-self-consistency-test",
    baseDir: "/tmp/l1-self-consistency-test",
    config: {},
    logger,
    options: {
      enableDedup: false,
      promptMode: "chat",
      llmRunner: runner,
      ...(samplesPerBatch !== undefined ? { samplesPerBatch } : {}),
      ...(maxMemoriesPerSession !== undefined ? { maxMemoriesPerSession } : {}),
    },
  });
}

describe("默认行为回归：samplesPerBatch 缺省 = 1 次采样", () => {
  it("不传该参数时只调用一次 LLM，产出等于单次结果", async () => {
    const runner = queuedRunner([scene("用户在设计项目方案", ["用户要求把 Aurora-7 设为长期项目背景"])]);
    const res = await extract(runner);
    expect(runner.calls).toBe(1);
    expect(res.success).toBe(true);
    expect(res.records.map((r) => r.content)).toEqual(["用户要求把 Aurora-7 设为长期项目背景"]);
  });

  it("显式传 1 与不传等价（仍只调一次）", async () => {
    const runner = queuedRunner([scene("用户在设计项目方案", ["用户要求把 Aurora-7 设为长期项目背景"])]);
    const res = await extract(runner, 1);
    expect(runner.calls).toBe(1);
    expect(res.extractedCount).toBe(1);
  });
});

describe("多采样并集：同批跑 N 次取并集", () => {
  it("3 次采样给出不同记忆 → 三条都入库（这正是单采样漏掉的召回）", async () => {
    const runner = queuedRunner([
      scene("场景甲", ["用户要求 push 前必须找我确认"]),
      scene("场景乙", ["用户在 2026-09-24 提了四条资料库需求"]),
      scene("场景丙", ["用户坚持先备份再动线上库"]),
    ]);
    const res = await extract(runner, 3);
    expect(runner.calls).toBe(3);
    expect(res.extractedCount).toBe(3);
    const contents = res.records.map((r) => r.content);
    expect(contents).toContain("用户要求 push 前必须找我确认");
    expect(contents).toContain("用户在 2026-09-24 提了四条资料库需求");
    expect(contents).toContain("用户坚持先备份再动线上库");
  });

  it("并集内完全相同的记忆只入库一次（采样噪声折叠）", async () => {
    const same = scene("场景甲", ["用户要求 push 前必须找我确认"]);
    const runner = queuedRunner([same, same, same]);
    const res = await extract(runner, 3);
    expect(runner.calls).toBe(3);
    expect(res.extractedCount).toBe(1);
    expect(res.records).toHaveLength(1);
  });

  it("去重忽略首尾空白与全半角标点差异（同一记忆的两种写法只留一条）", async () => {
    const runner = queuedRunner([
      scene("场景甲", ["用户要求 push 前必须找我确认。"]),
      scene("场景乙", ["用户要求 push 前必须找我确认"]),
    ]);
    const res = await extract(runner, 2);
    expect(res.extractedCount).toBe(1);
  });

  it("maxMemoriesPerSession 上限对并集同样生效（3×10 条截到 5 条）", async () => {
    const many = (tag: string) => scene(`场景${tag}`, Array.from({ length: 10 }, (_, i) => `用户事项 ${tag}-${i}`));
    const runner = queuedRunner([many("甲"), many("乙"), many("丙")]);
    const res = await extract(runner, 3, undefined, 5);
    expect(res.records.length).toBe(5);
  });

  it("连续性字段 lastSceneName 取最后一个非空场景名", async () => {
    const runner = queuedRunner([scene("场景甲", ["用户事项一"]), scene("场景乙", ["用户事项二"])]);
    const res = await extract(runner, 2);
    expect(res.lastSceneName).toBe("场景乙");
  });
});

describe("失效边界：部分失败 / 全失败 / 非法参数", () => {
  it("部分采样失败 → 用成功样本的并集继续，且留下告警锚点", async () => {
    const runner = queuedRunner([
      scene("场景甲", ["用户要求 push 前必须找我确认"]),
      new Error("429 quota exhausted"),
      scene("场景丙", ["用户坚持先备份再动线上库"]),
    ]);
    const warns: string[] = [];
    const logger = { warn: (m: string) => warns.push(m), info: () => {}, debug: () => {}, error: () => {} } as unknown as Logger;
    const res = await extract(runner, 3, logger);
    expect(res.success).toBe(true);
    expect(res.extractedCount).toBe(2);
    expect(warns.some((w) => w.includes("sample 2/3") || w.includes("采样"))).toBe(true);
  });

  it("全部采样失败 → 抛 L1ExtractionFailure，游标不推进（#1395 语义不被削弱）", async () => {
    const runner = queuedRunner([new Error("boom-1"), new Error("boom-2"), new Error("boom-3")]);
    await expect(extract(runner, 3)).rejects.toBeInstanceOf(L1ExtractionFailure);
    await expect(extract(runner, 3)).rejects.toMatchObject({ reason: "llm_error" });
  });

  it("全部采样都返回不可解析内容 → 抛 parse_error（不是合法空产出）", async () => {
    const truncated = '[{"scene_name":"场景","message_ids":["m1"],"memories":[{"content":"截断';
    const runner = queuedRunner([truncated, truncated]);
    await expect(extract(runner, 2)).rejects.toMatchObject({ reason: "parse_error" });
  });

  it("非法参数一律钳到 1：0 / 负数 / 小数 / NaN，并留下钳制告警（防默认值巧合通过）", async () => {
    for (const bad of [0, -3, 2.5, Number.NaN]) {
      const runner = queuedRunner([scene("场景甲", ["用户事项一"])]);
      const warns: string[] = [];
      const logger = { warn: (m: string) => warns.push(m), info: () => {}, debug: () => {}, error: () => {} } as unknown as Logger;
      const res = await extract(runner, bad, logger);
      expect(runner.calls).toBe(1);
      expect(res.extractedCount).toBe(1);
      expect(warns.some((w) => w.includes("samplesPerBatch") && w.includes("钳"))).toBe(true);
    }
  });

  it("全部采样均为合法空产出 → 成功且 0 条（合法空产出语义不被多采样误伤）", async () => {
    const runner = queuedRunner(["[]", "[]", "[]"]);
    const infos: string[] = [];
    const logger = { info: (m: string) => infos.push(m), warn: () => {}, debug: () => {}, error: () => {} } as unknown as Logger;
    const res = await extract(runner, 3, logger);
    expect(res.success).toBe(true);
    expect(res.extractedCount).toBe(0);
    expect(infos.some((m) => m.includes("Extraction complete: extracted=0, stored=0"))).toBe(true);
  });
});
