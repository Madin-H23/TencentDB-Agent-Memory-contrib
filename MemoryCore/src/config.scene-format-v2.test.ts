// 票⑤（exp/p1-5-scene-format-v2）：persona.sceneFormatV2 配置解析。
// 默认 false=off（bool() 只吃真实布尔，非布尔原样 undefined → ?? false）。
import { describe, it, expect } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig：persona.sceneFormatV2 解析", () => {
  it("缺省 → false（off=行为与基线逐字节一致）", () => {
    const cfg = parseConfig({});
    expect(cfg.persona.sceneFormatV2).toBe(false);
  });

  it("显式 true → on；显式 false → off", () => {
    expect(parseConfig({ persona: { sceneFormatV2: true } }).persona.sceneFormatV2).toBe(true);
    expect(parseConfig({ persona: { sceneFormatV2: false } }).persona.sceneFormatV2).toBe(false);
  });

  it("非法类型（字符串/数字）→ 回退 off", () => {
    expect(parseConfig({ persona: { sceneFormatV2: "true" as unknown as boolean } }).persona.sceneFormatV2).toBe(false);
    expect(parseConfig({ persona: { sceneFormatV2: 1 as unknown as boolean } }).persona.sceneFormatV2).toBe(false);
  });
});
