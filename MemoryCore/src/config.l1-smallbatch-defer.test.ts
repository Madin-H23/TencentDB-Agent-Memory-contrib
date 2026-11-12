// 票 P2-A2（exp/p2-a2-l1-smallbatch-defer）：persona.l1SmallBatchDefer 经
// parseConfig 的接线测试（同 config.scene-compaction.test.ts 先例：缺省关闭、
// 非法 throw 不静默回落——灰度开关的拒绝式解析）。
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig：persona.l1SmallBatchDefer 解析", () => {
  it("缺省 / false → undefined（off=yaml 不写=行为逐字节不变）", () => {
    expect(parseConfig({}).persona.l1SmallBatchDefer).toBeUndefined();
    expect(parseConfig({ persona: { l1SmallBatchDefer: false } }).persona.l1SmallBatchDefer).toBeUndefined();
  });

  it("true → shadow + K5 + chars200 + 30min", () => {
    expect(parseConfig({ persona: { l1SmallBatchDefer: true } }).persona.l1SmallBatchDefer).toEqual({
      enabled: true,
      mode: "shadow",
      minMessages: 5,
      minChars: 200,
      maxDeferAgeMs: 1_800_000,
    });
  });

  it("mode 非法 → throw（不静默回落）", () => {
    expect(() => parseConfig({ persona: { l1SmallBatchDefer: { mode: "always" } } })).toThrow(/l1SmallBatchDefer/);
    expect(() => parseConfig({ persona: { l1SmallBatchDefer: { mode: "OFF" } } })).toThrow(/l1SmallBatchDefer/);
  });

  it("minMessages：0 / 11 / 非整数 throw；=10 边界放行", () => {
    expect(() => parseConfig({ persona: { l1SmallBatchDefer: { minMessages: 0 } } })).toThrow(/l1SmallBatchDefer\.minMessages/);
    expect(() => parseConfig({ persona: { l1SmallBatchDefer: { minMessages: 11 } } })).toThrow(/l1SmallBatchDefer\.minMessages/);
    expect(() => parseConfig({ persona: { l1SmallBatchDefer: { minMessages: 4.5 } } })).toThrow(/l1SmallBatchDefer\.minMessages/);
    expect(parseConfig({ persona: { l1SmallBatchDefer: { minMessages: 10 } } }).persona.l1SmallBatchDefer?.minMessages).toBe(10);
  });

  it("maxDeferAgeMs：0 / 负 / NaN throw", () => {
    expect(() => parseConfig({ persona: { l1SmallBatchDefer: { maxDeferAgeMs: 0 } } })).toThrow(/l1SmallBatchDefer\.maxDeferAgeMs/);
    expect(() => parseConfig({ persona: { l1SmallBatchDefer: { maxDeferAgeMs: -60_000 } } })).toThrow(/l1SmallBatchDefer\.maxDeferAgeMs/);
    expect(() => parseConfig({ persona: { l1SmallBatchDefer: { maxDeferAgeMs: Number.NaN } } })).toThrow(/l1SmallBatchDefer\.maxDeferAgeMs/);
  });

  it("对象：mode=on + 自定义阈值透传；enabled:false / mode:off → undefined", () => {
    expect(parseConfig({
      persona: { l1SmallBatchDefer: { mode: "on", minMessages: 3, minChars: 500, maxDeferAgeMs: 600_000 } },
    }).persona.l1SmallBatchDefer).toEqual({
      enabled: true,
      mode: "on",
      minMessages: 3,
      minChars: 500,
      maxDeferAgeMs: 600_000,
    });
    expect(parseConfig({ persona: { l1SmallBatchDefer: { enabled: false } } }).persona.l1SmallBatchDefer).toBeUndefined();
    expect(parseConfig({ persona: { l1SmallBatchDefer: { mode: "off" } } }).persona.l1SmallBatchDefer).toBeUndefined();
  });
});
