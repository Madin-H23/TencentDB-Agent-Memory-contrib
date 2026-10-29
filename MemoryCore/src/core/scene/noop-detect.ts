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

/**
 * 「零 diff 且最终输出为空」门控（2026-10-30，用户授权按推荐执行）。
 *
 * 判据：output=0 不是 no-op（10-21 实证 steps=20/output=0 但 updated=8），但
 * 「零 diff **且** output=0」= 疑似中途夭折（steps 撞顶/供应商挂起，10-26
 * 1,593,851ms 实证）——该批记忆实际未被处理，游标不应推进。
 * 有输出但零 diff = 模型明确判无可更新，属合法 no-op，照常推进。
 *
 * 防风暴（二轮审查 P1-6）：同一 group 连续 MAX 次被门控后强制放行一次
 * （quarantine），避免病态批次无限重投烧配额。L3 不适用（persona「不需要
 * 生成」是高频合法 no-op，门控必风暴）。
 */
export const L2_ZERO_DIFF_EMPTY_OUTPUT_MAX = 3;

export interface ZeroDiffGateResult {
  /** true = 阻断游标推进、交由下轮重投 */
  gate: boolean;
  /** true = 已达 quarantine 上限，本次放行并复位计数 */
  quarantine: boolean;
  /** 处理后的 strike 计数（gate=true 时递增；quarantine 时归零） */
  strikes: number;
}

export function nextZeroDiffEmptyOutputGate(prevStrikes: number): ZeroDiffGateResult {
  const strikes = prevStrikes + 1;
  if (strikes >= L2_ZERO_DIFF_EMPTY_OUTPUT_MAX) {
    return { gate: false, quarantine: true, strikes: 0 };
  }
  return { gate: true, quarantine: false, strikes };
}
