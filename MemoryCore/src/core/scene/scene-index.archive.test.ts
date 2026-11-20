// 归档计数补丁（2026-11-19）：读侧只把「活动场景」计入场景索引，
// 只读归档（`-archive.md` 或 META `archive: true`）不参与 maxScenes 计量。
//
// 事故背景：P2-A3 归档层 2026-11-19 拨 on 后生成 14 个 `<scene>-archive.md`，
// 但 scene_index/提示词/persona 导航全按「目录下所有 .md」计数 → 面板与提示词
// 显示「36/24 已满」，L2 被迫把只读归档当 MERGE 目标写 `[DELETED]`，清理阶段
// unlink 了 7 个归档文件。
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSceneIndex, syncSceneIndex } from "./scene-index.js";
import { isArchiveSceneFile } from "./scene-format.js";

function sceneFile(summary: string, extraMeta: string[] = []): string {
  return [
    "-----META-START-----",
    "created: 2026-11-01T00:00:00.000Z",
    "updated: 2026-11-19T00:00:00.000Z",
    `summary: ${summary}`,
    "heat: 3",
    ...extraMeta,
    "-----META-END-----",
    "",
    "## 要点",
    "- 测试内容（m_1794000000000_aaaa0001）",
  ].join("\n");
}

describe("isArchiveSceneFile：双判据识别", () => {
  it("文件名 -archive.md（META 已被 [DELETED] 覆盖）→ 归档", () => {
    expect(isArchiveSceneFile("职业发展-archive.md", "[DELETED]")).toBe(true);
    expect(isArchiveSceneFile("职业发展-archive.md", null)).toBe(true);
  });

  it("META archive: true（文件名无后缀，规范化前的旧归档）→ 归档", () => {
    const raw = sceneFile("归档摘要", ["archive: true"]);
    expect(isArchiveSceneFile("职业发展.md", raw)).toBe(true);
  });

  it("普通活动场景 → 非归档", () => {
    expect(isArchiveSceneFile("职业发展.md", sceneFile("正常摘要"))).toBe(false);
    // archive: false 不算归档
    expect(isArchiveSceneFile("职业发展.md", sceneFile("正常摘要", ["archive: false"]))).toBe(false);
    // 无 raw 且文件名无后缀 → 非归档
    expect(isArchiveSceneFile("职业发展.md")).toBe(false);
  });
});

describe("syncSceneIndex：归档不进活动场景索引", () => {
  it("2 活动 + 3 归档 → 索引只回 2 条，落盘 scene_index.json 也只 2 条", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scene-index-archive-"));
    const sceneDir = join(dir, "scene_blocks");
    mkdirSync(sceneDir, { recursive: true });
    try {
      writeFileSync(join(sceneDir, "职业发展.md"), sceneFile("活动A"));
      writeFileSync(join(sceneDir, "技术研究.md"), sceneFile("活动B"));
      // 归档 1/2：文件名带后缀、META 带 archive: true
      writeFileSync(join(sceneDir, "闲鱼-archive.md"), sceneFile("归档C", ["archive: true"]));
      // 归档 2：仅 META 判据（文件名未带后缀，模拟规范化前旧归档）
      writeFileSync(join(sceneDir, "生活-archive.md"), sceneFile("归档D", ["archive: true"]));
      // 归档 3：被 L2 写坏的软删标记（本次事故形态），只剩文件名可辨
      writeFileSync(join(sceneDir, "实习周报-archive.md"), "[DELETED]");

      const entries = await syncSceneIndex(dir);
      expect(entries.map((e) => e.filename).sort()).toEqual(["技术研究.md", "职业发展.md"].sort());

      const onDisk = JSON.parse(
        readFileSync(join(dir, ".metadata", "scene_index.json"), "utf-8"),
      ) as Array<{ filename: string }>;
      expect(onDisk).toHaveLength(2);
      expect(onDisk.some((e) => e.filename.endsWith("-archive.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readSceneIndex：陈旧索引里的归档条目也被过滤（向后兼容存量 scene_index.json）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scene-index-stale-"));
    mkdirSync(join(dir, ".metadata"), { recursive: true });
    try {
      const stale = [
        { filename: "职业发展.md", summary: "活动", heat: 3, created: "", updated: "" },
        { filename: "职业发展-archive.md", summary: "归档", heat: 0, created: "", updated: "" },
        { filename: "闲鱼-archive.md", summary: "归档", heat: 0, created: "", updated: "" },
      ];
      writeFileSync(join(dir, ".metadata", "scene_index.json"), JSON.stringify(stale, null, 2));

      const entries = await readSceneIndex(dir);
      expect(entries.map((e) => e.filename)).toEqual(["职业发展.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
