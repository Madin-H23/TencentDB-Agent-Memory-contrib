// 方案C（exp/l2-plan-c-write-cap）：L2 场景块写入后像尺寸帽 —— 纯函数直测。
// 语义：cap>0 且 chars>cap → 结构化拒绝（不落盘）；cap≤0/undefined → off；chars==cap → 放行。
// 注意：[DELETED] 豁免是 write 工具的调用侧策略，本函数内容无关（见测试 7）。
import { describe, expect, it } from "vitest";
import { checkSceneCharCap, SCENE_CHAR_CAP_HINT } from "./scene-char-cap.js";

describe("checkSceneCharCap：场景块写入后像尺寸帽（纯函数）", () => {
  it("cap=undefined → off（null）", () => {
    expect(checkSceneCharCap("x".repeat(99_999), undefined)).toBeNull();
  });

  it("cap=0 → off（null）", () => {
    expect(checkSceneCharCap("x".repeat(99_999), 0)).toBeNull();
  });

  it("cap 为负数 → off（null）", () => {
    expect(checkSceneCharCap("x".repeat(99_999), -1)).toBeNull();
  });

  it("chars==cap 恰好等于帽 → 放行（null）", () => {
    expect(checkSceneCharCap("x".repeat(1000), 1000)).toBeNull();
  });

  it("chars==cap+1 → 拒绝，overflow=1", () => {
    const rej = checkSceneCharCap("x".repeat(1001), 1000);
    expect(rej).not.toBeNull();
    expect(rej!.overflow).toBe(1);
  });

  it("拒绝对象字段完整：error/chars/cap/overflow/hint", () => {
    const rej = checkSceneCharCap("x".repeat(1500), 1000)!;
    expect(rej.error).toBe("over_scene_char_cap");
    expect(rej.chars).toBe(1500);
    expect(rej.cap).toBe(1000);
    expect(rej.overflow).toBe(500);
    expect(rej.hint).toBe(SCENE_CHAR_CAP_HINT);
    expect(typeof rej.hint).toBe("string");
    expect(rej.hint.length).toBeGreaterThan(0);
  });

  it("helper 内容无关：'[DELETED]' 超帽同样拒绝（豁免在 write 调用侧判定）", () => {
    expect(checkSceneCharCap("[DELETED]", 5)).not.toBeNull();
  });
});
