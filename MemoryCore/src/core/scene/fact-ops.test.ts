// 票 P1-6b 方案一/二：事实级四元操作（mem0 式）的 prompt 构建与响应解析。
// 纯函数；LLM/嵌入由调用方注入，测试用 fixture mock。
import { describe, expect, it } from "vitest";
import {
  buildFactOpsPrompt,
  buildJudgePrompt,
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

describe("buildJudgePrompt / parseJudgeResponse（方案二轻判定）", () => {
  it("judge prompt 含新旧两行与判别语义（同一事实更新 vs 同实体不同事实）", () => {
    const p = buildJudgePrompt("旧行", "新行");
    expect(p).toContain("旧行");
    expect(p).toContain("新行");
    expect(p).toContain("同一事实");
    expect(p).toContain("不同事实");
  });

  it("解析判定词三种出口；大小写与围栏容忍", () => {
    expect(parseJudgeResponse("SUPERSEDE")).toBe("supersede");
    expect(parseJudgeResponse("```distinct```")).toBe("distinct");
    expect(parseJudgeResponse("说不清楚")).toBe("unknown");
  });
});
