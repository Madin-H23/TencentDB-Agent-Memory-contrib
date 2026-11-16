// 票 origin#36 第一分票（QA·auto-recall 覆盖增强）：格式化与预算纯函数层直测。
// 召回输出格式直接进 LLM 上下文（用户感受最重面）——这些纯函数此前零直接测试
//（全模块 1026 行零 test 引用·分支D 扫描发现）。纯函数零 IO·抽直测零风险。
import { describe, expect, it } from "vitest";
import {
  formatMemoryLine,
  applyRecallBudget,
  truncateRecallLine,
  formatTimestamp,
  normalizeBudgetLimit,
  type FormatableMemory,
} from "./auto-recall.js";

function mem(over: Partial<FormatableMemory>): FormatableMemory {
  return { type: "fact", content: "内容", ...over };
}

describe("formatMemoryLine：召回行格式化（origin#36 第一分票）", () => {
  it("type+scene_name 双段 tag；无 scene_name 只有 type", () => {
    expect(formatMemoryLine(mem({ scene_name: "研究场景" }))).toBe("- [fact|研究场景] 内容");
    expect(formatMemoryLine(mem({}))).toBe("- [fact] 内容");
  });

  it("段时间 start+end → 区间；只有 start → 起；只有 end → 至", () => {
    expect(formatMemoryLine(mem({ activity_start_time: "2026-11-01T09:00", activity_end_time: "2026-11-01T12:00" })))
      .toBe("- [fact] 内容 (活动时间: 2026-11-01 09:00 ~ 2026-11-01 12:00)");
    expect(formatMemoryLine(mem({ activity_start_time: "2026-11-01T09:00" })))
      .toBe("- [fact] 内容 (活动时间: 2026-11-01 09:00起)");
    expect(formatMemoryLine(mem({ activity_end_time: "2026-11-01T12:00" })))
      .toBe("- [fact] 内容 (活动时间: 至2026-11-01 12:00)");
  });

  it("点时间 timestamp 兜底；全空 → 无时间后缀（graceful）", () => {
    expect(formatMemoryLine(mem({ timestamp: "2026-11-16T20:30:00.000Z" })))
      .toBe("- [fact] 内容 (活动时间: 2026-11-16 20:30)");
    expect(formatMemoryLine(mem({})).includes("(活动时间")).toBe(false);
  });
});

describe("truncateRecallLine：码点安全截断（代理对不劈）", () => {
  it("短于/等于上限原样返回", () => {
    expect(truncateRecallLine("短行", 10)).toBe("短行");
  });

  it("超长截断 + 中文后缀（后缀计入预算·maxChars 须 > 后缀长）", () => {
    const line = "x".repeat(100);
    const out = truncateRecallLine(line, 80);
    expect(out.includes("已截断")).toBe(true); // 80 > 后缀长 → 后缀分支
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.startsWith("x".repeat(10))).toBe(true);
    // 边界对照：maxChars(50) < 后缀长 → 纯截断无后缀（实现正确边界）
    const pure = truncateRecallLine(line, 50);
    expect(pure.includes("已截断")).toBe(false);
    expect(pure.length).toBe(50);
  });

  it("代理对（非 BMP 字符）截断不劈码点——无 U+FFFD（审查 P2：精确断言钉实现）", () => {
    // 😀=U+1F600（2 UTF-16 码元·1 码点）；构造恰好劈中的长度
    const line = "a".repeat(49) + "😀" + "b".repeat(10);
    const out = truncateRecallLine(line, 50); // 码点 50 处恰在 😀 内
    expect(out.includes("\uFFFD")).toBe(false);
    // 精确断言（审查 P2：naive UTF-16 slice 缺陷下 includes/长度断言同样过——
    // 唯有精确值钉得住「码点安全」）：49 个 a + 😀（完整保住·b 全被截）
    expect(out).toBe("a".repeat(49) + "😀");
    // UTF-8 往返无替换字符（编码面双保险）
    expect(Buffer.from(out, "utf-8").toString("utf-8")).not.toContain("\uFFFD");
  });

  it("maxChars ≤ 后缀长度 → 纯截断无后缀", () => {
    const out = truncateRecallLine("abcdef", 3);
    expect(out).toBe("abc");
  });

  it("SUFFIX 等值边界族：59/60/61（审查 P3-1·SUFFIX=60 UTF-16 码元）", () => {
    // 60=后缀长等值 → 纯截断（≤ 分支）；61=后缀分支最小值
    const line = "y".repeat(100);
    const at59 = truncateRecallLine(line, 59);
    const at60 = truncateRecallLine(line, 60);
    const at61 = truncateRecallLine(line, 61);
    expect(at59.includes("已截断")).toBe(false);
    expect(at60.includes("已截断")).toBe(false);
    expect(at61.includes("已截断")).toBe(true);
    expect(at61.length).toBeLessThanOrEqual(61);
  });
});

