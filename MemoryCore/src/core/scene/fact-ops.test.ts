// 票 P1-6b 方案一/二：事实级四元操作（mem0 式）的 prompt 构建与响应解析。
// 纯函数；LLM/嵌入由调用方注入，测试用 fixture mock。
import { describe, expect, it } from "vitest";
import {
  buildFactOpsPrompt,
  buildJudgePrompt,
  judgePairKey,
  parseFactOpsResponse,
  parseJudgeResponse,
  pairCandidatesBySimilarity,
} from "./fact-ops.js";

describe("buildFactOpsPrompt（方案一）", () => {
  it("包含既有事实、新批事实与四元操作指令与 JSON 输出约定", () => {
    const p = buildFactOpsPrompt(["旧事实一 m_1_a"], ["新事实一 m_2_b"]);
    expect(p).toContain("旧事实一 m_1_a");
    expect(p).toContain("新事实一 m_2_b");
    expect(p).toContain("ADD");
    expect(p).toContain("UPDATE");
    expect(p).toContain("DELETE");
    expect(p).toContain("NOOP");
    expect(p).toContain("JSON");
    expect(p).toContain("SUPERSEDED");
  });
});

describe("parseFactOpsResponse（方案一）", () => {
  it("解析裸 JSON 数组", () => {
    const r = parseFactOpsResponse(
      `[{"op":"update","fact":"新写法","targetAnchor":"m_1_a"},{"op":"noop"}]`,
    );
    expect(r.error).toBeUndefined();
    expect(r.ops).toHaveLength(2);
    expect(r.ops[0]).toEqual({ op: "update", fact: "新写法", targetAnchor: "m_1_a" });
    expect(r.ops[1]).toEqual({ op: "noop", fact: undefined, targetAnchor: undefined });
  });

  it("解析代码围栏包裹的 JSON", () => {
    const r = parseFactOpsResponse('```json\n[{"op":"add","fact":"x"}]\n```');
    expect(r.error).toBeUndefined();
    expect(r.ops[0]?.op).toBe("add");
  });

  it("update/delete 缺 targetAnchor → 结构化错误条目而非静默", () => {
    const r = parseFactOpsResponse(`[{"op":"update","fact":"x"}]`);
    expect(r.ops[0]?.op).toBe("update");
    expect(r.errors?.length).toBe(1);
  });

  it("未知 op 与畸形 JSON → 报错不抛异常", () => {
    expect(parseFactOpsResponse(`[{"op":"merge","fact":"x"}]`).errors?.length).toBe(1);
    const bad = parseFactOpsResponse("这不是 JSON");
    expect(bad.error).toBeTruthy();
    expect(bad.ops).toHaveLength(0);
  });
});

describe("pairCandidatesBySimilarity（方案二候选生成）", () => {
  it("超过阈值的（新,旧）对入选并按相似度降序；无锚注入不虚增", () => {
    const incoming = [{ text: "sceneCharCap 提升到 300K 落 yaml", anchor: "m_2_b" }];
    const existing = [
      { text: "sceneCharCap 32K 写侧帽拒绝 27 次", anchor: "m_1_a" },
      { text: "晚饭吃了红烧牛肉面", anchor: "m_1_c" },
    ];
    const pairs = pairCandidatesBySimilarity(incoming, existing, 0.3);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.existingAnchor).toBe("m_1_a");
    expect(pairs[0]?.similarity).toBeGreaterThan(0.3);
  });

  it("零候选返回空数组", () => {
    expect(
      pairCandidatesBySimilarity([{ text: "甲", anchor: "m_2_b" }], [{ text: "乙", anchor: "m_1_a" }], 0.9),
    ).toHaveLength(0);
  });
});

describe("buildJudgePrompt / parseJudgeResponse（方案二轻判定·P1-1/P1-2 修订）", () => {
  it("judge prompt 含簿记族 DISTINCT 指引、累积汇总 SUPERSEDE 指引与双行日期", () => {
    const p = buildJudgePrompt("【2026-11-01 批】旧行", "【2026-11-08 批】新行", {
      oldDate: "2026-11-01",
      newDate: "2026-11-08",
    });
    expect(p).toContain("【2026-11-01 批】旧行");
    expect(p).toContain("【2026-11-08 批】新行");
    expect(p).toContain("轮次簿记"); // P1-1：簿记族显式 DISTINCT
    expect(p).toContain("投递登记"); // P1-1：第 N 次投递登记行
    expect(p).toContain("累积"); // P1-1：累积性汇总扩展 SUPERSEDE
    expect(p).toContain("2026-11-01"); // 双行日期入 prompt
    expect(p).toContain("2026-11-08");
  });

  it("judge prompt 含方向反转保护（新行日期不晚于旧行 → UNKNOWN）", () => {
    const p = buildJudgePrompt("旧", "新", { oldDate: "2026-11-08", newDate: "2026-11-01" });
    expect(p).toMatch(/UNKNOWN/);
    expect(p).toContain("不晚于");
  });

  it("解析：精确匹配优先；围栏容忍保留（既有用例按补丁① C3 更新）", () => {
    expect(parseJudgeResponse("SUPERSEDE")).toBe("supersede");
    expect(parseJudgeResponse("```distinct```")).toBe("distinct");
    expect(parseJudgeResponse("  unknown  ")).toBe("unknown");
    expect(parseJudgeResponse("说不清楚")).toBe("unknown");
  });

  it("解析：否定句 → unknown（P1-2 防误标方向）", () => {
    expect(parseJudgeResponse("not a supersede; they are distinct")).toBe("unknown");
    expect(parseJudgeResponse("This is NOT a supersede")).toBe("unknown");
    expect(parseJudgeResponse("并非同一事实")).toBe("unknown");
    expect(parseJudgeResponse("而非更新关系")).toBe("unknown");
  });
});

describe("judgePairKey：delta 判定键（内容哈希、抗行号漂移）", () => {
  it("同文件同锚同内容 → 同键（内容哈希、行号无关）", () => {
    const k1 = judgePairKey("a.md", "m_1_a", "旧行内容", "新行内容");
    const k2 = judgePairKey("a.md", "m_1_a", "旧行内容", "新行内容");
    expect(k1).toBe(k2);
  });

  it("内容变化/换锚点/换文件 → 不同键", () => {
    const base = judgePairKey("a.md", "m_1_a", "旧", "新");
    expect(judgePairKey("a.md", "m_1_a", "旧改", "新")).not.toBe(base);
    expect(judgePairKey("a.md", "m_1_b", "旧", "新")).not.toBe(base);
    expect(judgePairKey("b.md", "m_1_a", "旧", "新")).not.toBe(base);
  });
});
