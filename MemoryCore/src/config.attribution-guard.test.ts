// extraction.attributionGuard / correctionException 配置解析测试（2026-09-25 方案 B）
//
// attributionGuard 缺省必须是 "strict"（与 00db4ef 引入护栏后的行为逐字一致），
// 非法值 fail-fast（拼写错误静默失效比报错更危险——与 llm.layers 未知层键同策略）；
// correctionException 缺省 false（例外条款默认不注入）。
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("extraction.attributionGuard 配置解析", () => {
  it("未配置 → 默认 strict（护栏保持 2026-09-25 行为）", () => {
    const cfg = parseConfig({});
    expect(cfg.extraction.attributionGuard).toBe("strict");
    expect(cfg.extraction.correctionException).toBe(false);
  });

  it("三个合法枚举值各自 round-trip", () => {
    for (const v of ["strict", "batch-confirm", "off"] as const) {
      expect(parseConfig({ extraction: { attributionGuard: v } }).extraction.attributionGuard).toBe(v);
    }
  });

  it("非法值 fail-fast 而非静默回落", () => {
    expect(() => parseConfig({ extraction: { attributionGuard: "loose" } })).toThrow(/attributionGuard/);
    expect(() => parseConfig({ extraction: { attributionGuard: "BATCH-CONFIRM" } })).toThrow(/attributionGuard/);
    expect(() => parseConfig({ extraction: { attributionGuard: 123 } })).toThrow(/attributionGuard/);
  });

  it("correctionException: true 正确透传", () => {
    expect(parseConfig({ extraction: { correctionException: true } }).extraction.correctionException).toBe(true);
  });

  it("空字符串 attributionGuard 视为未配置（走默认 strict）", () => {
    expect(parseConfig({ extraction: { attributionGuard: "" } }).extraction.attributionGuard).toBe("strict");
  });
});
