/**
 * 票⑧（exp/p1-8-scene-compaction）：L2 场景文件的**确定性压实**纯模块。
 *
 * ## 背景（取证 2026-11-03，见 EVIDENCE-tickets-89-20261103.md）
 *
 * 帽压力（`persona.sceneCharCap`）**不依赖模型自觉**：实际 L2 写入 105 edit : 1
 * write、场景数 14/24 从未进 MERGE 触发区、票⑥ 的 `[SUPERSEDED]` 全库 0 个
 * （`supersedeDelta` 只统计不生成）。因此「失效段不计帽」结构性空转，文件尺寸
 * 单调增长直至触帽（写冻结）。本模块提供写路径上的**确定性**减压：阈值以上把
 * 场景文件的**旧批次叙事**折叠成一行标记，事实与要点一字不动。
 *
 * ## 折叠口径（严格按票面）
 *
 * 1. `raw.length <= triggerChars` → 原样返回（`compacted:false`）。
 * 2. 先 `toV2Format(raw)`：v1/批次格式迁移为 v2 三段（已是 v2 幂等），再在 v2 上压实。
 *    v1 的批次段（`## ★…`）在迁移中整体进入 `## 活动`；锚点行无论原在哪段都被
 *    路由到 `## 事实`（`toV2Format` 的既有语义）——因此折叠活动段不会碰到锚点。
 * 3. 只折叠 `## 活动` 段内**不含锚点**的行，从**最旧的一端**开始。方向依据（生产
 *    实盘取证）：批次段按「最新在上、最旧在下」排列（例：`技术研究-ZCode环境与工具链.md`
 *    首个 `## ★` 为 11-03 04:32Z、末个为 10-23 06:21Z）；活动段是追加/前插式，
 *    **越靠文件末尾越旧** ⇒ 从活动段尾部向前扫描。
 * 4. 被折叠的行在原位置替换为一行标记：
 *    `- [compacted] 更早 N 条批次叙事已折叠（原始内容见 .backup 快照）`
 *    （N = 本次折叠行数 + 既有标记携带的累计数）。
 * 5. **含锚点 `m_<ts>_<hash>` 的行永不删除/改写**（无论在哪段）：活动段里的锚点行
 *    原样留在活动段；`## 事实`、`## 要点` 两段一个字节都不动。
 * 6. 折到 `afterChars <= targetChars` 即停；全部可折叠行折完仍 > target →
 *    返回已折叠结果并置 `reason:"insufficient_archive"`。**绝不截断事实/要点/锚点**。
 * 7. 保守返回（不破坏）：META 缺失/畸形（END 在 START 前）、无 `## 活动` 段、
 *    无任何可折叠行、压实后不减小（v1→v2 迁移的段标题开销可能大于可折叠收益）、
 *    锚点事后校验出现流失 —— 均返回**原文**，`compacted:false`。
 * 8. 幂等：对已压实且 ≤ trigger 的结果再次调用原样返回；若结果仍 > trigger 但已
 *    无可折叠行，也只折叠既有标记行时不做任何改写。二次压实会**合并**既有标记的
 *    计数（始终只保留一条标记行）。
 *
 * 失败兜底：构造输出后做一次锚点多重集校验，任一 id 出现次数少于输入 → 放弃压实
 * 返回原文（fail-closed）。这条守卫在折叠逻辑之外，独立保证「锚点 lost=0」。
 *
 * 全部纯函数、零 I/O；配置解析 `parseSceneCompactionConfig` 与 recall-ranking 同
 * 先例（独立可测、非法值 throw，不静默回落）。
 */

import { ANCHOR_RE } from "../../utils/supersede.js";
import { META_END, META_START } from "./scene-format.js";
import { findV2Sections, toV2Format } from "./scene-format-v2.js";

export interface CompactOptions {
  /** 触发阈值（字符数）：文件长度 > 该值才压实。 */
  triggerChars: number;
  /** 目标阈值（字符数）：压实到 ≤ 该值即停。 */
  targetChars: number;
}

