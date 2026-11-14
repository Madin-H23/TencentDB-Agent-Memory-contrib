// 票 TICKETS-C-read-dedup-20261113.md（T2）：persona.l2ReadDedup 配置解析（拒绝式）。
// 缺省关闭；true=shadow（安全默认=影子先量）；对象可调 mode；非法 throw。
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";
import { parseL2ReadDedupConfig } from "./utils/read-dedup.js";

const ENV_KEY = "TDAI_L2_READ_DEDUP_STATE_TEST";

describe("parseL2ReadDedupConfig（utils/read-dedup）", () => {
  const originalEnv = process.env[ENV_KEY];
  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
  });

  it("undefined/null/false → undefined（off，schema 与行为逐字节不变）", () => {
    expect(parseL2ReadDedupConfig(undefined)).toBeUndefined();
    expect(parseL2ReadDedupConfig(null)).toBeUndefined();
    expect(parseL2ReadDedupConfig(false)).toBeUndefined();
  });

  it("true → shadow（安全默认）", () => {
    expect(parseL2ReadDedupConfig(true)).toEqual({ mode: "shadow" });
  });

  it("对象缺省字段回落 shadow", () => {
    expect(parseL2ReadDedupConfig({})).toEqual({ mode: "shadow" });
  });

  it("对象 mode=on 透传", () => {
    expect(parseL2ReadDedupConfig({ mode: "on" })).toEqual({ mode: "on" });
  });

  it("mode=off → undefined（关闭）", () => {
    expect(parseL2ReadDedupConfig({ mode: "off" })).toBeUndefined();
  });

  it("非法 mode / 非布尔非对象 → throw（不静默回落）", () => {
    expect(() => parseL2ReadDedupConfig({ mode: "always" })).toThrow();
    expect(() => parseL2ReadDedupConfig("on")).toThrow();
    expect(() => parseL2ReadDedupConfig(42)).toThrow();
    expect(() => parseL2ReadDedupConfig([])).toThrow();
  });
});

describe("parseConfig：persona.l2ReadDedup", () => {
  it("缺省 → undefined", () => {
    expect(parseConfig({}).persona.l2ReadDedup).toBeUndefined();
  });

  it("true → shadow 透传", () => {
    expect(parseConfig({ persona: { l2ReadDedup: true } }).persona.l2ReadDedup).toEqual({ mode: "shadow" });
  });

  it("对象透传 + 非法 throw", () => {
    expect(parseConfig({ persona: { l2ReadDedup: { mode: "on" } } }).persona.l2ReadDedup).toEqual({ mode: "on" });
    expect(() => parseConfig({ persona: { l2ReadDedup: { mode: "x" } } })).toThrow();
  });
});
