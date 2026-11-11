// 票 P2-A1 分支 B1：l1-lifecycle 测试（pure 决策/配置解析）。
import { describe, expect, it } from "vitest";
import {
  archiveDecision,
  parseL1ArchiveConfig,
  selectArchiveCandidates,
} from "./l1-lifecycle.js";

const NOW = Date.parse("2026-11-12T10:00:00Z");

describe("parseL1ArchiveConfig", () => {
  it("缺省/false → undefined（off 零行为）", () => {
    expect(parseL1ArchiveConfig(undefined)).toBeUndefined();
    expect(parseL1ArchiveConfig(false)).toBeUndefined();
  });

  it("true → shadow + 90 天（安全默认=影子先量）", () => {
    expect(parseL1ArchiveConfig(true)).toEqual({
      enabled: true,
      mode: "shadow",
      ageDays: 90,
      protectScenes: [],
    });
  });

  it("对象透传 + on 模式", () => {
    expect(
      parseL1ArchiveConfig({ mode: "on", ageDays: 60, protectScenes: ["生活与健康管理.md"] }),
    ).toEqual({ enabled: true, mode: "on", ageDays: 60, protectScenes: ["生活与健康管理.md"] });
  });

  it("非法值 throw（不静默回落）", () => {
    expect(() => parseL1ArchiveConfig("on")).toThrow();
    expect(() => parseL1ArchiveConfig({ ageDays: 0 })).toThrow();
    expect(() => parseL1ArchiveConfig({ ageDays: -5 })).toThrow();
    expect(() => parseL1ArchiveConfig({ mode: "always" })).toThrow();
    expect(() => parseL1ArchiveConfig({ protectScenes: "x" })).toThrow();
  });
});

describe("archiveDecision", () => {
  const cfgOn = { enabled: true, mode: "on" as const, ageDays: 90, protectScenes: [] };
  const old = Date.parse("2026-07-01T00:00:00Z"); // ~134 天前
  const fresh = Date.parse("2026-11-01T00:00:00Z"); // ~11 天前

  it("旧记忆+on → true；新记忆 → false；shadow → false", () => {
    expect(archiveDecision({ updatedTimeMs: old, sceneName: null, nowMs: NOW, cfg: cfgOn })).toBe(true);
    expect(archiveDecision({ updatedTimeMs: fresh, sceneName: null, nowMs: NOW, cfg: cfgOn })).toBe(false);
    expect(
      archiveDecision({ updatedTimeMs: old, sceneName: null, nowMs: NOW, cfg: { ...cfgOn, mode: "shadow" } }),
    ).toBe(false);
  });

  it("保护场景 → false", () => {
    const cfg = { ...cfgOn, protectScenes: ["生活与健康管理.md"] };
    expect(
      archiveDecision({ updatedTimeMs: old, sceneName: "生活与健康管理.md", nowMs: NOW, cfg }),
    ).toBe(false);
    expect(archiveDecision({ updatedTimeMs: old, sceneName: "其他.md", nowMs: NOW, cfg })).toBe(true);
  });
});

describe("selectArchiveCandidates", () => {
  it("混合行集：只返回应归档的 id；shadow 配置下仍按 on 口径计数", () => {
    const rows = [
      { record_id: "a", scene_name: null, updated_time: "2026-07-01T00:00:00Z" },
      { record_id: "b", scene_name: null, updated_time: "2026-11-01T00:00:00Z" },
      { record_id: "c", scene_name: "生活与健康管理.md", updated_time: "2026-07-01T00:00:00Z" },
    ];
    const ids = selectArchiveCandidates(
      rows,
      { enabled: true, mode: "shadow", ageDays: 90, protectScenes: ["生活与健康管理.md"] },
      NOW,
    );
    expect(ids).toEqual(["a"]);
  });

  it("空行集 → 空数组", () => {
    expect(selectArchiveCandidates([], { enabled: true, mode: "shadow", ageDays: 90, protectScenes: [] }, NOW)).toEqual([]);
  });
});
