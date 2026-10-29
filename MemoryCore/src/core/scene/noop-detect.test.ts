import { describe, expect, it } from "vitest";
import {
  isNoopSceneDiff,
  nextZeroDiffEmptyOutputGate,
  L2_ZERO_DIFF_EMPTY_OUTPUT_MAX,
} from "./noop-detect.js";

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

describe("nextZeroDiffEmptyOutputGate（零 diff 且空输出：阻断游标 + quarantine 防风暴）", () => {
  it("前 MAX-1 次阻断并递增计数", () => {
    expect(L2_ZERO_DIFF_EMPTY_OUTPUT_MAX).toBe(3);
    expect(nextZeroDiffEmptyOutputGate(0)).toEqual({ gate: true, quarantine: false, strikes: 1 });
    expect(nextZeroDiffEmptyOutputGate(1)).toEqual({ gate: true, quarantine: false, strikes: 2 });
  });

  it("第 MAX 次触发 quarantine 放行并复位", () => {
    expect(nextZeroDiffEmptyOutputGate(2)).toEqual({ gate: false, quarantine: true, strikes: 0 });
  });

  it("quarantine 后重新计数（下一轮再次从阻断开始）", () => {
    expect(nextZeroDiffEmptyOutputGate(0).gate).toBe(true);
  });
});
