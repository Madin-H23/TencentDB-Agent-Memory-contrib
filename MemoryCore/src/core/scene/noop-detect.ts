/**
 * 全零 diff 判定（2026-10-27）。
 *
 * 用途：L2「只观测」——created/updated/deleted 全零表示本轮没有落地任何场景变更。
 * 必须与既有 emptyExtraction 区分：后者要求「提取前后 scene_index 都为空」
 * （scene-extractor.ts 的 `preExtractIndex.size === 0 && postIndex.length === 0`），
 * 已有场景时恒为 false，因此发现不了「已有 14 个场景但本轮零产出」的轮次
 * （2026-10-27 实测 284 轮里 8 轮 created/updated/deleted 全零）。
 *
 * 本函数不参与任何判定与游标语义，只供观测锚点使用；是否据此阻断游标推进
 * 属另一张票，须等 3–7 天基线成立后再定。
 */
export function isNoopSceneDiff(created: number, updated: number, deleted: number): boolean {
  return created === 0 && updated === 0 && deleted === 0;
}
