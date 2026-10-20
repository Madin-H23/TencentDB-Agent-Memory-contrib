// 场景摘要规范化（批次 2.2）：脱敏 + 按预算截断，作用于**索引视图**，
// 不改动场景文件本体。场景文件写入路径的强制裁剪属上游 PR #1591（不可逆，另行处置）。
//
// 覆盖：正常路径、边界（恰好等于预算/超一字符）、异常输入、幂等、误伤防护。
import { describe, expect, it } from "vitest";
import { normalizeSceneSummary, SCENE_SUMMARY_CHAR_BUDGET } from "./scene-format.js";
import { PII_REDACTION } from "../../utils/pii-redact.js";

describe("normalizeSceneSummary：脱敏", () => {
  it("私有邮箱被遮蔽", () => {
    const out = normalizeSceneSummary("收件统一 hewj23@163.com");
    expect(out).not.toContain("hewj23");
    expect(out).toContain(PII_REDACTION);
  });

  it("手机号邮箱整体遮蔽，域名不残留", () => {
    const out = normalizeSceneSummary("联系 13400526758@163.com");
    expect(out).not.toContain("@163.com");
  });

  it("无 PII 的摘要原样返回", () => {
    const s = "D2 灰度观测至第 11/16 次，活库同文组回落至 1";
    expect(normalizeSceneSummary(s)).toBe(s);
  });
});

describe("normalizeSceneSummary：截断", () => {
  it("短于预算 → 不截断", () => {
    const s = "短摘要";
    expect(normalizeSceneSummary(s)).toBe(s);
  });

  it("恰好等于预算 → 不截断", () => {
    const s = "a".repeat(SCENE_SUMMARY_CHAR_BUDGET);
    expect(normalizeSceneSummary(s)).toBe(s);
  });

  it("超预算 → 截断到预算内并带省略标记", () => {
    const s = "a".repeat(SCENE_SUMMARY_CHAR_BUDGET + 100);
    const out = normalizeSceneSummary(s);
    expect(out.length).toBe(SCENE_SUMMARY_CHAR_BUDGET);
    expect(out.endsWith("…")).toBe(true);
  });

  it("超长真实摘要（现场 31012 字符）被压到预算内", () => {
    const s = "【10-20 06:40Z 本批·★装机落盘位】".repeat(2000);
    const out = normalizeSceneSummary(s);
    expect(out.length).toBeLessThanOrEqual(SCENE_SUMMARY_CHAR_BUDGET);
  });

  it("自定义预算生效", () => {
    const s = "a".repeat(100);
    expect(normalizeSceneSummary(s, 10).length).toBe(10);
  });

  it("预算为 0 → 返回空串（不返回未截断原文）", () => {
    expect(normalizeSceneSummary("a".repeat(100), 0)).toBe("");
  });

  it("截断不劈开代理对（emoji 结尾不被切成乱码）", () => {
    // "😀" 是代理对 U+D83D U+DE00；预算切在中间时不得留下孤立高代理
    const s = "😀".repeat(50);
    const out = normalizeSceneSummary(s, 5);
    expect(out.length).toBeLessThanOrEqual(5);
    const last = out.charCodeAt(out.length - 2);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });
});

describe("normalizeSceneSummary：异常输入", () => {
  it("空串 → 空串", () => {
    expect(normalizeSceneSummary("")).toBe("");
  });

  it("undefined/null 不抛异常", () => {
    expect(normalizeSceneSummary(undefined as unknown as string)).toBe("");
    expect(normalizeSceneSummary(null as unknown as string)).toBe("");
  });
});

describe("normalizeSceneSummary：幂等", () => {
  it("对已规范化的摘要再次调用不产生变化", () => {
    const once = normalizeSceneSummary("收件 hewj23@163.com " + "x".repeat(500));
    expect(normalizeSceneSummary(once)).toBe(once);
  });
});
