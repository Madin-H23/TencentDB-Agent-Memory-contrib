/**
 * 票 05（2026-10-24 判定层 M2 治理 · 第一票）单测：harness 消融旋钮纯函数集。
 *
 * 覆盖（票面验收「TDD：三参数解析（含非法值报错）、跳过键扩展、变体注入点」）：
 * - parseAb5Knobs：--topk / --thinking / --prompt-variant 三参数解析 + 缺省值
 *   + 非法值显式报错（topk 非法或超池深上限 50、thinking 非法档位、
 *   prompt-variant 未知名）。
 * - 变体注入点：strict 收紧段文案与金标标注口径对齐（预注册基准以本常量为
 *   准，防漂移）、系统提示词追加、runner 包装透传、base 变体原样直通。
 * - thinkingConfigPatch：thinking → StandaloneLLMConfig.thinkingLevel 注入映射。
 * - 跳过键扩展（golden-ab5-metrics 的 additive 改动）：resumeKey 带旋钮扩展键、
 *   两参旧形态保持（既有测试不回归）、resumeSkip 按旋钮键跳过。
 * - rowKnobs：JSONL 行字段 → 归一化旋钮（旧行缺字段回落默认，保 --resume 兼容）。
 * - conflictRecallTopK 透传：经生产 batchDedup + 可数假池验证 topk 真实生效。
 * 样本全部合成内容，零真实 PII；本文件不发起任何网络调用。
 */
import { describe, it, expect } from "vitest";

import {
  DEFAULT_PROMPT_VARIANT,
  PROMPT_VARIANTS,
  isPromptVariantName,
  parseAb5Knobs,
  thinkingConfigPatch,
  variantWrappedRunner,
  withPromptVariant,
} from "./golden-ab5-knobs.js";
import {
  AB5_DEFAULT_KNOBS,
  build5CandMockStore,
  knobKey,
  resumeKey,
  resumeSkip,
  rowKnobs,
  type Ab5Knobs,
  type Ab5Row,
} from "./golden-ab5-metrics.js";
import { batchDedup } from "./l1-dedup.js";
import type { Golden5CandPair, Golden5CandPoolRow } from "./golden-5cand.js";
import type { LLMRunner, LLMRunParams } from "../types.js";

// ── 合成样本（零真实 PII，与既有 golden-ab5 测试同约定）─────────────────

function poolRow(recordId: string, content: string): Golden5CandPoolRow {
  return {
    record_id: recordId,
    content,
    type: "work_fact",
    priority: 80,
    scene_name: "测试场景",
    score: 0.5,
    timestamp_str: "2026-10-24T00:00:00.000Z",
    timestamp_start: "",
    timestamp_end: "",
    version: 0,
    session_key: "",
    session_id: "",
    team_id: "",
    task_id: "",
    user_id: "",
    agent_id: "",
    metadata_json: "{}",
  };
}

function bigPoolPair(pid: string): Golden5CandPair {
  return {
    pid,
    twin_id: "twin_row",
    twin_source: "db",
    twin_rank: 7,
    twin_beyond_recall: false,
    pool: Array.from({ length: 10 }, (_, i) => poolRow(`filler_${i + 1}`, `填充行${i + 1}：与查询主题无关的占位内容`)),
  };
}

// ── parseAb5Knobs：三参数解析 + 缺省 + 非法值报错 ───────────────────────

