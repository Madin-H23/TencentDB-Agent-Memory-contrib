/**
 * 票⑥（exp/p1-6-supersede-inval）：显式失效替代硬删（recency-wins with explicit invalidation）纯模块。
 *
 * ## 设计说明（装配面与取舍）
 *
 * **根因**：L2 MERGE/折叠语义把被替换内容物理删除——行级折叠删行（UPDATE/edit 重写掉旧批次段）
 * 与文件级 MERGE（旧文件 write `[DELETED]` → 工程侧 unlink 整文件）都是 10-30 锚点流失的根因。
 * Zep bi-temporal 与 Hindsight 的同构解：**不删，标记失效**（recency-wins with explicit
 * invalidation）。仓内同构先例：Hy-Memory A1 的 `[DELETED]` 前缀白名单（C 帽对删除标记放行）。
 *
 * **标记格式**：`[SUPERSEDED <ISO时间>] ` 作为**行前缀**（沿用仓内全大写方括号标记风格）。
 * 被替代的旧事实行/段落**整行加前缀留存**，原行内容（含锚点 id）原样保留——锚点行
 * `m_<millis>_<8hex>` 永不物理删除。段落失效 = 段内每行各加前缀（保持行级过滤口径单一）。
 *
 * **判定口径**：行首（允许前导空白）出现 `[SUPERSEDED` 且其后一字符不是字母/数字/连字符
 * → 失效行。半截标记（`[SUPERSEDE`）、变体词（`[SUPERSEDED2`/`[SUPERSEDED-FOO`）、行中引用
 * 字样一律**不判失效**（保守：宁可不过滤也不误滤正常内容）。`[DELETED]` 是文件级软删标记，
 * 与失效行无关。
 *
 * **守卫（on 时由工具层在落盘前调用，storage-tools 与 llm-runner 沙箱双工厂共用）**：
 * - a) 行级保锚：write/edit 后像的锚点多重集必须 ≥ 前像多重集（按 id 计数逐 id 比对），
 *   缺失 → `anchor_loss_forbidden` 结构化拒绝且不落盘。加 `[SUPERSEDED]` 前缀不改 id，
 *   不算丢失——模型保留锚点的正确出路。
 * - b) 文件级重定位：content=`[DELETED]`（软删流，MERGE 收尾）时，被删文件的锚点必须已
 *   出现在同目录其余场景文件中（多重集），否则拒绝——MERGE 文件删除 lost=0 的机制保证
 *   （提示词软约束已被 B 票 P0-C 教训证明不足）。
 *
 * **C 帽交互（票面 c 项二选一）**：取「**失效段不计入后像帽**」——on 时对剔除失效行后的
 * 文本测帽，拒绝体附 supersededChars/supersededLines。理由：①整文件豁免（`[DELETED]` 先例）
 * 会让单行失效标记成为绕帽万能钥匙，帽对活内容失去约束；②排除法下失效越多可写余量越大，
 * 与 recency-wins 正向耦合，模型有明确出路（正是 10-30 帽下有损折叠的反向解药）。
 * off 时走原 checkSceneCharCap 口径（原函数零改动）。
 *
 * **锚点 id 口径**：与 `scripts/l2-score.mjs` 的 `ANCHOR_RE = /m_\d{13}_[0-9a-f]{8}/g`
 * 逐字同款（多重集 = 数组不去重）。
 *
 * 全部纯函数；off 路径不进入本模块任何函数（工具层开关短路），off 行为逐字节不变。
 */

import { SCENE_CHAR_CAP_HINT, type SceneCharCapRejection } from "./scene-char-cap.js";

