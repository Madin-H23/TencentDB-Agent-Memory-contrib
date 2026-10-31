/**
 * 票⑤（exp/p1-5-scene-format-v2）：场景格式 v2 双层化纯模块。
 *
 * ## v2 文件格式定义（与解析器一并固化）
 *
 * v2 场景文件 = 既有 META 块（`-----META-START-----`…`-----META-END-----`，字段与
 * v1 完全一致）+ 正文三个**固定段**（段标题逐字匹配、各占一行）：
 *
 * ```
 * ## 要点   ← ≤300 字稳定摘要（2-3 句话），被系统同步为 META.summary 并进 D 索引段
 * ## 事实   ← 唯一事实载体：每条事实独立一行，行内带锚点 id（m_<ts>_<hash>）；
 *              被替代的旧行在段内原地加 [SUPERSEDED <ISO时间>] 前缀（票⑥语义，见下）
 * ## 活动   ← 批次叙事归档（按批次组织的过程叙述），只追加不重写；
 *              默认 read 不返回，includeArchive:true 才返回
 * ```
 *
 * 段标题判定：行首（不允许前导空白——比失效行判定更严，防止把缩进正文误判成段
 * 边界）`## 要点|事实|活动`，行尾只允许空白。半截（`## 要`）、变体（`## 要点点`、
 * `## 活动2`）、行中引用一律不识别（保守：识别不出 = 按 v1 全文返回，不丢内容）。
 * 同名标题重复出现时首个生效，后续同名行仍是前一段的边界。
 *
 * ## 装配面与设计取舍
 *
 * - **要点层与 META.summary 同源**：syncV2MetaSummary 实现「`## 要点` 段 →
 *   META.summary」**单向覆盖**（要点是源，META 是投影）。D 索引段（方案D）经
 *   syncSceneIndex → parseSceneBlock → normalizeSceneSummary 读 META.summary，
 *   因此工具层同步后索引自动拿到 ≤300 字要点，**零新链路**。时间戳：工具层不触碰
 *   created/updated（由模型按提示词维护），避免每次写入抖动更新时间。
 * - **read 默认 = 要点+事实**（活动区折叠）：buildV2ReadView 剥离 `## 活动` 段，
 *   剥离行字节 = 原文对应行（**折叠不触碰前两层**的机制保证）；剥离发生时追加
 *   折叠标注行（样式与方案B 窗口标注同族）。includeArchive:true = 全量原文逐字节
 *   （审计面）。
 * - **过滤→窗口（v2 on 口径）**：v2 开启时 read 管线为「活动段剥离 → 失效行过滤
 *   （票⑥ on 时）→ applyReadWindow」，窗口 offset/limit/标注都作用于过滤后的
 *   两层视图——翻页自洽（标注 total 即可见总量，窗口不会指向被折叠的不可达区）。
 *   票⑥ 的「窗口→过滤、坐标=原文」口径仅在 v2 off 时保留（行为逐字节不变）；
 *   审计全量 = includeArchive:true + includeInvalidated:true（视图=原文，回到
 *   票⑥/方案B 基线 read）。v1 文件在 v2 模式下不做段剥离（非 v2 原样返回），
 *   失效行过滤照票⑥ 口径在窗口前执行——混合语料下同一管线，无第二套坐标语义。
 * - **失效标记落层（票面 e 项）**：事实行被取代 → 在 `## 事实` 段内**原地**加
 *   `[SUPERSEDED <ISO>]` 前缀，**不移活动区**。理由：①票⑥ 的守卫/过滤/帽排除
 *   全部按行级口径运作，原地留存语义单一；②移活动区会让失效事实进入默认不可见
 *   区，审计需双旗（includeArchive+includeInvalidated）且折叠活动区可能连带
 *   失效事实；③锚点守卫按全文多重集判定，移动无收益。
 * - **C 帽交互**：帽口径不变——仍按整文件后像（票⑥ on 时叠加失效排除口径）。
 *   v2 的「单场景默认 read ≤32K」由**读侧两层视图**达成（要点≤300+事实行），
 *   与写侧帽解耦；帽继续约束磁盘文件整体尺寸（活动区增长仍受 300K 在役帽约束）。
 * - **折叠/归档只动活动区**：本模块是 read 路径唯一的段剥离点；offline l2-compact
 *   （exp-wt-a 分支，未进 develop）的折叠对象天然=活动区批次叙事，其 v2 感知待该
 *   分支合流后由后续票接线（本票只保证 read 侧机制：任何折叠都发生在活动区段内，
 *   前两层字节不被触碰）。
 *
 * 全部纯函数；off 路径不进入本模块任何函数（工具层开关短路），off 行为逐字节不变。
 */

import { META_END, META_START, normalizeSceneSummary } from "./scene-format.js";

/** v2 段标题（逐字口径）。 */
export const V2_GIST_HEADING = "## 要点";
export const V2_FACTS_HEADING = "## 事实";
export const V2_ARCHIVE_HEADING = "## 活动";

