import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

/** 完整 profile：scene_blocks + persona.md + .metadata/{scene_index,checkpoint}.json */
function makeCompleteData(): string {
  const dir = mkdata();
  writeFileSync(join(dir, "persona.md"), "# PERSONA\n");
  const meta = join(dir, ".metadata");
  mkdirSync(meta, { recursive: true });
  writeFileSync(join(meta, "scene_index.json"), "[]\n");
  writeFileSync(join(meta, "checkpoint.json"), '{"total_processed":1}\n');
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

  // 2026-10-28（用户拍板补「快照完整性」）：快照必须同时带走 persona 与
  // .metadata/scene_index.json、checkpoint.json，否则回滚只能恢复 scene_blocks，
  // 索引与游标会和内容分叉。元文件与场景快照同名放在 .backup/profile_meta/ 下。
  it("快照完整性：同时带走 persona.md 与 .metadata 的 index/checkpoint，并写 manifest", async () => {
    const dir = makeCompleteData();
    try {
      expect(await writeSceneSnapshot({ dataDir: dir, keep: 10, tag: "full", logger })).toBe(true);
      const snap = snapshots(dir)[0];
      const metaDir = join(dir, ".backup", "profile_meta", snap);
      expect(readdirSync(metaDir).sort()).toEqual(["checkpoint.json", "manifest.json", "persona.md", "scene_index.json"]);
      expect(readFileSync(join(metaDir, "persona.md"), "utf8")).toContain("PERSONA");
      const manifest = JSON.parse(readFileSync(join(metaDir, "manifest.json"), "utf8"));
      expect(manifest.snapshot).toBe(snap);
      expect(manifest.tag).toBe("full");
      expect(manifest.sceneFiles).toBe(2);
      expect(manifest.metaFiles.sort()).toEqual(["checkpoint.json", "persona.md", "scene_index.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("完整性降级：缺少 persona/.metadata 不报错，manifest 只记录实际存在的项", async () => {
    const dir = mkdata(); // 只有 scene_blocks
    try {
      expect(await writeSceneSnapshot({ dataDir: dir, keep: 10, tag: "partial", logger })).toBe(true);
      const snap = snapshots(dir)[0];
      const metaDir = join(dir, ".backup", "profile_meta", snap);
      expect(readdirSync(metaDir)).toEqual(["manifest.json"]);
      const manifest = JSON.parse(readFileSync(join(metaDir, "manifest.json"), "utf8"));
      expect(manifest.metaFiles).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("profile_meta 与 scene_blocks 用同一 keep 裁剪", async () => {
    const dir = makeCompleteData();
    try {
      for (const tag of ["t1", "t2", "t3"]) {
        await writeSceneSnapshot({ dataDir: dir, keep: 2, tag, logger });
      }
      const metas = readdirSync(join(dir, ".backup", "profile_meta"));
      expect(metas.length).toBeLessThanOrEqual(2);
      // 每个保留的 meta 目录都能与一个场景快照目录对上名
      const snaps = new Set(snapshots(dir));
      for (const m of metas) expect(snaps.has(m)).toBe(true);
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

  it("源目录为空时不产生快照（返回 false，与 backupDirectory 语义一致）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scene-snapshot-blank-"));
    try {
      mkdirSync(join(dir, "scene_blocks"), { recursive: true });
      expect(await writeSceneSnapshot({ dataDir: dir, keep: 10, logger })).toBe(false);
      expect(snapshots(dir).length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