describe("formatTimestamp：ISO 归一化", () => {
  it("datetime → 日期+时间（分粒度）", () => {
    expect(formatTimestamp("2026-11-16T20:30:00.000Z")).toBe("2026-11-16 20:30");
    expect(formatTimestamp("2026-11-16T20:30")).toBe("2026-11-16 20:30");
  });

  it("零点 → 仅日期", () => {
    expect(formatTimestamp("2026-11-16T00:00:00.000Z")).toBe("2026-11-16");
    expect(formatTimestamp("2026-11-16")).toBe("2026-11-16");
  });

  it("空/非法 → undefined", () => {
    expect(formatTimestamp(undefined)).toBeUndefined();
    expect(formatTimestamp("")).toBeUndefined();
    expect(formatTimestamp("不是日期")).toBeUndefined();
  });
});

describe("normalizeBudgetLimit：预算归一化", () => {
  it("null/0/负数/非有限 → undefined（=不启用预算）", () => {
    expect(normalizeBudgetLimit(undefined)).toBeUndefined();
    expect(normalizeBudgetLimit(null)).toBeUndefined();
    expect(normalizeBudgetLimit(0)).toBeUndefined();
    expect(normalizeBudgetLimit(-5)).toBeUndefined();
    expect(normalizeBudgetLimit(Number.NaN)).toBeUndefined();
    expect(normalizeBudgetLimit(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("正数向下取整", () => {
    expect(normalizeBudgetLimit(100.9)).toBe(100);
    expect(normalizeBudgetLimit(50)).toBe(50);
  });
});

describe("applyRecallBudget：双预算应用", () => {
  const noBudget = {} as never;

  it("无预算键 → 原样返回（逐字节不变）", () => {
    const lines = ["- [fact] a", "- [fact] b"];
    expect(applyRecallBudget(lines, noBudget)).toEqual(lines);
  });

  it("maxCharsPerMemory：超长行截断·短行原样（预算 ≤ 后缀长 → 纯截断无后缀·实现边界）", () => {
    const lines = ["- [fact] " + "x".repeat(100), "- [fact] 短"];
    const out = applyRecallBudget(lines, { maxCharsPerMemory: 30 } as never);
    expect(out).toHaveLength(2);
    expect(out[0].length).toBeLessThanOrEqual(30);
    expect(out[0].includes("已截断")).toBe(false); // 30 < 后缀长 → 纯截断分支（无后缀·实现正确边界）
    expect(out[1]).toBe("- [fact] 短");
  });

  it("maxTotalRecallChars：预算耗尽 → 后续行丢弃", () => {
    const lines = ["- [fact] " + "a".repeat(50), "- [fact] " + "b".repeat(50), "- [fact] c", "- [fact] d"];
    const out = applyRecallBudget(lines, { maxTotalRecallChars: 120 } as never);
    expect(out.length).toBeLessThan(lines.length);
    expect(out[0]).toContain("aaaa"); // 首行保留
    expect(out.some((l) => l.includes("dddd") || l.includes("- [fact] d"))).toBe(false); // 尾行被丢
  });

  it("双预算组合：perMemory 先截·total 再裁", () => {
    const lines = ["- [fact] " + "a".repeat(200), "- [fact] " + "b".repeat(200), "- [fact] " + "c".repeat(200)];
    const out = applyRecallBudget(lines, { maxCharsPerMemory: 50, maxTotalRecallChars: 120 } as never);
    expect(out.every((l) => l.length <= 50)).toBe(true); // 每行 ≤50
    expect(out.join("\n").length).toBeLessThanOrEqual(120 + (out.length - 1)); // 总量受控（含分隔符）
  });
});
