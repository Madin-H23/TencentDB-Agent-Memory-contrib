// 票 TICKETS-C-read-dedup-20261113.md（T1）：L2 scene-extract run 内 read 结果去重。
// 纯逻辑 + 进程内 Map，零 I/O；键 = storageKey|offset|limit|includeInvalidated|includeArchive。
// 写失效：同 key 的 write/edit 使该 key 全部条目作废（防「读→改→再读」陈旧字节）。
import { describe, expect, it } from "vitest";
import { ReadDedupTracker, readDedupKey, READ_DEDUP_ANCHOR, formatReadDedupNote } from "./read-dedup.js";

describe("readDedupKey：键构造与归一", () => {
  it("同参数同键", () => {
    const a = readDedupKey("scene_blocks/a.md", { offset: 0, limit: 100 });
    const b = readDedupKey("scene_blocks/a.md", { offset: 0, limit: 100 });
    expect(a).toBe(b);
  });

  it("offset/limit 差异 → 不同键", () => {
    const base = readDedupKey("scene_blocks/a.md", { offset: 0, limit: 100 });
    expect(readDedupKey("scene_blocks/a.md", { offset: 10, limit: 100 })).not.toBe(base);
    expect(readDedupKey("scene_blocks/a.md", { offset: 0, limit: 200 })).not.toBe(base);
  });

  it("flags 差异 → 不同键（审计视图不可混用）", () => {
    const base = readDedupKey("scene_blocks/a.md", { offset: 0, limit: 100 });
    expect(readDedupKey("scene_blocks/a.md", { offset: 0, limit: 100, includeInvalidated: true })).not.toBe(base);
    expect(readDedupKey("scene_blocks/a.md", { offset: 0, limit: 100, includeArchive: true })).not.toBe(base);
  });

  it("undefined 与显式 undefined 等价；false 与缺省等价", () => {
    expect(readDedupKey("k", {})).toBe(readDedupKey("k", { offset: undefined, limit: undefined }));
    expect(readDedupKey("k", { includeInvalidated: false })).toBe(readDedupKey("k", {}));
  });

  it("边界值归一：0/负数/超大/NaN 不炸且互不相同", () => {
    const k0 = readDedupKey("k", { offset: 0, limit: 0 });
    const kNeg = readDedupKey("k", { offset: -5, limit: -1 });
    const kBig = readDedupKey("k", { offset: 0, limit: 9e15 });
    const kNan = readDedupKey("k", { offset: NaN, limit: NaN });
    expect(new Set([k0, kNeg, kBig, kNan]).size).toBe(4);
    expect(k0.startsWith("k|")).toBe(true); // 形态健全（含 key 段）
  });

  it("不同 storageKey → 不同键", () => {
    expect(readDedupKey("scene_blocks/a.md", {})).not.toBe(readDedupKey("scene_blocks/b.md", {}));
  });
});

describe("ReadDedupTracker：shadow 计量", () => {
  it("首次 note → wouldDedup=false；同参重复 → true", () => {
    const t = new ReadDedupTracker();
    const p = { storageKey: "scene_blocks/a.md", output: "ABC", args: { offset: 0, limit: 3 } };
    expect(t.note(p).wouldDedup).toBe(false);
    expect(t.note(p).wouldDedup).toBe(true);
    expect(t.note(p).wouldDedup).toBe(true);
  });

  it("累计量：dedupCount / savedChars 只算命中部分", () => {
    const t = new ReadDedupTracker();
    const p = { storageKey: "k", output: "0123456789", args: {} };
    t.note(p); // miss
    t.note(p); // hit 10
    t.note(p); // hit 10
    expect(t.dedupCount).toBe(2);
    expect(t.savedChars).toBe(20);
  });

  it("chars_saved 按本次 output 长度计（非首次长度）", () => {
    const t = new ReadDedupTracker();
    t.note({ storageKey: "k", output: "AAAA", args: {} });
    // 同键但内容不同（模拟文件被外部改动）→ 仍按当次 output 计
    t.note({ storageKey: "k", output: "BB", args: {} });
    expect(t.dedupCount).toBe(1);
    expect(t.savedChars).toBe(2);
  });

  it("entries 上限淘汰最旧（不无限增长）", () => {
    const t = new ReadDedupTracker(3);
    for (let i = 0; i < 5; i++) t.note({ storageKey: `k${i}`, output: "x", args: {} });
    expect(t.entries).toBe(3);
    // 最早的 k0/k1 已被淘汰 → 重复 note 不再命中
    expect(t.note({ storageKey: "k0", output: "x", args: {} }).wouldDedup).toBe(false);
    expect(t.note({ storageKey: "k4", output: "x", args: {} }).wouldDedup).toBe(true);
  });

  it("空 output（0 字符读）也记账且可命中", () => {
    const t = new ReadDedupTracker();
    const p = { storageKey: "k", output: "", args: { offset: 9999, limit: 10 } };
    expect(t.note(p).wouldDedup).toBe(false);
    expect(t.note(p).wouldDedup).toBe(true);
    expect(t.savedChars).toBe(0);
  });
});