describe("parseAb5Knobs", () => {
  it("缺省：无旋钮参数 → topk=5 / thinking 不注入 / promptVariant=base", () => {
    expect(parseAb5Knobs(["node", "golden-ab5.ts"])).toEqual({ topk: 5, thinking: "", promptVariant: "base" });
  });

  it("无关参数不干扰解析", () => {
    expect(parseAb5Knobs(["node", "x", "--limit=5", "--resume", "--dataset=/tmp/a.json"])).toEqual(AB5_DEFAULT_KNOBS);
  });

  it("--topk=N 透传解析（1/3/10 均为合法正整数）", () => {
    expect(parseAb5Knobs(["--topk=1"]).topk).toBe(1);
    expect(parseAb5Knobs(["--topk=3"]).topk).toBe(3);
    expect(parseAb5Knobs(["--topk=10"]).topk).toBe(10);
  });

  it("--thinking 全部六个合法档位接受", () => {
    for (const level of ["default", "disabled", "enabled", "low", "high", "max"]) {
      expect(parseAb5Knobs([`--thinking=${level}`]).thinking).toBe(level);
    }
  });

  it("--prompt-variant=strict / base 接受", () => {
    expect(parseAb5Knobs(["--prompt-variant=strict"]).promptVariant).toBe("strict");
    expect(parseAb5Knobs(["--prompt-variant=base"]).promptVariant).toBe("base");
  });

  it("三参数可叠加", () => {
    expect(parseAb5Knobs(["--topk=1", "--thinking=low", "--prompt-variant=strict"])).toEqual({
      topk: 1,
      thinking: "low",
      promptVariant: "strict",
    });
  });

  it("非法 --topk（0/负数/非整数/非数字/超池深上限）显式报错", () => {
    for (const bad of ["0", "-1", "2.5", "abc", "", "51"]) {
      expect(() => parseAb5Knobs([`--topk=${bad}`]), `--topk=${bad}`).toThrow(/topk/);
    }
  });

  it("--topk 边界：50（=数据集最大池深）合法、51 超上限报错", () => {
    expect(parseAb5Knobs(["--topk=50"]).topk).toBe(50);
    expect(() => parseAb5Knobs(["--topk=51"])).toThrow(/池深/);
  });

  it("非法 --thinking 显式报错并列出合法档位", () => {
    expect(() => parseAb5Knobs(["--thinking=bogus"])).toThrow(/thinking/);
    expect(() => parseAb5Knobs(["--thinking=bogus"])).toThrow(/default/);
    expect(() => parseAb5Knobs(["--thinking="])).toThrow(/thinking/);
  });

  it("非法 --prompt-variant 显式报错并列出合法变体", () => {
    expect(() => parseAb5Knobs(["--prompt-variant=aggro"])).toThrow(/prompt-variant/);
    expect(() => parseAb5Knobs(["--prompt-variant=aggro"])).toThrow(/strict/);
  });
});

// ── 变体常量与注入点 ────────────────────────────────────────────────────

describe("prompt 变体常量（harness 侧，不动生产 prompts/）", () => {
  it("strict 收紧段为金标标注口径对齐文案（预注册基准以本常量为准，防漂移）", () => {
    expect(PROMPT_VARIANTS.strict).toBe(
      "判定纪律：只有当新记忆与某候选表达同一事实/规则/偏好/事件（不同措辞或互补阶段）时才可 merge/update；同主题但事实、对象或时间点不同的独立记忆必须 store；无法确定时宁可 store，不要合并。",
    );
  });

  it("base 为缺省变体名且不在追加表中", () => {
    expect(DEFAULT_PROMPT_VARIANT).toBe("base");
    expect("base" in PROMPT_VARIANTS).toBe(false);
    expect(isPromptVariantName("base")).toBe(true);
    expect(isPromptVariantName("strict")).toBe(true);
    expect(isPromptVariantName("bogus")).toBe(false);
  });
});

