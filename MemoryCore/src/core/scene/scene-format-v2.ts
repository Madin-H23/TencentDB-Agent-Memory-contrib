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

import { ANCHOR_RE } from "../../utils/supersede.js";
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

/** META 块内的 summary 行（与 parseSceneBlock/extractMetaField 同口径：首个 summary 键）。 */
const META_SUMMARY_LINE_RE = /^summary:[ \t]*(.*)$/m;

/** 行级锚点判定：与 ANCHOR_RE 同源（去掉 g 标志，避免 test 的 lastIndex 状态）。 */
const HAS_ANCHOR_RE = new RegExp(ANCHOR_RE.source);

/** 正文 H2 标题行（`###` 不匹配）——迁移时降级为 H3。 */
const H2_LINE_RE = /^##([ \t]+.*?)(\r?)$/;

/**
 * v1 正文里已有的 `## 活动` 标题行（防御性并入归档，不重复建段）。
 *
 * 允许后缀：离线压实产物会写成 `## 活动（折叠归档：每批一行，锚点保留）`——
 * 只认精确 `## 活动` 会让整段被当结构化段，折叠归档重新进入默认读视图。
 */
const ARCHIVE_HEADING_LINE_RE = /^##[ \t]+活动(?:[（(][^\n]*)?[ \t]*\r?$/;

/** 批次段标题：`## ★…`（L2 逐批追加的过程叙事段）。 */
const BATCH_HEADING_LINE_RE = /^##[ \t]+★/;

/** 去掉行数组首尾的空行（结构边界），中部空行原样保留。 */
function trimBlankEdges(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a]!.trim() === "") a++;
  while (b > a && lines[b - 1]!.trim() === "") b--;
  return lines.slice(a, b);
}

/** 归档段标题降级：`## X` → `### X`（保留原有空白与行尾 \r）。 */
function demoteH2(line: string): string {
  const m = line.match(H2_LINE_RE);
  return m ? `###${m[1]}${m[2]}` : line;
}

/** 正文段：标题行（null = 首个 `## ` 之前的序言）+ 段内全部行（含标题行）。 */
interface BodySection {
  heading: string | null;
  lines: string[];
}

/**
 * 按 `## ` 段标题切分正文（`###` 不是段界）。首个 `## ` 之前的序言作为一段
 * （heading=null），随后的每个 `## ` 行开启新段。
 */
function splitBodySections(lines: string[]): BodySection[] {
  const sections: BodySection[] = [];
  let current: BodySection = { heading: null, lines: [] };
  for (const line of lines) {
    if (H2_LINE_RE.test(line)) {
      sections.push(current);
      current = { heading: line, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections;
}

/**
 * 票⑨（exp/p1-9-scene-v2-migration）：v1/批次格式 → v2 三段结构的**惰性迁移**。
 *
 * 根因（取证 2026-11-03）：L2 实际写入 105 edit : 1 write，edit 只做字符串替换、
 * 不重排文件结构 ⇒ 存量 v1/批次格式（META + 逐批 `## ★…` 段）永远没有 v2 的生成
 * 路径（`syncV2MetaSummary` 对非 v2 原样返回）。本函数在工具层 write/edit 落盘前
 * 调用，把任意 v1/批次正文一次性重排为三段，使「下一次写/编辑」即完成迁移。
 *
 * 段路由（**按段分类**，除段标题/降级外不改写任何行内容）：
 * - `## 要点` ← META.summary（首个 summary 键，normalizeSceneSummary：PII 脱敏 + 300 字预算）
 * - `## 事实` ← ①所有含锚点 `m_<ts>_<hash>` 的行（无论在哪段，逐行原样、保序）；
 *   ②**结构化段**（非 `## ★…` 批次、非 `## 活动` 的任意段，含序言）内的无锚点行——
 *   段标题降为 `###` 留在事实段内。动机：用户偏好/基础信息/隐性信号/核心叙事等
 *   画像类内容多数不带锚点，若按纯行级路由会落进默认读不可见的 `## 活动`，造成
 *   存量功能回归（票⑨ 复核 2026-11-03）。
 * - `## 活动` ← 批次段（`## ★…`，标题降为 `###` 保留每批一行/段）与已有 `## 活动`
 *   段的无锚点行；已有 `## 活动` 段并入同一段，不重复建段。
 *
 * 保守返回（不破坏）：已是 v2（`isV2Format`，含仅带任一 v2 段标题的文件）原样；
 * META 缺失/END 在 START 前/META 内无 summary 字段原样；空串/纯空白原样。
 *
 * 硬不变量：**锚点零丢失**（输入每个 id 的出现次数 ≤ 输出；唯一集合完全一致）。
 * 计数可能盈余（绝无缺失）：META.summary 自身若含锚点，会被投影进 `## 要点`——这是
 * 必要的（后续 syncV2MetaSummary 用要点覆盖 summary，若要点剥掉锚点反而会真丢）。
 * 实测 14 个存量场景：2736 → 2767（盈余 31，全部来自 summary 投影），deficit=0。
 * 幂等：输出必含 v2 段标题，二次调用走 `isV2Format` 短路逐字节返回。
 */
export function toV2Format(raw: string): string {
  if (!raw || isV2Format(raw)) return raw;
  const startIdx = raw.indexOf(META_START);
  const endIdx = raw.indexOf(META_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return raw;
  const metaEnd = endIdx + META_END.length;
  const summaryMatch = raw.slice(startIdx + META_START.length, endIdx).match(META_SUMMARY_LINE_RE);
  if (!summaryMatch) return raw; // META 畸形（无 summary 字段）→ 不破坏
  const summary = normalizeSceneSummary(summaryMatch[1]!.trim());

  const factLines: string[] = [];
  const archiveLines: string[] = [];
  for (const section of splitBodySections(raw.slice(metaEnd).split("\n"))) {
    const toArchive =
      section.heading !== null &&
      (BATCH_HEADING_LINE_RE.test(section.heading) || ARCHIVE_HEADING_LINE_RE.test(section.heading));
    for (let i = 0; i < section.lines.length; i++) {
      const line = section.lines[i]!;
      const isHeading = section.heading !== null && i === 0;
      // 标题行一律降级（避免事实段内再出现 H2；锚点行不受降级影响）
      const routed = isHeading ? demoteH2(line) : line;
      if (HAS_ANCHOR_RE.test(line)) {
        factLines.push(routed); // 锚点行无论在哪段都是事实载体
      } else if (toArchive) {
        if (isHeading && ARCHIVE_HEADING_LINE_RE.test(line)) continue; // 已有 `## 活动`：并入，不重复建段
        archiveLines.push(routed);
      } else {
        factLines.push(routed); // 结构化段：无锚点内容进事实，默认 read 可见
      }
    }
  }

  const out = [
    raw.slice(0, metaEnd), // 前缀 + META 块逐字节原样
    "",
    V2_GIST_HEADING,
    ...(summary ? [summary] : []),
    "",
    V2_FACTS_HEADING,
    ...trimBlankEdges(factLines),
    "",
    V2_ARCHIVE_HEADING,
    ...trimBlankEdges(archiveLines),
  ].join("\n");
  // 文件末尾换行与输入同形（无内容损失的结构性保持）
  return raw.endsWith("\n") ? `${out}\n` : out;
}