describe("ReadDedupTracker：写失效", () => {
  it("note → invalidate(key) → 同参 note → miss", () => {
    const t = new ReadDedupTracker();
    const p = { storageKey: "scene_blocks/a.md", output: "ABC", args: { offset: 0, limit: 3 } };
    t.note(p);
    t.invalidate("scene_blocks/a.md");
    expect(t.note(p).wouldDedup).toBe(false);
  });

  it("invalidate 只作废目标 key，其他 key 不受影响", () => {
    const t = new ReadDedupTracker();
    t.note({ storageKey: "a.md", output: "A", args: {} });
    t.note({ storageKey: "b.md", output: "B", args: {} });
    t.invalidate("a.md");
    expect(t.note({ storageKey: "b.md", output: "B", args: {} }).wouldDedup).toBe(true);
    expect(t.note({ storageKey: "a.md", output: "A", args: {} }).wouldDedup).toBe(false);
  });

  it("同一 key 多窗口：一次 invalidate 全作废", () => {
    const t = new ReadDedupTracker();
    t.note({ storageKey: "a.md", output: "A", args: { offset: 0, limit: 1 } });
    t.note({ storageKey: "a.md", output: "B", args: { offset: 1, limit: 1 } });
    t.invalidate("a.md");
    expect(t.note({ storageKey: "a.md", output: "A", args: { offset: 0, limit: 1 } }).wouldDedup).toBe(false);
    expect(t.note({ storageKey: "a.md", output: "B", args: { offset: 1, limit: 1 } }).wouldDedup).toBe(false);
  });

  it("invalidate 不存在的 key → 无操作不炸", () => {
    const t = new ReadDedupTracker();
    t.note({ storageKey: "a.md", output: "A", args: {} });
    expect(() => t.invalidate("zzz.md")).not.toThrow();
    expect(t.note({ storageKey: "a.md", output: "A", args: {} }).wouldDedup).toBe(true);
  });

  it("edit 也走 invalidate（调用方对 edit 同样调）", () => {
    const t = new ReadDedupTracker();
    t.note({ storageKey: "a.md", output: "A", args: {} });
    t.invalidate("a.md"); // edit 分支复用同一方法
    t.note({ storageKey: "a.md", output: "A2", args: {} });
    expect(t.note({ storageKey: "a.md", output: "A2", args: {} }).wouldDedup).toBe(true);
  });
});

describe("ReadDedupTracker：on 模式返回缓存", () => {
  it("get 命中返回首次 output 字节串", () => {
    const t = new ReadDedupTracker();
    const args = { offset: 5, limit: 10 };
    t.note({ storageKey: "k", output: "FIRST-OUTPUT", args });
    expect(t.get("k", args)).toBe("FIRST-OUTPUT");
  });

  it("get 未命中 → undefined", () => {
    const t = new ReadDedupTracker();
    expect(t.get("k", { offset: 0, limit: 1 })).toBeUndefined();
  });

  it("invalidate 后 get → undefined", () => {
    const t = new ReadDedupTracker();
    t.note({ storageKey: "k", output: "X", args: {} });
    t.invalidate("k");
    expect(t.get("k", {})).toBeUndefined();
  });

  it("get 不刷新 LRU 顺序（只读语义）", () => {
    const t = new ReadDedupTracker(2);
    t.note({ storageKey: "k1", output: "1", args: {} });
    t.note({ storageKey: "k2", output: "2", args: {} });
    t.get("k1", {}); // 读不应改变淘汰顺序
    t.note({ storageKey: "k3", output: "3", args: {} }); // 淘汰最旧 k1
    expect(t.entries).toBe(2);
    expect(t.get("k1", {})).toBeUndefined();
    expect(t.get("k2", {})).toBe("2");
  });
});

describe("formatReadDedupNote：日志锚点", () => {
  it("含稳定锚点与全部观测量", () => {
    const t = new ReadDedupTracker();
    const line = formatReadDedupNote(
      { wouldDedup: true, savedChars: 42, dedupCount: 3, entries: 7 },
      "a.md",
      42,
      "task-1",
    );
    expect(line).toContain(READ_DEDUP_ANCHOR);
    expect(line).toContain("would_dedup=true");
    expect(line).toContain("saved_chars=42");
    expect(line).toContain("dedup_count=3");
    expect(line).toContain('path="a.md"');
    expect(line).toContain("task_id=task-1");
  });
});
