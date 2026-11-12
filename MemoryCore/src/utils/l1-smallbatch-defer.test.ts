// 票 P2-A2（exp/p2-a2-l1-smallbatch-defer）：L1 小批空转攒批——pure 层测试。
// 背景：实测 178 轮 l1-empty 中 171 轮（96%）inputMsgs ≤3，每轮一次 LLM 调用判
// 「无可记」（reason=empty_scenes）。本机制在 runner 内做门槛前置 early-return：
// 小批不立即提取 → defer（游标不动，沿用 P0-Fix2 语义）→ 消息自然累积 → 越过
// 门槛才提取。零内容丢失由游标语义保证（cursor 按 recorded_at_ms 推进，defer 不
// 调 markL1ExtractionComplete ⇒ 下轮查询 >cursor 必含旧+新消息）。
//
// 精确判据（票面「审查放行+三项补齐」）：
//   defer ⇔ (全片 qualified 总数 > 0)
//         ∧ (各组 qualified 均 < minMessages)
//         ∧ (本片 qualified 总 chars < minChars)
//         ∧ (age(切片最旧行) ≤ maxDeferAgeMs)
//         ∧ 无残余行（queriedCount ≤ sliceEnd）
// 判据为纯函数（零 I/O），接线在 pipeline-factory L1 runner（组并行池前·整片
// all-or-nothing·P0-1）。
import { describe, it, expect } from "vitest";
import {
  parseL1SmallBatchDeferConfig,
  deferDecision,
  L1_SMALLBATCH_DEFER_DEFAULT_MIN_MESSAGES,
  L1_SMALLBATCH_DEFER_DEFAULT_MIN_CHARS,
  L1_SMALLBATCH_DEFER_DEFAULT_MAX_DEFER_AGE_MS,
  L1_SMALLBATCH_DEFER_MAX_MIN_MESSAGES,
  type L1SmallBatchDeferConfig,
} from "./l1-smallbatch-defer.js";
import { L1_BATCH_PROCESS } from "./pipeline-factory.js";

const NOW = 1_700_000_000_000;

/** 基准 cfg：on + K5 + chars200 + 30min（= true 的安全默认）。 */
const CFG: L1SmallBatchDeferConfig = {
  enabled: true,
  mode: "on",
  minMessages: 5,
  minChars: 200,
  maxDeferAgeMs: 1_800_000,
};

function g(sessionId: string, qualified: number, chars: number) {
  return { sessionId, qualified, chars };
}

/** 基准输入：单 sid qualified=2 / chars=50 / age=60s / 无残余 → 低于全部门槛。 */
function decide(over: Partial<Parameters<typeof deferDecision>[0]> = {}) {
  return deferDecision({
    groups: [g("s1", 2, 50)],
    oldestRecordedAtMs: NOW - 60_000,
    nowMs: NOW,
    hasResidual: false,
    cfg: CFG,
    ...over,
  });
}