describe("withPromptVariant / variantWrappedRunner", () => {
  const baseParams: LLMRunParams = { prompt: "user", systemPrompt: "系统提示词", taskId: "l1-conflict-detection" };

  it("base 变体：params 原样返回（生产 prompt 不动）", () => {
    expect(withPromptVariant(baseParams, "base")).toBe(baseParams);
  });

  it("strict 变体：systemPrompt 原文在前、收紧段追加在后", () => {
    const out = withPromptVariant(baseParams, "strict");
    expect(out.systemPrompt).toBe(`系统提示词\n\n${PROMPT_VARIANTS.strict}`);
    expect(out.prompt).toBe("user");
    expect(out.taskId).toBe("l1-conflict-detection");
    // 不改写入参（纯函数）
    expect(baseParams.systemPrompt).toBe("系统提示词");
  });

  it("strict 变体但无 systemPrompt：显式抛错（拒绝静默降级为 base）", () => {
    const p: LLMRunParams = { prompt: "user", taskId: "t" };
    expect(() => withPromptVariant(p, "strict")).toThrow(/systemPrompt/);
    expect(() => withPromptVariant(p, "strict")).toThrow(/strict/);
  });

  it("base 变体无 systemPrompt：仍原样返回（无追加段，不触发防护）", () => {
    const p: LLMRunParams = { prompt: "user", taskId: "t" };
    expect(withPromptVariant(p, "base")).toBe(p);
  });

  it("base 包装：直接返回内层 runner（零包装开销）", () => {
    const inner: LLMRunner = { run: async () => "ok" };
    expect(variantWrappedRunner(inner, "base")).toBe(inner);
  });

  it("strict 包装：inner.run 收到的 systemPrompt 已追加收紧段，返回值透传", async () => {
    const seen: LLMRunParams[] = [];
    const inner: LLMRunner = {
      run: async (p) => {
        seen.push(p);
        return "decision";
      },
    };
    const out = await variantWrappedRunner(inner, "strict").run(baseParams);
    expect(out).toBe("decision");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.systemPrompt).toBe(`系统提示词\n\n${PROMPT_VARIANTS.strict}`);
  });
});

// ── thinkingConfigPatch：thinking → StandaloneLLMConfig 注入映射 ────────

describe("thinkingConfigPatch", () => {
  it("thinking 不注入（空串）→ 空补丁（不覆盖 runner config）", () => {
    expect(thinkingConfigPatch(AB5_DEFAULT_KNOBS)).toEqual({});
  });

  it("thinking=low → { thinkingLevel: 'low' }（对齐生产 l1=low 消融臂）", () => {
    expect(thinkingConfigPatch({ topk: 5, thinking: "low", promptVariant: "base" })).toEqual({ thinkingLevel: "low" });
  });

  it("六档全部映射正确", () => {
    for (const level of ["default", "disabled", "enabled", "low", "high", "max"] as const) {
      expect(thinkingConfigPatch({ topk: 5, thinking: level, promptVariant: "base" })).toEqual({ thinkingLevel: level });
    }
  });

  it("防御：非法档位字符串显式抛错（不许静默注入）", () => {
    const bad = { topk: 5, thinking: "bogus", promptVariant: "base" } as Ab5Knobs;
    expect(() => thinkingConfigPatch(bad)).toThrow(/thinking/);
  });
});

// ── 跳过键扩展（golden-ab5-metrics additive）────────────────────────────

describe("resumeKey / resumeSkip 旋钮扩展", () => {
  it("两参旧形态保持不变（既有调用与旧 JSONL 行不回归）", () => {
    expect(resumeKey("g001", "none")).toBe("g001|none");
  });

  it("带旋钮：键扩为 pid|mode|topk|thinking|variant（thinking 空串记 none）", () => {
    expect(resumeKey("g001", "none", { topk: 1, thinking: "low", promptVariant: "strict" })).toBe(
      "g001|none|topk=1|thinking=low|variant=strict",
    );
    expect(resumeKey("g001", "none", AB5_DEFAULT_KNOBS)).toBe("g001|none|topk=5|thinking=none|variant=base");
  });

  it("knobKey：聚合分组键与 resumeKey 后缀一致", () => {
    const k: Ab5Knobs = { topk: 3, thinking: "high", promptVariant: "strict" };
    expect(knobKey(k)).toBe("topk=3|thinking=high|variant=strict");
    expect(resumeKey("p", "none", k)).toBe(`p|none|${knobKey(k)}`);
  });

  it("resumeSkip：任务带旋钮时按扩展键跳过（同 pid 同 mode 异旋钮不误跳）", () => {
    const mk = (topk: number): { pid: string; mode: string; knobs: Ab5Knobs } => ({
      pid: "p1",
      mode: "none",
      knobs: { topk, thinking: "", promptVariant: "base" },
    });
    const judged = new Set([resumeKey("p1", "none", { topk: 5, thinking: "", promptVariant: "base" })]);
    const r = resumeSkip(judged, [mk(5), mk(1)]);
    expect(r.skipped).toBe(1);
    expect(r.pending).toEqual([mk(1)]);
  });

  it("resumeSkip：任务不带旋钮 → 沿用两参旧键（既有行为）", () => {
    const tasks = [{ pid: "p1", mode: "none" }, { pid: "p1", mode: "lexical" }];
    const judged = new Set([resumeKey("p1", "none")]);
    const r = resumeSkip(judged, tasks);
    expect(r.skipped).toBe(1);
    expect(r.pending).toEqual([{ pid: "p1", mode: "lexical" }]);
  });
});

