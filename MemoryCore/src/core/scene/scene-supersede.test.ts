// 票 P1-6b 方案三：确定性同锚替代折叠（pure，默认零接线）。
// 判据：同锚多重集 >1、两行脱敏相似度 ≥ 阈值、且**行内时间戳**判定被标行更旧
// （实测场景文件批次方向混合——最新在前/在后并存，行序不可依赖；无时间戳的行
// 不参与标记，宁漏勿错）。硬不变量：锚点多重集只增不减；META 头与 ## 要点 段豁免；
// 幂等；确定性。
import { describe, expect, it } from "vitest";
import { countSupersededChars, extractAnchorIds, isSupersededLine } from "../../utils/supersede.js";
import { deterministicSupersede, textSimilarity } from "./scene-supersede.js";

const NOW = "2026-11-09T02:30:00.000+08:00";
const A = "m_1794000000000_aaaaaaa1";
const B = "m_1794000000001_bbbbbbb2";
const C = "m_1794000000002_ccccccc3";

function scene(lines: string[]): string {
  return ["---", "meta: 摘要", "---", ...lines].join("\n");
}

/** 行内容 → 实际行号（避免布局算术）。 */
function idxOf(content: string, needle: string): number {
  const i = content.split("\n").findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`fixture 行未找到: ${needle.slice(0, 30)}`);
  return i;
}

describe("textSimilarity", () => {
  it("完全一致=1；无关文本≈0；空串对空串=1", () => {
    const t = "sceneCharCap 由 32K 提升到 300K";
    expect(textSimilarity(t, t)).toBe(1);
    expect(textSimilarity(t, "晚饭吃了红烧牛肉面")).toBeLessThan(0.1);
    expect(textSimilarity("", "")).toBe(1);
  });
});

describe("deterministicSupersede：方向判定（行内时间戳，混合批次方向防误标）", () => {
  it("最新在前布局（新行在上）：被标的必须是**时间戳更旧**的下行，而不是靠行序", () => {
    const newer = `【2026-11-08T03:00:00Z 批】sceneCharCap 32K 提升到 300K 落 yaml（${A}）`;
    const older = `【2026-11-01T02:00:00Z 批】sceneCharCap 32K 提升到 300K 落 yaml 复核（${A}）`;
    const raw = scene(["## 事实", newer, older]);
    const r = deterministicSupersede(raw, { now: NOW });
    expect(r.markedLines).toEqual([idxOf(raw, "2026-11-01T02:00:00Z")]);
  });

  it("时间序布局（旧行在上）：同样标时间戳更旧的行", () => {
    const older = `【2026-11-01T02:00:00Z 批】panel 额度兜底保留分支（${A}）`;
    const newer = `【2026-11-08T03:00:00Z 批】panel 额度兜底保留分支补记（${A}）`;
    const raw = scene(["## 事实", older, newer]);
    const r = deterministicSupersede(raw, { now: NOW });
    expect(r.markedLines).toEqual([idxOf(raw, "2026-11-01T02:00:00Z")]);
  });

  it("任一行无时间戳 → 成对跳过不标（宁漏勿错）", () => {
    const noTs = `【11-08 批】观测台新页 7 页签上线（${A}）`;
    const withTs = `【2026-11-01T02:00:00Z 批】观测台新页 7 页签（${A}）`;
    const raw = scene(["## 事实", noTs, withTs]);
    const r = deterministicSupersede(raw, { now: NOW });
    expect(r.markedLines).toHaveLength(0);
    expect(r.sparedNoDate).toBe(1);
  });

  it("两行时间戳相同 → 歧义跳过不标", () => {
    const l1 = `【2026-11-08T03:00:00Z 批】并发闸 maxConcurrency=4（${A}）`;
    const l2 = `【2026-11-08T03:00:00Z 批】并发闸 maxConcurrency=4 复核（${A}）`;
    const raw = scene(["## 事实", l1, l2]);
    const r = deterministicSupersede(raw, { now: NOW });
    expect(r.markedLines).toHaveLength(0);
  });
});

