// P0-Fix1（2026-10-14，v2 f124dec 移植）：extraction.dedupFailFast / dedupTimeoutMs
// 配置解析。默认值语义：dedupFailFast=false（保持 v3 上游行为，opt-in 开启）、
// dedupTimeoutMs 缺省=由 l1-dedup 层自默认 180000（配置层不硬编码，透传 undefined）。
import { describe, it, expect } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig：S1 fail-closed 两键解析", () => {
  it("缺省 → dedupFailFast=false（opt-in）、dedupTimeoutMs=undefined（层内默认 180s）", () => {
    const cfg = parseConfig({});
    expect(cfg.extraction.dedupFailFast).toBe(false);
    expect(cfg.extraction.dedupTimeoutMs).toBeUndefined();
  });

  it("显式开启 → 两键透传（v2 在役口径：true / 240000）", () => {
    const cfg = parseConfig({
      extraction: { dedupFailFast: true, dedupTimeoutMs: 240000 },
    });
    expect(cfg.extraction.dedupFailFast).toBe(true);
    expect(cfg.extraction.dedupTimeoutMs).toBe(240000);
  });

  it("非法类型 → 回退默认（num/bool 帮助函数既有语义）", () => {
    const cfg = parseConfig({
      extraction: { dedupFailFast: "yes", dedupTimeoutMs: "240s" },
    });
    expect(cfg.extraction.dedupFailFast).toBe(false);
    expect(cfg.extraction.dedupTimeoutMs).toBeUndefined();
  });
});