describe("deferDecision：小批延后攒批判据（票 P2-A2 精确判据）", () => {
  it("qualified < minMessages（且 chars 低/age 低/无残余）→ defer", () => {
    const d = decide();
    expect(d.defer).toBe(true);
    expect(d.reason).toBeUndefined();
    expect(d.qualified).toBe(2);
    expect(d.chars).toBe(50);
    expect(d.qualifiedGroups).toBe(0);
    expect(d.ageMs).toBe(60_000);
  });

  it("qualified == minMessages → 不 defer（组达标即整片提取）", () => {
    const d = decide({ groups: [g("s1", 5, 50)] });
    expect(d.defer).toBe(false);
    expect(d.reason).toBe("group_qualified");
    expect(d.qualifiedGroups).toBe(1);
  });

  it("qualified > minMessages → 不 defer", () => {
    const d = decide({ groups: [g("s1", 8, 50)] });
    expect(d.defer).toBe(false);
    expect(d.reason).toBe("group_qualified");
  });

  it("全噪声批（qualified==0）→ 不 defer（保持现行免 LLM 早返回语义，P1-1）", () => {
    const d = decide({ groups: [g("s1", 0, 0)] });
    expect(d.defer).toBe(false);
    expect(d.reason).toBe("no_qualified");
  });

  it("多组任一组达标 → 整片不 defer（P0-1 all-or-nothing）", () => {
    const d = decide({ groups: [g("sA", 5, 30), g("sB", 1, 20)] });
    expect(d.defer).toBe(false);
    expect(d.reason).toBe("group_qualified");
    expect(d.qualified).toBe(6);
  });

  it("全组低于（各组 2+3=5 合计达标但按组判）→ 整片 defer", () => {
    const d = decide({ groups: [g("sA", 2, 30), g("sB", 3, 40)] });
    expect(d.defer).toBe(true);
    expect(d.qualified).toBe(5);
    expect(d.qualifiedGroups).toBe(0);
  });

  it("age > maxDeferAgeMs → 强制提取；age == 阈值边界 → 仍可 defer", () => {
    const over = decide({ groups: [g("s1", 2, 50)], oldestRecordedAtMs: NOW - 1_800_001 });
    expect(over.defer).toBe(false);
    expect(over.reason).toBe("max_defer_age");
    expect(over.ageMs).toBe(1_800_001);
    const atEdge = decide({ oldestRecordedAtMs: NOW - 1_800_000 });
    expect(atEdge.defer).toBe(true);
  });

  it("chars < minChars → defer（S3 OR 判据的字符支）", () => {
    const d = decide({ groups: [g("s1", 2, 199)] });
    expect(d.defer).toBe(true);
    const d0 = decide({ groups: [g("s1", 2, 0)] });
    expect(d0.defer).toBe(true);
  });

  it("chars ≥ minChars（qualified<K 但单条长消息含事实）→ 立即提取（S2 价值）", () => {
    const d = decide({ groups: [g("s1", 2, 200)] });
    expect(d.defer).toBe(false);
    expect(d.reason).toBe("min_chars");
    const dOver = decide({ groups: [g("s1", 2, 5000)] });
    expect(dOver.defer).toBe(false);
    expect(dOver.reason).toBe("min_chars");
  });

  it("有残余行（hasResidual）→ 不 defer（补齐 2：保 backlog drain 不停摆）", () => {
    const d = decide({ hasResidual: true });
    expect(d.defer).toBe(false);
    expect(d.reason).toBe("residual_rows");
    // 残余 + 噪声也优先报 no_qualified（信息量更大的原因）
    const d2 = decide({ hasResidual: true, groups: [g("s1", 0, 0)] });
    expect(d2.reason).toBe("no_qualified");
  });

  it("保护负例：空 groups / ageMs 负（时钟回拨）/ minChars=0 关闭字符判据", () => {
    // 空 groups：qualified=0 ⇒ 与全噪声同口径，不进攒批
    expect(decide({ groups: [] }).defer).toBe(false);
    expect(decide({ groups: [] }).reason).toBe("no_qualified");
    // 时钟回拨：ageMs 为负 ≤ maxDeferAgeMs，不抛异常且仍可 defer
    const skewed = decide({ oldestRecordedAtMs: NOW + 60_000 });
    expect(skewed.ageMs).toBe(-60_000);
    expect(skewed.defer).toBe(true);
    // minChars=0：chars 条件（chars < 0）恒假 ⇒ 永不 defer——阈值即边界，无隐式开关
    const noChars = decide({ cfg: { ...CFG, minChars: 0 }, groups: [g("s1", 2, 10_000)] });
    expect(noChars.defer).toBe(false);
    expect(noChars.reason).toBe("min_chars");
  });

  it("全条件矩阵：defer=true 仅当五条件同时成立，逐条翻转任一条件即提取", () => {
    // 基准：全部满足 → defer
    expect(decide().defer).toBe(true);
    // 翻转 1：qualified 归零（噪声）
    expect(decide({ groups: [g("s1", 0, 0)] }).defer).toBe(false);
    // 翻转 2：出现残余行
    expect(decide({ hasResidual: true }).defer).toBe(false);
    // 翻转 3：某组 qualified 达门槛
    expect(decide({ groups: [g("sA", 2, 30), g("sB", 5, 20)] }).defer).toBe(false);
    // 翻转 4：chars 达门槛
    expect(decide({ groups: [g("s1", 2, 200)] }).defer).toBe(false);
    // 翻转 5：age 超阈
    expect(decide({ oldestRecordedAtMs: NOW - 1_800_001 }).defer).toBe(false);
    // 全翻转后回到基准仍 defer（无状态残留）
    expect(decide().defer).toBe(true);
  });
});

