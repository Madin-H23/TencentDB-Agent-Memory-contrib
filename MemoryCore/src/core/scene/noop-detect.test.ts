import { describe, expect, it } from "vitest";
import { isNoopSceneDiff } from "./noop-detect.js";

describe("isNoopSceneDiff（L2 全零 diff 观测）", () => {
  it("三者全零才算 no-op", () => {
    expect(isNoopSceneDiff(0, 0, 0)).toBe(true);
  });

  it("任意一项非零都不算（含只有更新、只有删除、只有新建）", () => {
    expect(isNoopSceneDiff(1, 0, 0)).toBe(false);
    expect(isNoopSceneDiff(0, 2, 0)).toBe(false);
    expect(isNoopSceneDiff(0, 0, 3)).toBe(false);
    expect(isNoopSceneDiff(1, 1, 1)).toBe(false);
  });

  it("回归钉：10-21 18:23 那次 steps=20/output=0 但 updated=8，不得判成 no-op", () => {
    expect(isNoopSceneDiff(0, 8, 0)).toBe(false);
  });
});
