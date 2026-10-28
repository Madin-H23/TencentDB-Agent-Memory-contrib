/**
 * L2 场景快照（2026-10-27）：只写快照，**不接 restore**。
 *
 * 背景：scene-extractor 原逻辑只在 `!this.storage` 时建 BackupManager，而网关
 * 恒传 storage → 在役从不做 L2 快照（实测 profiles 下没有 .backup），任何写坏
 * 都没有回滚单元。
 *
 * 硬约束（2026-10-27 两轮审查的 P0）：不能顺手启用 restoreLatestDirectory——
 * 它先 `fs.rm(destDir, {recursive:true})` 再整目录覆盖（utils/backup.ts:153），
 * 而 L2 存在并发 run（实测最多 3 个同时写），一个失败 run 会把另一个成功 run
 * 的写入整目录抹掉。因此本模块只负责「写」；恢复仍只走沙箱模式（!storage）的
 * 既有路径，二者解耦。
 *
 * 2026-10-28（快照完整性）：scene_blocks 之外同时带走 `persona.md` 与
 * `.metadata/{scene_index,checkpoint}.json`，与场景快照同名放在
 * `.backup/profile_meta/<快照目录名>/`，并落 manifest.json 记录内容清单——
 * 否则回滚只能恢复场景块，索引与游标会和内容分叉。任一元文件缺失自然降级，
 * manifest 只记录实际存在的项。
 */
import { join } from "node:path";
import { stat, copyFile, writeFile, readdir, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";

import { BackupManager } from "../../utils/backup.js";
import type { Logger } from "../types.js";

export const SCENE_SNAPSHOT_ANCHOR = "[scene-snapshot]";

/** 与场景快照一起带走的 profile 元文件（相对 dataDir）。 */
const META_FILES: ReadonlyArray<{ src: string; dest: string }> = [
  { src: "persona.md", dest: "persona.md" },
  { src: join(".metadata", "scene_index.json"), dest: "scene_index.json" },
  { src: join(".metadata", "checkpoint.json"), dest: "checkpoint.json" },
];

/**
 * 写一份快照。非本地后端（COS 等，dataDir 下无本地目录）自然跳过。
 * 任何失败都只 warn，不向外抛——快照不得阻断 L2 主流程。
 *
 * @returns 是否真的写出了快照（含完整情形：scene_blocks + 元文件 + manifest）。
 */
export async function writeSceneSnapshot(params: {
  dataDir: string;
  keep: number;
  /** 快照标识（默认 anchor + 时间戳）；调用方可用 offsetN 携带处理进度。 */
  tag?: string;
  logger?: Logger;
}): Promise<boolean> {
  const sceneBlocksDir = join(params.dataDir, "scene_blocks");
  try {
    const st = await stat(sceneBlocksDir);
    if (!st.isDirectory()) return false;
  } catch {
    // 目录不存在（非本地后端或首次运行）→ 无快照可写
    return false;
  }

  let sceneSnapshotDir: string | undefined;
  try {
    const bm = new BackupManager(join(params.dataDir, ".backup"));
    sceneSnapshotDir = await bm.backupDirectory(
      sceneBlocksDir,
      "scene_blocks",
      params.tag ?? `${SCENE_SNAPSHOT_ANCHOR.slice(1, -1)}-${Date.now()}`,
      params.keep,
    );
  } catch (err) {
    params.logger?.warn?.(
      `${SCENE_SNAPSHOT_ANCHOR} snapshot failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
  if (!sceneSnapshotDir) return false; // scene_blocks 为空，BackupManager 未建目录

  // ── 元文件 + manifest（best-effort：失败只降级，不影响快照主件）──
  const snapshotName = sceneSnapshotDir.split(/[\\/]/).pop() ?? sceneSnapshotDir;
  const metaDestDir = join(params.dataDir, ".backup", "profile_meta", snapshotName);
  const copied: string[] = [];
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(metaDestDir, { recursive: true });
    for (const f of META_FILES) {
      try {
        await copyFile(join(params.dataDir, f.src), join(metaDestDir, f.dest));
        copied.push(f.dest);
      } catch {
        // 缺失即降级，不记 warn（首次运行没有 .metadata 属正常）
      }
    }
    const manifest = {
      snapshot: snapshotName,
      tag: params.tag ?? null,
      takenAt: new Date().toISOString(),
      sceneFiles: readdirSync(sceneSnapshotDir).length,
      metaFiles: [...copied].sort(),
      note: "snapshot-only; restore is NOT wired (see module doc)",
    };
    await writeFile(join(metaDestDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
    // 与 scene_blocks 快照同一 keep：目录名同构（<ts>_<tag>），排序一致。
    if (params.keep > 0) {
      await pruneMetaDirs(join(params.dataDir, ".backup", "profile_meta"), params.keep);
    }
  } catch (err) {
    params.logger?.warn?.(
      `${SCENE_SNAPSHOT_ANCHOR} meta/manifest write failed (non-fatal, scene snapshot kept): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  params.logger?.debug?.(
    `${SCENE_SNAPSHOT_ANCHOR} snapshot written dir="${sceneBlocksDir}" keep=${params.keep} meta=${copied.length}/${META_FILES.length} (restore disabled)`,
  );
  return true;
}

/** 只保留最新的 `keep` 个元快照目录（目录名 `scene_blocks_<ts>_<tag>` 字典序即时序）。 */
async function pruneMetaDirs(dir: string, keep: number): Promise<void> {
  try {
    const names = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const stale = names.slice(0, Math.max(0, names.length - keep));
    for (const name of stale) await rm(join(dir, name), { recursive: true, force: true });
  } catch {
    // 裁剪失败不影响快照本身
  }
}