export interface CompactResult {
  /** 压实后的全文（未压实时 = 输入原文逐字节）。 */
  content: string;
  /** 是否发生了内容变更（true 才允许写回）。 */
  compacted: boolean;
  beforeChars: number;
  afterChars: number;
  /** 本次折叠的行数（含批次标题/空行；不含被合并的既有标记行）。 */
  foldedLines: number;
  /** 折叠区域内被原样保留的锚点行数。 */
  keptAnchorLines: number;
  /** `insufficient_archive`：可折叠行全部折完仍未达到 target（未截断任何内容）。 */
  reason?: string;
}

/** 确定性压实配置（已解析，缺省关闭）。 */
export interface SceneCompactionConfig {
  enabled: boolean;
  /** 文件 > sceneCharCap × triggerRatio 触发。 */
  triggerRatio: number;
  /** 压实到 ≤ sceneCharCap × targetRatio。 */
  targetRatio: number;
}

export const SCENE_COMPACTION_DEFAULT_TRIGGER_RATIO = 0.7;
export const SCENE_COMPACTION_DEFAULT_TARGET_RATIO = 0.5;

/** 折叠标记行（逐字口径；N 为累计折叠行数）。 */
export function formatCompactMarker(folded: number): string {
  return `- [compacted] 更早 ${folded} 条批次叙事已折叠（原始内容见 .backup 快照）`;
}

const MARKER_RE = /^- \[compacted\] 更早 (\d+) 条批次叙事已折叠（原始内容见 \.backup 快照）$/;
/** 行级锚点判定：与 ANCHOR_RE 同源（去掉 g 标志，避免 test 的 lastIndex 状态）。 */
const HAS_ANCHOR_RE = new RegExp(ANCHOR_RE.source);

/** 锚点多重集（id → 出现次数），用于压实后的 fail-closed 校验。 */
function anchorCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of text.match(ANCHOR_RE) ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

/**
 * 确定性压实：见模块头 1-8 条规则。
 *
 * 不修改任何含锚点的行，不改 `## 要点`/`## 事实` 段；只在 `## 活动` 段内从最旧
 * （尾部）一端折叠无锚点行，折到 target 即停。所有保守路径都返回**原文**。
 */
export function compactSceneBlock(raw: string, opts: CompactOptions): CompactResult {
  const beforeChars = raw.length;
  const noop = (reason?: string): CompactResult => ({
    content: raw,
    compacted: false,
    beforeChars,
    afterChars: beforeChars,
    foldedLines: 0,
    keptAnchorLines: 0,
    ...(reason ? { reason } : {}),
  });

  const { triggerChars, targetChars } = opts;
  if (
    !Number.isFinite(triggerChars) ||
    !Number.isFinite(targetChars) ||
    triggerChars <= 0 ||
    targetChars < 0
  ) {
    return noop();
  }
  if (beforeChars <= triggerChars) return noop();

  // META 缺失 / 畸形（END 在 START 前）→ 不破坏
  const startIdx = raw.indexOf(META_START);
  const endIdx = raw.indexOf(META_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return noop();

  const migrated = toV2Format(raw);
  const { archive } = findV2Sections(migrated);
  if (!archive) return noop(); // 无 `## 活动` 段 → 无处可折

  const lines = migrated.split("\n");
  const folded = new Array<boolean>(lines.length).fill(false);
  let carriedFolded = 0; // 既有标记行携带的累计折叠数
  let foldedLines = 0;
  let keptAnchorLines = 0;
  let markerAt = -1;
  let removedChars = 0;

  // 活动段正文 = archive.start+1 .. archive.end-1；从尾部（最旧）向前扫描。
  for (let i = archive.end - 1; i > archive.start; i--) {
    const line = lines[i]!;
    // 文档末尾换行产生的空元素不参与折叠（保持文件末尾换行同形）
    if (i === lines.length - 1 && line === "") continue;
    if (HAS_ANCHOR_RE.test(line)) {
      keptAnchorLines++; // 锚点行永不删除/改写
      continue;
    }
    const markerMatch = line.match(MARKER_RE);
    if (markerMatch) {
      // 既有标记：并入本次（重建为单条累计标记），不计入本次折叠行数
      carriedFolded += Number(markerMatch[1] ?? 0);
      folded[i] = true;
      removedChars += line.length + 1;
      markerAt = i;
      continue;
    }
    folded[i] = true;
    foldedLines++;
    removedChars += line.length + 1;
    markerAt = i; // 标记插在折叠区域的最上方（最新一侧）
    const simLen =
      migrated.length - removedChars + formatCompactMarker(carriedFolded + foldedLines).length + 1;
    if (simLen <= targetChars) break;
  }

  // 没有折掉任何新行 → 不改写（含「只有既有标记」的幂等路径）
  if (foldedLines === 0) return noop("insufficient_archive");

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === markerAt) out.push(formatCompactMarker(carriedFolded + foldedLines));
    if (folded[i]) continue;
    out.push(lines[i]!);
  }
  const content = out.join("\n");

  // fail-closed：锚点多重集不得出现流失（迁移可能盈余，绝不允许缺失）
  const before = anchorCounts(raw);
  const after = anchorCounts(content);
  for (const [id, n] of before) {
    if ((after.get(id) ?? 0) < n) return noop();
  }

  // 压实必须真的变小才允许写回（v1→v2 段标题开销可能吃掉折叠收益）
  if (content.length >= beforeChars) return noop("insufficient_archive");

  return {
    content,
    compacted: true,
    beforeChars,
    afterChars: content.length,
    foldedLines,
    keptAnchorLines,
    ...(content.length > targetChars ? { reason: "insufficient_archive" } : {}),
  };
}

