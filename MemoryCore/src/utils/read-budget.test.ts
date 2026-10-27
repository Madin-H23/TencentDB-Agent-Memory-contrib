import { describe, expect, it } from "vitest";
import {
  READ_BUDGET_ANCHOR,
  READ_BUDGET_CHARS_PER_FILE,
  READ_BUDGET_CHARS_PER_RUN,
  ReadBudgetTracker,
  formatReadBudgetObservation,
} from "./read-budget.js";

describe("ReadBudgetTracker（S0 影子计量）", () => {
  it("默认帽值：单文件 32K、单 run 80K", () => {
    expect(READ_BUDGET_CHARS_PER_FILE).toBe(32_000);
    expect(READ_BUDGET_CHARS_PER_RUN).toBe(80_000);
  });

  it("单文件恰好等于帽值不算超限，帽值 +1 才算", () => {
    const tracker = new ReadBudgetTracker();
    expect(tracker.observe("a.md", 32_000).overFile).toBe(false);
    expect(tracker.observe("b.md", 32_001).overFile).toBe(true);
  });

  it("累计只在跨过 80K 的那一次标记 crossedRunBudget", () => {
    const tracker = new ReadBudgetTracker();
    const first = tracker.observe("a.md", 30_000);
    const second = tracker.observe("b.md", 30_000);
    const third = tracker.observe("c.md", 30_000);
    expect(first.crossedRunBudget).toBe(false);
    expect(second.crossedRunBudget).toBe(false);
    expect(third.crossedRunBudget).toBe(true);
    expect(third.runChars).toBe(90_000);
    expect(tracker.totalChars).toBe(90_000);
  });

  it("自定义帽值生效", () => {
    const tracker = new ReadBudgetTracker(10, 15);
    expect(tracker.observe("a.md", 11).overFile).toBe(true);
    expect(tracker.observe("b.md", 5).crossedRunBudget).toBe(true);
  });

  it("格式化输出带稳定锚点与全部读数", () => {
    const tracker = new ReadBudgetTracker();
    const line = formatReadBudgetObservation(tracker.observe("场景.md", 32_001));
    expect(line).toContain(READ_BUDGET_ANCHOR);
    expect(line).toContain('path="场景.md"');
    expect(line).toContain("chars=32001");
    expect(line).toContain("run_chars=32001");
    expect(line).toContain("over_file=true");
    expect(line).toContain("over_run=false");
  });

  // 2026-10-27：read 事件补 run 归属——验收按 taskId 聚合，不再靠 run_chars 回退猜边界。
  it("格式化输出带 task_id；未提供时退化为 (none)", () => {
    const tracker = new ReadBudgetTracker();
    const withId = formatReadBudgetObservation(tracker.observe("a.md", 10), "scene-extract-1793068158533");
    expect(withId).toContain("task_id=scene-extract-1793068158533");
    const without = formatReadBudgetObservation(tracker.observe("b.md", 10));
    expect(without).toContain("task_id=(none)");
  });
});
