// 票 P1-6b 方案三 + 迭代一（REV-20261110+补丁①）：确定性同锚替代折叠。
// 判据：同锚多重集 >1 + 脱敏相似度 ≥ 阈值 + **行内分层时间戳**成对比较（被标行须严格更旧）。
// 形态六种：ISO带时区/MM-DD HH:MMZ/北京 MM-DD HH:MM/naive MM-DD HH:MM/YYYY-MM-DD/裸 MM-DD；
// 绝对类（abs/naive）行内首个优先、dateOnly 兜底；可比仅同档、date 同日期跳过；
// 对照行排除保护区与已标行；无日期行不判（sparedNoDate）。硬不变量：锚点多重集只增不减；
// META 头与 ## 要点 段豁免；幂等；确定性。
import { describe, expect, it } from "vitest";
import { countSupersededChars, extractAnchorIds, isSupersededLine } from "../../utils/supersede.js";
import { deterministicSupersede, parseLineTime, textSimilarity } from "./scene-supersede.js";

const NOW = "2026-11-09T02:30:00.000+08:00";
const NOW_TS = new Date(NOW).getTime();
const A = "m_1794000000000_aaaaaaa1";
const B = "m_1794000000001_bbbbbbb2";
const C = "m_1794000000002_ccccccc3";

function scene(lines: string[]): string {
  return ["---", "meta: 摘要", "---", ...lines].join("\n");
}

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

describe("parseLineTime：分层形态与优先级", () => {
  const at = (s: string) => parseLineTime(s, NOW_TS);

  it("ISO 带时区 → abs", () => {
    expect(at("【2026-11-01T02:00:00Z 批】x")?.kind).toBe("abs");
    expect(at("【2026-11-01T02:00:00.000+08:00 批】x")?.kind).toBe("abs");
  });

  it("MM-DD HH:MMZ → abs(UTC)", () => {
    expect(at("【10-22 09:46Z 批】x")).toEqual({ ms: Date.UTC(2026, 9, 22, 9, 46), kind: "abs" });
  });

  it("北京 MM-DD HH:MM → abs(+08:00)", () => {
    expect(at("【北京 11-01 14:30】x")?.kind).toBe("abs");
    expect(at("【北京 11-01 14:30】x")?.ms).toBe(Date.UTC(2026, 10, 1, 6, 30));
  });

  it("naive MM-DD HH:MM（无时区）→ naive，且优先于 dateOnly（C1）", () => {
    expect(at("【11-01 14:30 批】x")?.kind).toBe("naive");
  });

  it("YYYY-MM-DD → date（允许无时区 ISO 的日期部分，C2）", () => {
    expect(at("【2026-11-01 批】x")?.kind).toBe("date");
    expect(at("【2026-11-01T02:00:00 批】x")?.kind).toBe("date");
  });

  it("裸 MM-DD → date；左边界 (?<![\\w-]) 挡票号/版本号，右边界挡钟点", () => {
    expect(at("【11-01 批】x")?.kind).toBe("date");
    expect(at("（P0-3 修订）（锚点）")).toBeNull(); // 票号不误 parse
    expect(at("（版本 2026-11 发布）")).toBeNull(); // 缺日的版本号
    expect(at("v1.2-3 说明")).toBeNull();
  });

  it("绝对类行内首个优先：行首日期取胜，行中他批引用不参与", () => {
    const line = "【11-01 10:00Z 本批】对账见 11-08 05:08Z 交叉留痕";
    expect(parseLineTime(line, NOW_TS)).toEqual({ ms: Date.UTC(2026, 10, 1, 10, 0), kind: "abs" });
  });

  it("剥离 [SUPERSEDED …] 前缀后再扫（前缀时间戳不是事实时间）", () => {
    expect(parseLineTime(`[SUPERSEDED 2026-11-09T02:30:00.000+08:00] 【11-01 10:00Z 批】x`, NOW_TS)).toEqual({
      ms: Date.UTC(2026, 10, 1, 10, 0),
      kind: "abs",
    });
  });

  it("年份推断：未来日期回退一年", () => {
    const jan = new Date("2027-01-05T00:00:00Z").getTime();
    expect(parseLineTime("【12-20 10:00Z 批】x", jan)).toEqual({ ms: Date.UTC(2026, 11, 20, 10, 0), kind: "abs" });
    expect(parseLineTime("【01-02 10:00Z 批】x", jan)).toEqual({ ms: Date.UTC(2027, 0, 2, 10, 0), kind: "abs" });
    expect(parseLineTime("【2026-12-31 批】x", jan)?.ms).toBe(Date.UTC(2026, 11, 31));
  });
});