/** 失效行前缀判定：行首 `[SUPERSEDED`，其后不得是字母/数字/连字符（防变体词/半截误判）。 */
const SUPERSEDED_LINE_RE = /^[^\S\r\n]*\[SUPERSEDED(?![A-Za-z0-9-])/;

/** 锚点 id 正则：与 scripts/l2-score.mjs ANCHOR_RE 逐字同款（对账口径）。 */
export const ANCHOR_RE = /m_\d{13}_[0-9a-f]{8}/g;

/** 行级保锚拒绝 hint：给出保留锚点的正确出路（加失效标记而非删除）。 */
export const ANCHOR_LOSS_HINT =
  "recency-wins: 锚点行（m_<ts>_<hash>）不可物理删除——被替代的旧事实行加 [SUPERSEDED <ISO时间>] 前缀标记失效后留存";

/** 文件级重定位拒绝 hint：先迁移锚点再写 [DELETED]。 */
export const RELOCATE_HINT =
  "先将被删除文件的事实锚点行（m_<ts>_<hash>）移入合并后的目标文件（被替代的行加 [SUPERSEDED <ISO时间>] 标记），再写 [DELETED]";

/** 结构化拒绝体（行级保锚 / 文件级重定位共用 error 码，lost 为丢失样例封顶 5）。 */
export interface AnchorLossRejection {
  error: "anchor_loss_forbidden";
  lostCount: number;
  lost: string[];
  hint: string;
}

/** 单行是否为失效行。 */
export function isSupersededLine(line: string): boolean {
  return SUPERSEDED_LINE_RE.test(line);
}

/**
 * 行级过滤：默认剔除失效行（read 工具 on 时的默认口径）；
 * `includeInvalidated: true` 原样逐字节返回（审计面，= 基线 read 输出）。
 * 按行 split("\n") 过滤再 join——行边界在 \n（非代理对码元），不劈码点。
 */
export function filterSupersededLines(
  content: string,
  opts?: { includeInvalidated?: boolean },
): string {
  if (opts?.includeInvalidated) return content;
  if (!content) return content;
  const lines = content.split("\n");
  let hasSuperseded = false;
  for (const line of lines) {
    if (SUPERSEDED_LINE_RE.test(line)) {
      hasSuperseded = true;
      break;
    }
  }
  if (!hasSuperseded) return content;
  return lines.filter((line) => !SUPERSEDED_LINE_RE.test(line)).join("\n");
}

/** 失效行计数。 */
export function countSupersededLines(content: string): number {
  if (!content) return 0;
  let n = 0;
  const lines = content.split("\n");
  for (const line of lines) {
    if (SUPERSEDED_LINE_RE.test(line)) n++;
  }
  return n;
}

/**
 * 失效行占用字符数（含各自行尾换行；末行无换行不加）。
 * C 帽排除口径的分母：`content.length - countSupersededChars` = 活内容字符数。
 */
export function countSupersededChars(content: string): number {
  if (!content) return 0;
  const lines = content.split("\n");
  let chars = 0;
  for (let i = 0; i < lines.length; i++) {
    if (SUPERSEDED_LINE_RE.test(lines[i]!)) {
      chars += lines[i]!.length + (i < lines.length - 1 ? 1 : 0);
    }
  }
  return chars;
}

/** 锚点 id 多重集（数组不去重）。 */
export function extractAnchorIds(content: string): string[] {
  return content.match(ANCHOR_RE) ?? [];
}

/** 多重集差：pre 中减去 post 后仍缺的实例（逐 id 计数比对）。 */
function multisetDeficit(pre: string[], post: string[]): string[] {
  const postCount = new Map<string, number>();
  for (const id of post) postCount.set(id, (postCount.get(id) ?? 0) + 1);
  const lost: string[] = [];
  for (const id of pre) {
    const remain = postCount.get(id) ?? 0;
    if (remain > 0) postCount.set(id, remain - 1);
    else lost.push(id);
  }
  return lost;
}

/**
 * 行级保锚守卫：pre（写入前内容，null=新建文件）→ post（写入后像）。
 * 加 `[SUPERSEDED]` 前缀保留 id 不算丢失；丢失 → 结构化拒绝（lost 样例封顶 5）。
 */
export function checkAnchorPreservation(
  pre: string | null,
  post: string,
): AnchorLossRejection | null {
  if (pre === null) return null;
  const lost = multisetDeficit(extractAnchorIds(pre), extractAnchorIds(post));
  if (lost.length === 0) return null;
  return {
    error: "anchor_loss_forbidden",
    lostCount: lost.length,
    lost: lost.slice(0, 5),
    hint: ANCHOR_LOSS_HINT,
  };
}

/**
 * 文件级重定位守卫：被 [DELETED] 文件的锚点多重集，减去其余场景文件锚点多重集
 * 合计后仍缺的实例。空数组 = 可安全删除（锚点已在他处留存）。
 */
export function findUnrelocatedAnchors(dyingContent: string, otherContents: string[]): string[] {
  const pooled: string[] = [];
  for (const other of otherContents) pooled.push(...extractAnchorIds(other));
  return multisetDeficit(extractAnchorIds(dyingContent), pooled);
}

/**
 * C 帽 on 口径：对「剔除失效行后的活内容」测帽（失效段不计入后像帽）。
 * 拒绝体在方案C 五键（error/chars/cap/overflow/hint）之上附加
 * supersededChars/supersededLines，让模型可感知失效腾出的余量。
 * cap ≤0/undefined/NaN = off → null（与 checkSceneCharCap 同判）。
 */
export function checkSceneCharCapWithSupersede(
  content: string,
  cap: number | undefined,
): (SceneCharCapRejection & { supersededChars: number; supersededLines: number }) | null {
  if (cap === undefined || !Number.isFinite(cap) || cap <= 0) return null;
  const supersededChars = countSupersededChars(content);
  const supersededLines = countSupersededLines(content);
  const liveChars = content.length - supersededChars;
  if (liveChars <= cap) return null;
  return {
    error: "over_scene_char_cap",
    chars: liveChars,
    cap,
    overflow: liveChars - cap,
    hint: SCENE_CHAR_CAP_HINT,
    supersededChars,
    supersededLines,
  };
}

/** 失效标记增量（metric=l2_supersede 的 value）：post 失效行数 − pre 失效行数。 */
export function supersedeDelta(pre: string | null, post: string): number {
  return countSupersededLines(post) - (pre === null ? 0 : countSupersededLines(pre));
}