function isRatio(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1;
}

/**
 * 解析 `persona.sceneCompaction`（默认全关）：
 * - undefined / null / false → undefined（关闭；Phase 5 零 I/O、行为逐字节不变）
 * - true → 默认开启（trigger 0.7 / target 0.5）
 * - 对象 → 缺省字段回落默认值；`enabled` 非布尔、`triggerRatio`/`targetRatio`
 *   ∉(0,1)、`targetRatio >= triggerRatio` → **throw**（对齐 recallRanking /
 *   parseSemanticGateConfig 的拒绝先例，灰度开关不静默回落）
 * - 其它类型 → throw
 */
export function parseSceneCompactionConfig(raw: unknown): SceneCompactionConfig | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;
  if (raw === true) {
    return {
      enabled: true,
      triggerRatio: SCENE_COMPACTION_DEFAULT_TRIGGER_RATIO,
      targetRatio: SCENE_COMPACTION_DEFAULT_TARGET_RATIO,
    };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `[config] persona.sceneCompaction 非法类型 ${typeof raw}（合法：缺省/false=off、true=默认开启、{enabled,triggerRatio,targetRatio}）`,
    );
  }
  const obj = raw as Record<string, unknown>;
  if (obj.enabled !== undefined && typeof obj.enabled !== "boolean") {
    throw new Error(
      `[config] persona.sceneCompaction.enabled 非法值 ${JSON.stringify(obj.enabled)}（合法：true|false）`,
    );
  }
  const triggerRatio =
    obj.triggerRatio === undefined ? SCENE_COMPACTION_DEFAULT_TRIGGER_RATIO : obj.triggerRatio;
  const targetRatio =
    obj.targetRatio === undefined ? SCENE_COMPACTION_DEFAULT_TARGET_RATIO : obj.targetRatio;
  if (!isRatio(triggerRatio)) {
    throw new Error(
      `[config] persona.sceneCompaction.triggerRatio 非法值 ${JSON.stringify(triggerRatio)}（必须在 (0,1) 内）`,
    );
  }
  if (!isRatio(targetRatio)) {
    throw new Error(
      `[config] persona.sceneCompaction.targetRatio 非法值 ${JSON.stringify(targetRatio)}（必须在 (0,1) 内）`,
    );
  }
  if (targetRatio >= triggerRatio) {
    throw new Error(
      `[config] persona.sceneCompaction 非法组合 targetRatio=${targetRatio} >= triggerRatio=${triggerRatio}（压实目标必须低于触发线）`,
    );
  }
  return { enabled: obj.enabled === true, triggerRatio, targetRatio };
}