describe("parseL1SmallBatchDeferConfig：persona.l1SmallBatchDefer 解析（拒绝式）", () => {
  it("缺省 / null / false → undefined（off，零行为）", () => {
    expect(parseL1SmallBatchDeferConfig(undefined)).toBeUndefined();
    expect(parseL1SmallBatchDeferConfig(null)).toBeUndefined();
    expect(parseL1SmallBatchDeferConfig(false)).toBeUndefined();
  });

  it("true → shadow + K5 + chars200 + 30min（安全默认=影子先量）", () => {
    expect(parseL1SmallBatchDeferConfig(true)).toEqual({
      enabled: true,
      mode: "shadow",
      minMessages: L1_SMALLBATCH_DEFER_DEFAULT_MIN_MESSAGES,
      minChars: L1_SMALLBATCH_DEFER_DEFAULT_MIN_CHARS,
      maxDeferAgeMs: L1_SMALLBATCH_DEFER_DEFAULT_MAX_DEFER_AGE_MS,
    });
    expect(L1_SMALLBATCH_DEFER_DEFAULT_MIN_MESSAGES).toBe(5);
    expect(L1_SMALLBATCH_DEFER_DEFAULT_MIN_CHARS).toBe(200);
    expect(L1_SMALLBATCH_DEFER_DEFAULT_MAX_DEFER_AGE_MS).toBe(1_800_000);
  });

  it("对象：缺省字段回落（enabled/mode/minMessages/minChars/maxDeferAgeMs）", () => {
    expect(parseL1SmallBatchDeferConfig({})).toEqual({
      enabled: true,
      mode: "shadow",
      minMessages: 5,
      minChars: 200,
      maxDeferAgeMs: 1_800_000,
    });
    expect(parseL1SmallBatchDeferConfig({ mode: "on", minMessages: 3, minChars: 500, maxDeferAgeMs: 60_000 })).toEqual({
      enabled: true,
      mode: "on",
      minMessages: 3,
      minChars: 500,
      maxDeferAgeMs: 60_000,
    });
  });

  it("enabled:false / mode:'off' → undefined（显式关闭）", () => {
    expect(parseL1SmallBatchDeferConfig({ enabled: false })).toBeUndefined();
    expect(parseL1SmallBatchDeferConfig({ mode: "off" })).toBeUndefined();
  });

  it("mode 非法（含大小写变体）→ throw", () => {
    expect(() => parseL1SmallBatchDeferConfig({ mode: "ON" })).toThrow(/l1SmallBatchDefer\.mode/);
    expect(() => parseL1SmallBatchDeferConfig({ mode: "Shadow" })).toThrow(/l1SmallBatchDefer\.mode/);
    expect(() => parseL1SmallBatchDeferConfig({ mode: true })).toThrow(/l1SmallBatchDefer\.mode/);
  });

  it("minMessages：=10 边界放行；0 / 11 / 负数 / 非整数 / 非数 → throw（P0-4 ≤切片上限）", () => {
    expect(parseL1SmallBatchDeferConfig({ minMessages: 10 })?.minMessages).toBe(10);
    expect(parseL1SmallBatchDeferConfig({ minMessages: 1 })?.minMessages).toBe(1);
    expect(() => parseL1SmallBatchDeferConfig({ minMessages: 0 })).toThrow(/l1SmallBatchDefer\.minMessages/);
    expect(() => parseL1SmallBatchDeferConfig({ minMessages: 11 })).toThrow(/l1SmallBatchDefer\.minMessages/);
    expect(() => parseL1SmallBatchDeferConfig({ minMessages: -3 })).toThrow(/l1SmallBatchDefer\.minMessages/);
    expect(() => parseL1SmallBatchDeferConfig({ minMessages: 5.5 })).toThrow(/l1SmallBatchDefer\.minMessages/);
    expect(() => parseL1SmallBatchDeferConfig({ minMessages: "5" })).toThrow(/l1SmallBatchDefer\.minMessages/);
    expect(() => parseL1SmallBatchDeferConfig({ minMessages: Number.NaN })).toThrow(/l1SmallBatchDefer\.minMessages/);
  });

  it("minChars：0 放行（关闭字符判据）；负 / NaN / 非数 → throw", () => {
    expect(parseL1SmallBatchDeferConfig({ minChars: 0 })?.minChars).toBe(0);
    expect(() => parseL1SmallBatchDeferConfig({ minChars: -1 })).toThrow(/l1SmallBatchDefer\.minChars/);
    expect(() => parseL1SmallBatchDeferConfig({ minChars: Number.NaN })).toThrow(/l1SmallBatchDefer\.minChars/);
    expect(() => parseL1SmallBatchDeferConfig({ minChars: "200" })).toThrow(/l1SmallBatchDefer\.minChars/);
  });

  it("maxDeferAgeMs：正有限放行；0 / 负 / NaN / Infinity → throw", () => {
    expect(parseL1SmallBatchDeferConfig({ maxDeferAgeMs: 1 })?.maxDeferAgeMs).toBe(1);
    expect(() => parseL1SmallBatchDeferConfig({ maxDeferAgeMs: 0 })).toThrow(/l1SmallBatchDefer\.maxDeferAgeMs/);
    expect(() => parseL1SmallBatchDeferConfig({ maxDeferAgeMs: -1 })).toThrow(/l1SmallBatchDefer\.maxDeferAgeMs/);
    expect(() => parseL1SmallBatchDeferConfig({ maxDeferAgeMs: Number.NaN })).toThrow(/l1SmallBatchDefer\.maxDeferAgeMs/);
    expect(() => parseL1SmallBatchDeferConfig({ maxDeferAgeMs: Number.POSITIVE_INFINITY })).toThrow(/l1SmallBatchDefer\.maxDeferAgeMs/);
  });

  it("非布尔非对象（字符串 / 数组 / 数字）→ throw", () => {
    expect(() => parseL1SmallBatchDeferConfig("on")).toThrow(/l1SmallBatchDefer/);
    expect(() => parseL1SmallBatchDeferConfig([])).toThrow(/l1SmallBatchDefer/);
    expect(() => parseL1SmallBatchDeferConfig(1)).toThrow(/l1SmallBatchDefer/);
  });

  it("跨模块互钉：minMessages 上限 == L1_BATCH_PROCESS（切片上限，P0-4）", () => {
    expect(L1_SMALLBATCH_DEFER_MAX_MIN_MESSAGES).toBe(L1_BATCH_PROCESS);
  });
});
