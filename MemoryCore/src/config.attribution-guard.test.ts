// extraction.attributionGuard / correctionException 配置解析测试（2026-09-25 方案 B）
//
// attributionGuard 缺省必须是 "off"（2026-09-25 撤护栏拍板：消息级判据实测误杀率
// ~60%、金标 44%→24%，收益不成立），非法值 fail-fast（拼写错误静默失效比报错更
// 危险——与 llm.layers 未知层键同策略）；correctionException 缺省 false。
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("extraction.attributionGuard 配置解析", () => {
  it("未配置 → 默认 off（撤护栏拍板后的生产行为）", () => {
    const cfg = parseConfig({});
    expect(cfg.extraction.attributionGuard).toBe("off");
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

  it("空字符串 attributionGuard 视为未配置（走默认 off）", () => {
    expect(parseConfig({ extraction: { attributionGuard: "" } }).extraction.attributionGuard).toBe("off");
  });
});
