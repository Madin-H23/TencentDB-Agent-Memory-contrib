// D1 提示词版本测试（v1 默认不变 / v2 三条款 / 无效版本 fail-fast）。
// v2 = v1 + 三条款（M1 方案 D1）：①同一事实不同措辞或互补阶段必须 merge/skip；
// ②判 store 须填单个 store_diff 字段（无内容不得判 store）；
// ③新增防误合告诫（同主题不同事实/对象/时间点必须 store 并给出区分依据）。
import { describe, it, expect } from "vitest";
import { getConflictDetectionSystemPrompt } from "./l1-dedup.js";

describe("getConflictDetectionSystemPrompt 版本开关", () => {
  it("缺省 version = v1，与显式 v1 逐字一致（生产默认行为不变）", () => {
    expect(getConflictDetectionSystemPrompt("chat")).toBe(getConflictDetectionSystemPrompt("chat", "v1"));
    expect(getConflictDetectionSystemPrompt("code", "v1")).toBe(getConflictDetectionSystemPrompt("code"));
  });

  it("v2 = v1 全文 + 三条款（不删改任何 v1 内容——可回退、可 diff）", () => {
    const v1 = getConflictDetectionSystemPrompt("chat", "v1");
    const v2 = getConflictDetectionSystemPrompt("chat", "v2");
    expect(v2.startsWith(v1)).toBe(true);
    expect(v2.length).toBeGreaterThan(v1.length + 200);
  });

  it("v2 含三条款的可检出海签名", () => {
    const v2 = getConflictDetectionSystemPrompt("chat", "v2");
    // ① 不同措辞/互补阶段 → merge/skip
    expect(v2).toContain("不同措辞");
    expect(v2).toMatch(/互补阶段/);
    // ② 单字段 store_diff
    expect(v2).toContain("store_diff");
    // ③ 防误合告诫
    expect(v2).toMatch(/不同事实/);
    expect(v2).toMatch(/区分依据/);
  });

  it("code 模式同样支持 v2", () => {
    const v1 = getConflictDetectionSystemPrompt("code", "v1");
    const v2 = getConflictDetectionSystemPrompt("code", "v2");
    expect(v2.startsWith(v1)).toBe(true);
    expect(v2).toContain("store_diff");
  });

  it("无效版本 fail-fast（拼写错误静默失效比报错更危险）", () => {
    expect(() => getConflictDetectionSystemPrompt("chat", "v3" as "v2")).toThrow(/dedupPromptVersion/);
  });
});