describe("deterministicSupersede：分层时间戳成对比较", () => {
  it("MMZ 形态：更旧行被标，锚点多重集不变", () => {
    const old = `【10-22 09:46Z 批】写侧帽 32K 提升到 300K 落 yaml（${A}）`;
    const neu = `【10-23 05:08Z 批】写侧帽 32K 提升到 300K 落 yaml 复核在案（${A}）`;
    const raw = scene(["## 事实", old, neu]);
    const r = deterministicSupersede(raw, { now: NOW });
    expect(r.markedLines).toEqual([idxOf(raw, "【10-22 09:46Z")]);
    expect(extractAnchorIds(r.content).sort()).toEqual(extractAnchorIds(raw).sort());
  });

  it("北京 形态且跨 UTC 日界：北京 11-08 00:30 早于 11-07T20:00Z → 北京行被标", () => {
    const bj = `【北京 11-08 00:30】面板单点探活定型为守卫 bat 加只读探活，失败才升级（${A}）`;
    const z = `【11-07 20:00Z 批】面板单点探活定型为守卫 bat 加只读探活，失败才升级复核在案（${A}）`;
    const raw = scene(["## 事实", bj, z]);
    const r = deterministicSupersede(raw, { now: NOW });
    expect(r.markedLines).toEqual([idxOf(raw, "北京 11-08 00:30")]);
  });

  it("naive 档只与 naive 比：naive 旧行被标；naive vs abs 跨档跳过", () => {
    const old = `【11-01 14:30 批】并发闸 maxConcurrency=4（${A}）`;
    const neu = `【11-08 09:15 批】并发闸 maxConcurrency=4 复核（${A}）`;
    const raw = scene(["## 事实", old, neu]);
    expect(deterministicSupersede(raw, { now: NOW }).markedLines).toEqual([idxOf(raw, "【11-01 14:30")]);
    const mixed = scene(["## 事实", `【11-01 14:30 批】并发闸 maxConcurrency=4（${A}）`, `【11-08T03:00:00Z 批】并发闸 maxConcurrency=4 复核（${A}）`]);
    const r = deterministicSupersede(mixed, { now: NOW });
    expect(r.markedLines).toHaveLength(0);
  });

  it("date 档：更旧日期被标；同日期成对跳过（宁漏勿错）", () => {
    const old = `【2026-11-01 批】观测台新页 7 页签（${A}）`;
    const neu = `【2026-11-08 批】观测台新页 7 页签上线（${A}）`;
    const raw = scene(["## 事实", old, neu]);
    expect(deterministicSupersede(raw, { now: NOW }).markedLines).toEqual([idxOf(raw, "【2026-11-01 批")]);
    const same = scene(["## 事实", `【11-08 早批】观测台新页 7 页签（${A}）`, `【11-08 晚批】观测台新页 7 页签复核（${A}）`]);
    expect(deterministicSupersede(same, { now: NOW }).markedLines).toHaveLength(0);
  });

  it("跨档成对跳过：date 行与 abs 行互不标记（原 noTs 用例按先红清单改断言）", () => {
    const dateLine = `【11-08 批】观测台新页 7 页签上线（${A}）`;
    const absLine = `【2026-11-01T02:00:00Z 批】观测台新页 7 页签（${A}）`;
    const raw = scene(["## 事实", dateLine, absLine]);
    const r = deterministicSupersede(raw, { now: NOW });
    expect(r.markedLines).toHaveLength(0);
    expect(r.sparedNoDate).toBe(0); // 两行都有日期（一 date 一 abs），非无日期
    expect(r.sparedLowSim + r.sparedNoCandidate).toBeGreaterThanOrEqual(0);
  });

  it("真·无日期行：不标记、计入 sparedNoDate", () => {
    const noDate = `- 蒸馏页面 Tab 切换滚动稳定性修复落账（${A}）`;
    const withDate = `【11-08 批】蒸馏页面 Tab 切换滚动稳定性修复（${A}）`;
    const raw = scene(["## 事实", noDate, withDate]);
    const r = deterministicSupersede(raw, { now: NOW });
    expect(r.markedLines).toHaveLength(0);
    expect(r.sparedNoDate).toBe(1);
  });

  it("对照行排除保护区：要点段（受保护）即使日期更新也不作对照", () => {
    const factOld = `【2026-11-01T02:00:00Z 批】面板 32K 帽修复提交 cac9fa3（${A}）`;
    const gistNew = `要点：面板 32K 帽修复已生效（2026-11-08T03:00:00Z·${A}）`;
    const raw = scene(["## 要点", gistNew, "", "## 事实", factOld]).replace("meta: 摘要", `meta: 摘要含 ${A}`);
    const r = deterministicSupersede(raw, { now: NOW });
    expect(r.markedLines).toHaveLength(0);
    expect(r.sparedNoCandidate).toBe(1); // 唯一同锚对照在保护区 → 无候选
  });

  it("对照行排除已标行：已标行即使日期最新也不作对照", () => {
    const marked = `[SUPERSEDED 2026-11-01T00:00:00.000+08:00] 【2026-11-10T00:00:00Z 批】旧标记行（${A}）`;
    const old = `【2026-11-02T02:00:00Z 批】L2 批次上限 N=50（${A}）`;
    const neu = `【2026-11-08T03:00:00Z 批】L2 批次上限 N=50 复核（${A}）`;
    const raw = scene(["## 事实", marked, old, neu]);
    const r = deterministicSupersede(raw, { now: NOW });
    expect(r.markedLines).toEqual([idxOf(raw, "【2026-11-02T02:00:00Z 批】L2")]);
  });

  it("首匹配取胜：行中他批引用日期不把本行抬新", () => {
    const old = `【11-01 10:00Z 本批】对账闭合，另见 11-08 05:08Z 交叉留痕（${A}）`;
    const neu = `【11-05 10:00Z 本批】对账闭合复核，另见 11-08 05:08Z 交叉留痕（${A}）`;
    const raw = scene(["## 事实", old, neu]);
    const r = deterministicSupersede(raw, { now: NOW });
    expect(r.markedLines).toEqual([idxOf(raw, "【11-01 10:00Z")]);
  });

  it("既有口径保持：META/要点豁免、幂等、确定性、countSupersededChars 联动", () => {
    const old = `【2026-11-01T02:00:00Z 批】并发闸 maxConcurrency=4（${A}）`;
    const neu = `【2026-11-08T03:00:00Z 批】并发闸 maxConcurrency=4 复核（${A}）`;
    const raw = scene(["## 要点", `要点：并发闸（${A}）`, "", "## 事实", old, neu]);
    const r1 = deterministicSupersede(raw, { now: NOW });
    const r2 = deterministicSupersede(r1.content, { now: NOW });
    expect(r2.markedLines).toHaveLength(0);
    expect(r2.content).toBe(r1.content);
    const markedLine = r1.content.split("\n")[idxOf(raw, "【2026-11-01T02:00:00Z 批】并发闸")]!;
    expect(isSupersededLine(markedLine)).toBe(true);
    expect(countSupersededChars(r1.content)).toBe(markedLine.length + 1);
    expect(extractAnchorIds(r1.content).sort()).toEqual(extractAnchorIds(raw).sort());
  });

  it("多锚行高相似重投 → 标记，锚点 A/B 双双保留", () => {
    const old = `【2026-11-05T02:00:00Z 批】i-have-adhd 技能启用并长期化（${A}）＋工作流纪律入册（${B}）`;
    const neu = `【2026-11-08T03:00:00Z 批】i-have-adhd 技能启用并长期化（${A}）＋工作流纪律入册（${B}）复验在案`;
    const raw = scene(["## 事实", old, neu]);
    const r = deterministicSupersede(raw, { now: NOW });
    expect(r.markedLines).toEqual([idxOf(raw, "【2026-11-05T02:00:00Z 批】i-have-adhd")]);
    expect(extractAnchorIds(r.content).sort()).toEqual([A, B, A, B].sort());
  });

  it("低相似豁免计入 sparedLowSim；无锚文件逐字节不变", () => {
    const old = `【2026-11-01T02:00:00Z 批】L0 对账闭合，98 条差额归指纹闸（${A}）`;
    const neu = `【2026-11-08T03:00:00Z 批】④b 语义门 shadow 上线（另见 ${A} 交叉）`;
    const raw = scene(["## 事实", old, neu]);
    const r = deterministicSupersede(raw, { now: NOW });
    expect(r.markedLines).toHaveLength(0);
    expect(r.sparedLowSim).toBe(1);
    const plain = scene(["## 事实", "无锚叙述。", "再一行。"]);
    expect(deterministicSupersede(plain, { now: NOW }).content).toBe(plain);
  });
});