describe("deterministicSupersede：同锚重投折叠", () => {
  it("同锚重投且高相似 → 旧行标 [SUPERSEDED]，最新行不动，锚点多重集不变", () => {
    const old = `【2026-11-01T02:00:00Z 批】sceneCharCap=32K 提升到 300K，写侧帽全量落 yaml（${A}）`;
    const neu = `【2026-11-08T03:00:00Z 批】sceneCharCap=32K 提升到 300K，写侧帽全量落 yaml 复核在案（${A}）`;
    const raw = scene(["## 事实", old, neu]);
    const r = deterministicSupersede(raw, { now: NOW });
    const outLines = r.content.split("\n");
    expect(r.markedLines).toEqual([idxOf(raw, "【2026-11-01T02:00:00Z")]);
    expect(isSupersededLine(outLines[idxOf(raw, "【2026-11-01T02:00:00Z")]!)).toBe(true);
    expect(isSupersededLine(outLines[idxOf(raw, "【2026-11-08T03:00:00Z")]!)).toBe(false);
    expect(extractAnchorIds(r.content).sort()).toEqual(extractAnchorIds(raw).sort());
    expect(r.pairs[0]?.anchor).toBe(A);
  });

  it("同锚但低相似（交叉引用/不同事实）→ 豁免不标，计入 sparedLowSim；相似度按锚点脱敏文本计", () => {
    const old = `【2026-11-01T02:00:00Z 批】L0 存储数据缺失对账闭合，98 条差额全归指纹闸（${A}）`;
    const neu = `【2026-11-08T03:00:00Z 批】④b 语义门 shadow 上线，候选向量二段式判定（另见 ${A} 交叉留痕）`;
    const raw = scene(["## 事实", old, neu]);
    const r = deterministicSupersede(raw, { now: NOW });
    expect(r.markedLines).toHaveLength(0);
    expect(r.sparedLowSim).toBe(1);
    expect(r.content).toBe(raw);
  });

  it("幂等：二次运行零新增、逐字节一致", () => {
    const old = `【2026-11-01T02:00:00Z 批】panel 额度兜底保留未采纳分支（${A}）`;
    const neu = `【2026-11-08T03:00:00Z 批】panel 额度兜底保留未采纳分支，实拍复现配方补记（${A}）`;
    const once = deterministicSupersede(scene(["## 事实", old, neu]), { now: NOW });
    const twice = deterministicSupersede(once.content, { now: NOW });
    expect(twice.markedLines).toHaveLength(0);
    expect(twice.content).toBe(once.content);
  });

  it("META 头与 ## 要点 段豁免（其中锚点既不被标也不被抹除）", () => {
    const gist = `要点：面板 32K 帽修复（${A}）`;
    const factOld = `【2026-11-01T02:00:00Z 批】面板 32K 帽修复提交 cac9fa3（${A}）`;
    const factNew = `【2026-11-08T03:00:00Z 批】面板 32K 帽修复提交 cac9fa3 已生效（${A}）`;
    const raw = scene(["## 要点", gist, "", "## 事实", factOld, factNew]).replace(
      "meta: 摘要",
      `meta: 摘要含 ${A}`,
    );
    const r = deterministicSupersede(raw, { now: NOW });
    const outLines = r.content.split("\n");
    expect(r.markedLines).toEqual([idxOf(raw, "cac9fa3（")]);
    expect(isSupersededLine(outLines[idxOf(raw, "meta: 摘要含")]!)).toBe(false);
    expect(isSupersededLine(outLines[idxOf(raw, "要点：面板")]!)).toBe(false);
    expect(isSupersededLine(outLines[idxOf(raw, "【2026-11-08T03:00:00Z 批】面板")]!)).toBe(false);
  });

  it("已标行不再叠前缀；新标记行数只算新增", () => {
    const markedOld = `[SUPERSEDED 2026-11-01T00:00:00.000+08:00] 【2026-10-30T01:00:00Z 批】并发闸 maxConcurrency=4（${A}）`;
    const old = `【2026-11-02T02:00:00Z 批】并发闸 maxConcurrency=4 全绿（${A}）`;
    const neu = `【2026-11-08T03:00:00Z 批】并发闸 maxConcurrency=4 全绿并观察三周（${A}）`;
    const raw = scene(["## 事实", markedOld, old, neu]);
    const r = deterministicSupersede(raw, { now: NOW });
    const outLines = r.content.split("\n");
    const oldIdx = idxOf(raw, "【2026-11-02T02:00:00Z 批】并发闸");
    expect(r.markedLines).toEqual([oldIdx]);
    expect(outLines[oldIdx]!.startsWith(`[SUPERSEDED ${NOW}] `)).toBe(true);
    expect((r.content.match(/\[SUPERSEDED /g) ?? []).length).toBe(2); // 1 既有 + 1 新增
  });

  it("无锚文件逐字节不变；无锚行永不标记", () => {
    const raw = scene(["## 事实", "纯叙述一行没有锚点。", "另一行也无锚。"]);
    expect(deterministicSupersede(raw, { now: NOW }).content).toBe(raw);
    const withPlain = scene(["## 事实", "无锚叙述。", `有锚事实（${A}）`, "再一行无锚。"]);
    expect(deterministicSupersede(withPlain, { now: NOW }).content).toBe(withPlain);
  });

  it("多锚行：仅在「某锚分组中时间戳更旧且相似」时标记；交叉复述（低相似）豁免", () => {
    const oldOnly = `【2026-11-01T02:00:00Z 批】D2 lexical 灰度基线 0.17（${A}）`;
    const crossOld = `【2026-11-05T02:00:00Z 批】D2 灰度对账见 ${A}，主体归记忆治理场景（${B}）`;
    const neuB = `【2026-11-08T03:00:00Z 批】D2 lexical 灰度对账与守卫读数（${B}）`;
    const raw = scene(["## 事实", oldOnly, crossOld, neuB]);
    const r = deterministicSupersede(raw, { now: NOW });
    expect(r.markedLines).toHaveLength(0);
  });

  it("多锚行高相似重投 → 标记，锚点 A/B 双双保留", () => {
    const old = `【2026-11-05T02:00:00Z 批】i-have-adhd 技能启用并长期化（${A}）＋工作流纪律入册（${B}）`;
    const neu = `【2026-11-08T03:00:00Z 批】i-have-adhd 技能启用并长期化（${A}）＋工作流纪律入册（${B}）复验在案`;
    const raw = scene(["## 事实", old, neu]);
    const r = deterministicSupersede(raw, { now: NOW });
    expect(r.markedLines).toEqual([idxOf(raw, "【2026-11-05T02:00:00Z 批】i-have-adhd")]);
    expect(extractAnchorIds(r.content).sort()).toEqual([A, B, A, B].sort());
  });

  it("与既有口径联动：countSupersededChars 覆盖新增标记行（前缀计入）", () => {
    const old = `【2026-11-01T02:00:00Z 批】L2 批次上限 N=50（${A}）`;
    const neu = `【2026-11-08T03:00:00Z 批】L2 批次上限 N=50 复核（${A}）`;
    const raw = scene(["## 事实", old, neu]);
    const before = countSupersededChars(raw);
    const r = deterministicSupersede(raw, { now: NOW });
    const outLines = r.content.split("\n");
    const markedLine = outLines[idxOf(raw, "【2026-11-01T02:00:00Z 批】L2")]!;
    expect(isSupersededLine(markedLine)).toBe(true);
    expect(countSupersededChars(r.content)).toBe(markedLine.length + 1);
    expect(countSupersededChars(r.content)).toBeGreaterThan(before);
  });

  it("确定性：同输入两次运行逐字节一致", () => {
    const old = `【2026-11-01T02:00:00Z 批】观测台新页 7 页签（${C}）`;
    const neu = `【2026-11-08T03:00:00Z 批】观测台新页 7 页签上线（${C}）`;
    const raw = scene(["## 事实", old, neu]);
    const r1 = deterministicSupersede(raw, { now: NOW });
    const r2 = deterministicSupersede(raw, { now: NOW });
    expect(r1.content).toBe(r2.content);
    expect(r1.markedLines).toEqual(r2.markedLines);
    expect(r1.pairs).toEqual(r2.pairs);
  });
});
