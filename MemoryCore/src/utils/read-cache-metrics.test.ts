import { describe, expect, it } from "vitest";
import { ReadCacheMetrics, formatReadCacheNote, READ_CACHE_ANCHOR } from "./read-cache-metrics.js";

describe("ReadCacheMetrics（影子：只统计 would-hit，不改变读取）", () => {
  it("首次读 miss，内容未变的第二次读 hit", () => {
    const m = new ReadCacheMetrics();
    expect(m.note("a.md", "x").wouldHit).toBe(false);
    expect(m.note("a.md", "x").wouldHit).toBe(true);
  });

  it("内容变化（等价 edit/write）后下一次读 miss；缓存只记最后一次内容", () => {
    const m = new ReadCacheMetrics();
    m.note("a.md", "v1");
    expect(m.note("a.md", "v2").wouldHit).toBe(false);
    // 改回 v1 也是 miss（缓存里此刻是 v2），再读一次 v1 才 hit
    expect(m.note("a.md", "v1").wouldHit).toBe(false);
    expect(m.note("a.md", "v1").wouldHit).toBe(true);
  });

  it("不同 key 即使内容相同也不算命中（缓存必须按路径隔离）", () => {
    const m = new ReadCacheMetrics();
    m.note("a.md", "same");
    expect(m.note("b.md", "same").wouldHit).toBe(false);
  });

  it("超过上限时淘汰最旧条目（LRU），被淘汰的 key 再读记 miss", () => {
    const m = new ReadCacheMetrics(2);
    m.note("a", "1");
    m.note("b", "2");
    expect(m.size).toBe(2);
    m.note("c", "3"); // 淘汰 a
    expect(m.size).toBe(2);
    expect(m.note("a", "1").wouldHit).toBe(false);
    expect(m.note("c", "3").wouldHit).toBe(true);
  });

  it("锚点含 would_hit/path/chars/hash 前缀/task_id", () => {
    const m = new ReadCacheMetrics();
    const line = formatReadCacheNote(m.note("a.md", "hello"), "a.md", 5, "scene-extract-1");
    expect(line).toContain(READ_CACHE_ANCHOR);
    expect(line).toContain("would_hit=false");
    expect(line).toContain('path="a.md"');
    expect(line).toContain("chars=5");
    expect(line).toContain("task_id=scene-extract-1");
    expect(line).toMatch(/hash=[0-9a-f]{12}/);
  });
});
