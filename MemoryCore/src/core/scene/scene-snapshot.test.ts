import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeSceneSnapshot } from "./scene-snapshot.js";

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

function mkdata(): string {
  const dir = mkdtempSync(join(tmpdir(), "scene-snapshot-"));
  const blocks = join(dir, "scene_blocks");
  mkdirSync(blocks, { recursive: true });
  writeFileSync(join(blocks, "a.md"), "# a\n");
  writeFileSync(join(blocks, "b.md"), "# b\n");
  return dir;
}

const snapshots = (dataDir: string) => {
  try {
    return readdirSync(join(dataDir, ".backup", "scene_blocks"));
  } catch {
    return [];
  }
};

describe("writeSceneSnapshot（只写快照，不接 restore）", () => {
  it("本地目录存在时写出快照，且不触碰源文件", async () => {
    const dir = mkdata();
    try {
      expect(await writeSceneSnapshot({ dataDir: dir, keep: 10, tag: "t1", logger })).toBe(true);
      const snaps = snapshots(dir);
      expect(snaps.length).toBe(1);
      // 快照目录内是 scene_blocks 的浅拷贝
      expect(readdirSync(join(dir, ".backup", "scene_blocks", snaps[0])).sort()).toEqual(["a.md", "b.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keep 生效：超过上限的旧快照被裁剪", async () => {
    const dir = mkdata();
    try {
      for (const tag of ["t1", "t2", "t3"]) {
        await writeSceneSnapshot({ dataDir: dir, keep: 2, tag, logger });
      }
      expect(snapshots(dir).length).toBeLessThanOrEqual(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("目录不存在（COS 等非本地后端）时返回 false 且不抛错", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scene-snapshot-empty-"));
    try {
      expect(await writeSceneSnapshot({ dataDir: dir, keep: 10, logger })).toBe(false);
      expect(snapshots(dir).length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("源目录为空时不产生快照（BackupManager 的既有语义）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scene-snapshot-blank-"));
    try {
      mkdirSync(join(dir, "scene_blocks"), { recursive: true });
      expect(await writeSceneSnapshot({ dataDir: dir, keep: 10, logger })).toBe(true);
      expect(snapshots(dir).length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
