// 票 P1-6b 方案一/二：事实级四元操作（mem0 式）的 prompt 构建与响应解析。
// 纯函数；LLM/嵌入由调用方注入，测试用 fixture mock。
import { describe, expect, it } from "vitest";
import {
  buildFactOpsPrompt,
  buildJudgePrompt,
  filterSupersededByApproval,
  judgePairKey,
  parseFactOpsResponse,
  parseJudgeResponse,
  pairCandidatesBySimilarity,
  parseJudgeApprovalState,
} from "./fact-ops.js";
import type { SupersedePair } from "./scene-supersede.js";

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
    expect(p).toContain("判定要领"); // 首批审计补：主体错配矫正（不同事件即使同场景也 DISTINCT）
    expect(p).toContain("第 412 轮"); // 二批审计补：真实误判模式 few-shot 反例
    expect(p).toContain("212~311"); // few-shot 正例（累积扩展）
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

describe("buildJudgePrompt：替换模式注入防护（审查 R1 P2-1）", () => {
  it("OLD/NEW 槽位对 $&/$'/$`/$$ 形态免疫（原样插入不展开不截断）", () => {
    // buildJudgePrompt 走 same template engine；用 judge prompt 的同款修法路径验证
    const oldLine = "旧 $& $' $` 模板";
    const newLine = "新 $$ 模板";
    const p = buildJudgePrompt([oldLine], [newLine]);
    expect(p).toContain(oldLine);
    expect(p).toContain(newLine);
    expect(p).not.toContain("undefined");
  });
});
// ── P1-6b 批准桶接线（T1·票 TICKETS-P1-6b-approval-gate-20261113.md）──

describe("parseJudgeApprovalState：judge state.json 解析", () => {
  const realState = JSON.stringify({
    version: 1,
    pairs: {
      "a.md|m_1_a|x|y": { verdict: "supersede", at: "2026-11-11T01:22:00Z", attempts: 0 },
      "a.md|m_2_b|x|y": { verdict: "distinct", at: "2026-11-11T01:22:00Z", attempts: 0 },
      "a.md|m_3_c|x|y": { verdict: "unknown", at: "2026-11-11T01:22:00Z", attempts: 0 },
      "a.md|m_4_d|x|y": { verdict: "supersede", at: "2026-11-11T01:22:00Z", attempts: 0 },
    },
  });

  it("只收 verdict=supersede 的键（distinct/unknown 不入批准集）", () => {
    const idx = parseJudgeApprovalState(realState);
    expect(idx.approved.size).toBe(2);
    expect(idx.approved.has("a.md|m_1_a|x|y")).toBe(true);
    expect(idx.approved.has("a.md|m_4_d|x|y")).toBe(true);
    expect(idx.approved.has("a.md|m_2_b|x|y")).toBe(false);
    expect(idx.approved.has("a.md|m_3_c|x|y")).toBe(false);
  });

  it("带 attempts 的记录同样按 verdict 收", () => {
    const idx = parseJudgeApprovalState(
      JSON.stringify({ version: 1, pairs: { k1: { verdict: "supersede", attempts: 2 } } }),
    );
    expect(idx.approved.size).toBe(1);
  });

  it("畸形输入 → 空集不 throw（fail-closed 到不过滤）", () => {
    expect(parseJudgeApprovalState("").approved.size).toBe(0);
    expect(parseJudgeApprovalState("not json").approved.size).toBe(0);
    expect(parseJudgeApprovalState("[]").approved.size).toBe(0);
    expect(parseJudgeApprovalState("{}").approved.size).toBe(0);
    expect(parseJudgeApprovalState('{"pairs":null}').approved.size).toBe(0);
    expect(parseJudgeApprovalState('{"pairs":{"k":{"attempts":1}}}').approved.size).toBe(0);
    expect(parseJudgeApprovalState('{"pairs":{"k":"string"}}').approved.size).toBe(0);
  });

  it("大小写/空白容忍：' SUPERSEDE ' 仍计入", () => {
    const idx = parseJudgeApprovalState(
      JSON.stringify({ pairs: { k1: { verdict: " SUPERSEDE " } } }),
    );
    expect(idx.approved.has("k1")).toBe(true);
  });

  it("空 pairs 对象 → 空集", () => {
    const idx = parseJudgeApprovalState(JSON.stringify({ version: 1, pairs: {} }));
    expect(idx.approved.size).toBe(0);
  });
});