/** 段标题判定：行首逐字 `## <词>`，行尾只允许空白（CRLF 的 \r 被覆盖）。 */
const V2_HEADING_RE = /^## (要点|事实|活动)[ \t\r]*$/;

export type V2SectionKey = "要点" | "事实" | "活动";

export interface V2SectionSpan {
  /** 段标题行下标（含）。 */
  start: number;
  /** 段结束行下标（不含）= 下一个 v2 段标题行下标或 EOF。 */
  end: number;
}

export interface V2Sections {
  gist?: V2SectionSpan;
  facts?: V2SectionSpan;
  archive?: V2SectionSpan;
}

function keyToField(key: V2SectionKey): "gist" | "facts" | "archive" {
  return key === "要点" ? "gist" : key === "事实" ? "facts" : "archive";
}

/**
 * 解析 v2 段布局。同名标题**连续出现**（中间无其它段标题）时并入同一段区域
 * （模型分段追加活动区的容错）；段尾 = 文件中下一个**异名** v2 段标题行或 EOF。
 * 同名段被其它段隔开时，首个生效（后续忽略）。
 */
export function findV2Sections(raw: string): V2Sections {
  const out: V2Sections = {};
  if (!raw) return out;
  const lines = raw.split("\n");
  const marks: Array<{ key: V2SectionKey; idx: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(V2_HEADING_RE);
    if (m) marks.push({ key: m[1] as V2SectionKey, idx: i });
  }
  let i = 0;
  while (i < marks.length) {
    const { key, idx } = marks[i]!;
    let j = i + 1;
    while (j < marks.length && marks[j]!.key === key) j++;
    const span: V2SectionSpan = {
      start: idx,
      end: j < marks.length ? marks[j]!.idx : lines.length,
    };
    const field = keyToField(key);
    if (!out[field]) out[field] = span; // 同名被隔开：首个生效
    i = j;
  }
  return out;
}

/** 文件是否带任一 v2 段标题（v1 文件 = false）。 */
export function isV2Format(raw: string): boolean {
  if (!raw) return false;
  const lines = raw.split("\n");
  for (const line of lines) {
    if (V2_HEADING_RE.test(line)) return true;
  }
  return false;
}

/**
 * v2 默认读视图：剥离 `## 活动` 段（标题行连同段内所有行），其余字节不动——
 * **视图 = 原文剥离活动段后的逐字节子集**（体积严格 ≤ 原文，前两层字节不被触碰）。
 * 不追加任何标注行：v2 语义由系统提示词规则块与 read 工具 description 说明
 * （活动段很小时标注行反而会让默认视图大于全文——实测 620 字符文件标注后 648）。
 * - v1 文件（无 v2 段标题）原样返回——混合语料下 read 不变形不报错。
 * - includeArchive:true 跳过剥离返回原文（审计面）。
 */
export function buildV2ReadView(raw: string, opts?: { includeArchive?: boolean }): string {
  if (!raw) return raw;
  if (opts?.includeArchive) return raw;
  const { archive } = findV2Sections(raw);
  if (!archive) return raw;
  const lines = raw.split("\n");
  const before = lines.slice(0, archive.start);
  const after = lines.slice(archive.end);
  let kept = after.length > 0 ? [...before, ...after] : before;
  // 活动段为文件尾时，剥离产生的尾部空行一并去除（仅此情形触碰尾部空白）
  if (after.length === 0) {
    while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
  }
  return kept.join("\n");
}

/** 提取 `## 要点` 段文本（行折叠为单行、空白归一）；无段或空段 → null。 */
export function extractV2Gist(raw: string): string | null {
  const { gist } = findV2Sections(raw);
  if (!gist) return null;
  const lines = raw.split("\n").slice(gist.start + 1, gist.end);
  const text = lines.join(" ").replace(/\s+/g, " ").trim();
  return text ? text : null;
}

/**
 * 「`## 要点` 段 → META.summary」单向覆盖（要点是源）：
 * 摘要 = normalizeSceneSummary(要点折叠单行)（PII 脱敏 + 300 字预算，与 D 索引段
 * 同口径）。幂等——已同步时逐字节原样返回；空要点段/无 META/无 summary 字段/
 * 非 v2 文件一律原样返回（保守不破坏）。
 */
export function syncV2MetaSummary(raw: string): string {
  if (!raw || !isV2Format(raw)) return raw;
  const gistText = extractV2Gist(raw);
  if (!gistText) return raw;
  const summary = normalizeSceneSummary(gistText);
  const startIdx = raw.indexOf(META_START);
  const endIdx = raw.indexOf(META_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return raw;
  const metaBlock = raw.slice(startIdx + META_START.length, endIdx);
  const summaryLineRe = /^summary:[^\n]*$/m;
  if (!summaryLineRe.test(metaBlock)) return raw;
  const newMetaBlock = metaBlock.replace(summaryLineRe, () => `summary: ${summary}`);
  if (newMetaBlock === metaBlock) return raw;
  return raw.slice(0, startIdx + META_START.length) + newMetaBlock + raw.slice(endIdx);
}