// ── rowKnobs：JSONL 行字段 → 归一化旋钮 ─────────────────────────────────

describe("rowKnobs", () => {
  it("行含新字段 → 原样归一", () => {
    expect(rowKnobs({ topk: 1, thinking: "low", promptVariant: "strict" })).toEqual({
      topk: 1,
      thinking: "low",
      promptVariant: "strict",
    });
  });

  it("旧行缺字段 → 全部回落默认（--resume 对历史基线行兼容）", () => {
    expect(rowKnobs({})).toEqual(AB5_DEFAULT_KNOBS);
  });

  it("部分字段缺失 → 逐字段回落默认", () => {
    expect(rowKnobs({ topk: 1 })).toEqual({ topk: 1, thinking: "", promptVariant: "base" });
    expect(rowKnobs({ promptVariant: "strict" })).toEqual({ topk: 5, thinking: "", promptVariant: "strict" });
  });

  it("旧行归一键 === 默认旋钮任务键（同一次默认 --resume 可续跑历史行）", () => {
    const oldRow = { pid: "p1", mode: "none" } as Ab5Row;
    expect(resumeKey(oldRow.pid, oldRow.mode, rowKnobs(oldRow))).toBe(
      resumeKey("p1", "none", AB5_DEFAULT_KNOBS),
    );
  });
});

// ── conflictRecallTopK 透传：经生产 batchDedup + 可数假池验证 ───────────

describe("conflictRecallTopK 透传 batchDedup（--topk 的生产生效面）", () => {
  const pair = bigPoolPair("gK");

  it("none 臂 topk=1：fetch=topK+1=2（缺省时为 6，既有测试钉死）", async () => {
    const { store, ftsCalls } = build5CandMockStore(pair);
    await batchDedup({
      memories: [{ record_id: `ab_${pair.pid}`, content: "新记忆内容", type: "work_fact" as never, priority: 80, source_message_ids: [], metadata: {}, scene_name: "" }],
      config: {},
      llmRunner: { run: async () => "[]" },
      vectorStore: store,
      dedupFailFast: true,
      dedupRecallRerank: "none",
      conflictRecallTopK: 1,
      timeoutMs: 240_000,
    });
    expect(ftsCalls).toHaveLength(1);
    expect(ftsCalls[0]!.topK).toBe(2);
  });

  it("lexical 臂 topk=1：fetch=max(topK*10,50)=50", async () => {
    const { store, ftsCalls } = build5CandMockStore(pair);
    await batchDedup({
      memories: [{ record_id: `ab_${pair.pid}`, content: "新记忆内容", type: "work_fact" as never, priority: 80, source_message_ids: [], metadata: {}, scene_name: "" }],
      config: {},
      llmRunner: { run: async () => "[]" },
      vectorStore: store,
      dedupFailFast: true,
      dedupRecallRerank: "lexical",
      conflictRecallTopK: 1,
      timeoutMs: 240_000,
    });
    expect(ftsCalls).toHaveLength(1);
    expect(ftsCalls[0]!.topK).toBe(50);
  });
});
