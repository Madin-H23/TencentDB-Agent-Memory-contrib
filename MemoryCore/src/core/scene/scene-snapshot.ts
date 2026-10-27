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
 */
import { join } from "node:path";
import { stat } from "node:fs/promises";

import { BackupManager } from "../../utils/backup.js";
import type { Logger } from "../types.js";

export const SCENE_SNAPSHOT_ANCHOR = "[scene-snapshot]";

/**
 * 写一份 scene_blocks 快照。非本地后端（COS 等，dataDir 下无本地目录）自然跳过。
 * 任何失败都只 warn，不向外抛——快照不得阻断 L2 主流程。
 *
 * @returns 是否真的写出了快照。
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

  try {
    const bm = new BackupManager(join(params.dataDir, ".backup"));
    await bm.backupDirectory(
      sceneBlocksDir,
      "scene_blocks",
      params.tag ?? `${SCENE_SNAPSHOT_ANCHOR.slice(1, -1)}-${Date.now()}`,
      params.keep,
    );
    params.logger?.debug?.(
      `${SCENE_SNAPSHOT_ANCHOR} snapshot written dir="${sceneBlocksDir}" keep=${params.keep} (restore disabled)`,
    );
    return true;
  } catch (err) {
    params.logger?.warn?.(
      `${SCENE_SNAPSHOT_ANCHOR} snapshot failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