describe("filterSupersededByApproval：on 模式只保留批准对", () => {
  const file = "测试.md";
  // 三行同锚旧事实 + 一行新事实；第 0/1 行被判、第 2 行未判
  const original = [
    "- 旧事实A（m_1794000000000_aaaa0001）",
    "- 旧事实B（m_1794000000001_bbbb0002）",
    "- 旧事实C（m_1794000000002_cccc0003）",
    "- 新事实（m_1794000000003_dddd0004）",
  ].join("\n");

  // anchor 必须与 marked() 推入 pairs 的 anchor 字面一致（过滤按 p.anchor 重算键）
  const PAIR_ANCHOR = "m_x";
  function keyFor(oldIdx: number, newIdx: number): string {
    return judgePairKey(file, PAIR_ANCHOR, original.split("\n")[oldIdx], original.split("\n")[newIdx]);
  }

  /** 手工构造 supersede 后的 content（前缀 = 0.55 直标形态）。 */
  function marked(idxs: number[]): { content: string; pairs: SupersedePair[] } {
    const lines = original.split("\n");
    const pairs: SupersedePair[] = [];
    for (const i of idxs) {
      lines[i] = `[SUPERSEDED 2026-11-13T00:00:00.000Z] ${lines[i]}`;
      pairs.push({ oldIndex: i, newIndex: 3, anchor: "m_x", similarity: 0.6 });
    }
    return { content: lines.join("\n"), pairs };
  }

  it("批准保留、未判撤销：kept=1 reverted=2", () => {
    const { content, pairs } = marked([0, 1, 2]);
    const approved = new Set([keyFor(0, 3)]);
    const r = filterSupersededByApproval(content, original, pairs, approved, file);
    expect(r.kept).toBe(1);
    expect(r.reverted).toBe(2);
    expect(r.content.split("\n")[0]).toContain("[SUPERSEDED");
    expect(r.content.split("\n")[1]).not.toContain("[SUPERSEDED");
    expect(r.content.split("\n")[2]).not.toContain("[SUPERSEDED");
  });

  it("全批准 → 零撤销（content 不变）", () => {
    const { content, pairs } = marked([0, 1]);
    const approved = new Set([keyFor(0, 3), keyFor(1, 3)]);
    const r = filterSupersededByApproval(content, original, pairs, approved, file);
    expect(r.kept).toBe(2);
    expect(r.reverted).toBe(0);
    expect(r.content).toBe(content);
  });

  it("零批准 → 全撤销（content 逐字节回到原状）", () => {
    const { content, pairs } = marked([0, 1, 2]);
    const r = filterSupersededByApproval(content, original, pairs, new Set(), file);
    expect(r.kept).toBe(0);
    expect(r.reverted).toBe(3);
    expect(r.content).toBe(original);
  });

  it("撤销只动前缀：锚点多重集过滤前后完全一致", () => {
    const { content, pairs } = marked([0, 1, 2]);
    const approved = new Set([keyFor(0, 3)]);
    const r = filterSupersededByApproval(content, original, pairs, approved, file);
    const ids = (t: string) => (t.match(/m_\d{13}_[0-9a-f]{8}/g) ?? []).sort();
    expect(ids(r.content)).toEqual(ids(original));
  });

  it("幂等：过滤一次后再过同一批准集 → 零变化", () => {
    const { content, pairs } = marked([0, 1, 2]);
    const approved = new Set([keyFor(0, 3)]);
    const r1 = filterSupersededByApproval(content, original, pairs, approved, file);
    // 二次运行：输入为已过滤 content + 同批准集（此时 kept 行的 key 仍命中）
    const r2 = filterSupersededByApproval(r1.content, original, pairs, approved, file);
    expect(r2.content).toBe(r1.content);
    expect(r2.kept).toBe(1);
    expect(r2.reverted).toBe(0);
  });

  it("pairs 为空 → 原样返回", () => {
    const r = filterSupersededByApproval(original, original, [], new Set(["k"]), file);
    expect(r.content).toBe(original);
    expect(r.kept).toBe(0);
    expect(r.reverted).toBe(0);
  });

  it("不认识的锚点行（pair 指向未标行）→ 不误撤销", () => {
    // pair.oldIndex 指向的行本就没有前缀 → 跳过不计 reverted
    const { content, pairs } = marked([0]);
    const badPairs = [{ oldIndex: 1, newIndex: 3, anchor: "m_x", similarity: 0.6 }];
    const r = filterSupersededByApproval(content, original, badPairs, new Set(), file);
    expect(r.reverted).toBe(0);
    expect(r.content).toBe(content);
  });
});
