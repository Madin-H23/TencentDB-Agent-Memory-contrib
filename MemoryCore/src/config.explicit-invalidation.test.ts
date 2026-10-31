// 票⑥（exp/p1-6-supersede-inval）：persona.explicitInvalidation 配置解析。
// 默认 false=off（bool() 只吃真实布尔，非布尔原样 undefined → ?? false）。
import { describe, it, expect } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig：persona.explicitInvalidation 解析", () => {
  it("缺省 → false（off=行为与基线逐字节一致）", () => {
    const cfg = parseConfig({});
    expect(cfg.persona.explicitInvalidation).toBe(false);
  });

  it("显式 true → on；显式 false → off", () => {
    expect(parseConfig({ persona: { explicitInvalidation: true } }).persona.explicitInvalidation).toBe(true);
    expect(parseConfig({ persona: { explicitInvalidation: false } }).persona.explicitInvalidation).toBe(false);
  });

  it("非法类型（字符串/数字）→ 回退 off", () => {
    expect(parseConfig({ persona: { explicitInvalidation: "true" as unknown as boolean } }).persona.explicitInvalidation).toBe(false);
    expect(parseConfig({ persona: { explicitInvalidation: 1 as unknown as boolean } }).persona.explicitInvalidation).toBe(false);
  });
});
