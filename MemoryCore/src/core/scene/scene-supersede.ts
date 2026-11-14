/**
 * 票 P1-6b 方案三：确定性同锚替代折叠（pure，零 I/O，默认不被任何调用方接线）。
 *
 * 动机：⑥ 显式失效机制在位（标记/守卫/读过滤/帽排除）但生成侧为零——同锚重投与
 * 交叉复述行随批次累积（实测锚点重复率 34%~73%），「同源重投复验零新增」刷屏。
 * 本模块以**确定性规则**生成 `[SUPERSEDED <ISO>]` 标记（只标不删）：
 *
 * - **新旧判定（行内时间戳，2026-11-09 影子审计修订）**：实测 14 个真实场景文件的
 *   批次方向**混合**（多数「最新批在上」、PR 战役族新旧交错），行序不可作为新近依据；
 *   改为**成对比较行内 ISO 时间戳**——被标行的时间戳必须严格早于同锚对照行，任一行
 *   无可解析时间戳或时间相同 → 跳过不标（宁漏勿错）。
 * - **判据**：行 L 含锚点 a，a 的同锚行中存在时间戳严格晚于 L 的行 M，且 L 与 M 的
 *   **锚点脱敏**文本相似度 ≥ minSimilarity → L 判为同源重投，加标记。
 *   相似度对锚点脱敏（锚点串共享会虚增相似度，导致交叉复述被误标）。
 * - **豁免**：META 头（首对 `---` 之间）与 `## 要点` 段永不标记（摘要层非事实层）；
 *   已标行跳过（防叠前缀）；无锚行不动；无时间戳行不动（计入 sparedNoDate）。
 * - **不变量**：只加前缀不改 id ⇒ 锚点多重集零变化（`checkAnchorPreservation` 口径）。
 * - **联动**：标记行进入既有 `filterSupersededLines`（读过滤）与
 *   `countSupersededChars`（C 帽排除口径），零额外接线即生效。
 * - 纯函数、同输入逐字节同输出；`now` 由调用方注入以便测试与幂等复核。
 */

import { ANCHOR_RE, isSupersededLine } from "../../utils/supersede.js";

const HEADING_RE = /^## /;
const GIST_HEADING_RE = /^## 要点\s*$/;
const DEFAULT_MIN_SIMILARITY = 0.55;

export interface SupersedePair {
  /** 被标旧行号（0-based）。 */
  oldIndex: number;
  /** 同锚最新行号。 */
  newIndex: number;
  /** 触发判定的锚点 id。 */
  anchor: string;
  /** 脱敏文本相似度（0-1）。 */
  similarity: number;
}

export interface SupersedeOutcome {
  /** 折叠后全文（无变更时逐字节等于输入）。 */
  content: string;
  /** 本次新加标记的行号（升序）。 */
  markedLines: number[];
  /** 折叠对明细（按 oldIndex 升序；每行只记首个命中的锚）。 */
  pairs: SupersedePair[];
  /** 存在时间戳更晚的同锚出现、但相似度不足而豁免的行数。 */
  sparedLowSim: number;
  /** 同锚多重集 >1 但本行无可解析时间戳、无法判定新旧而跳过的行数。 */
  sparedNoDate: number;
  /** 同锚多重集 >1 但所有对照行均不合格（保护区/已标/跨档/非更新）而无可判的行数。 */
  sparedNoCandidate: number;
}

/** 行序二字 gram Jaccard 相似度（空白归一；任一方 <2 字符时退化为全等判定）。 */
export function textSimilarity(a: string, b: string): number {
  const x = a.replace(/\s+/g, "");
  const y = b.replace(/\s+/g, "");
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = (s: string): Set<string> => {
    const m = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) m.add(s.slice(i, i + 2));
    return m;
  };
  const gx = grams(x);
  const gy = grams(y);
  let inter = 0;
  for (const g of gx) if (gy.has(g)) inter++;
  return inter / (gx.size + gy.size - inter);
}

function stripAnchors(s: string): string {
  return s.replace(ANCHOR_RE, " ");
}

const ISO_TIME_RE = /20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/;
/** 已标行前缀：其中的标记时间戳不是事实时间，扫时间戳前必须剥离（防已标行反超最新行）。 */
const SUPERSEDED_PREFIX_RE = /^\s*\[SUPERSEDED [^\]]*\]\s*/;

// ---- 迭代一（REV-20261110+补丁①）：分层时间戳形态学 ----
// 优先级：绝对类（abs）行内首个优先 → naive → dateOnly 兜底。
// 1. ISO 带时区  2. MM-DD HH:MMZ(UTC)  3. 北京 MM-DD HH:MM(+8)  4. naive MM-DD HH:MM(UTC)
// 5. YYYY-MM-DD（含无时区 ISO 的日期部分，C2）  6. 裸 MM-DD（左边界 (?<![\w-]) 挡票号/版本号）
const RE_ISO_TZ = ISO_TIME_RE;
const RE_MMZ = /(?<![\w-])(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})Z(?![\w-])/;
const RE_BEIJING = /北京\s*(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?!\d)/;
const RE_NAIVE = /(?<![\w-])(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?!Z)(?![\d:-])/;
const RE_YMD = /(?<![\w-])(20\d{2})-(\d{2})-(\d{2})(?![\d-])/;
const RE_BARE_MD = /(?<![\w.-])(\d{1,2})-(\d{1,2})(?!\s*\d{1,2}:\d{2})(?![\d-])/;

/** 时间戳档位：abs=绝对时刻（含时区或 UTC 假定）/ naive=无时区钟点 / date=仅日期（UTC 日界）。 */
export type LineTimeKind = "abs" | "naive" | "date";
export interface LineTime {
  ms: number;
  kind: LineTimeKind;
}

const DAY_MS = 86_400_000;

/**
 * 行内分层时间戳解析（迭代一）：取**行内首个**匹配（绝对类优先）——行首日期通常是本行
 * 批次/事实日期，行中他批引用不参与。返回 {ms, kind}；date 档 ms 归一为 UTC 日界；
 * naive/MMZ 一律按 UTC 构造、北京按 +8 折算。无可解析 → null。
 */
export function parseLineTime(line: string, nowMs: number): LineTime | null {
  const body = line.replace(SUPERSEDED_PREFIX_RE, "");
  let m: RegExpMatchArray | null;
  if ((m = body.match(RE_ISO_TZ))) {
    const ms = Date.parse(m[0]);
    if (Number.isFinite(ms)) return { ms, kind: "abs" };
  }
  if ((m = body.match(RE_MMZ))) {
    const year = new Date(nowMs).getUTCFullYear();
    const ms0 = Date.UTC(year, Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]));
    const ms = ms0 > nowMs + 2 * DAY_MS ? ms0 - 365 * DAY_MS : ms0;
    if (Number.isFinite(ms)) return { ms, kind: "abs" };
  }
  if ((m = body.match(RE_BEIJING))) {
    const year = new Date(nowMs).getUTCFullYear();
    const ms0 = Date.UTC(year, Number(m[1]) - 1, Number(m[2]), Number(m[3]) - 8, Number(m[4]));
    const ms = ms0 > nowMs + 2 * DAY_MS ? ms0 - 365 * DAY_MS : ms0;
    if (Number.isFinite(ms)) return { ms, kind: "abs" };
  }
  if ((m = body.match(RE_NAIVE))) {
    const year = new Date(nowMs).getUTCFullYear();
    const ms0 = Date.UTC(year, Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]));
    const ms = ms0 > nowMs + 2 * DAY_MS ? ms0 - 365 * DAY_MS : ms0;
    if (Number.isFinite(ms)) return { ms, kind: "naive" };
  }
  if ((m = body.match(RE_YMD))) {
    const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (Number.isFinite(ms)) return { ms, kind: "date" };
  }
  if ((m = body.match(RE_BARE_MD))) {
    const year = new Date(nowMs).getUTCFullYear();
    const ms0 = Date.UTC(year, Number(m[1]) - 1, Number(m[2]));
    const ms = ms0 > nowMs + 2 * DAY_MS ? ms0 - 365 * DAY_MS : ms0;
    if (Number.isFinite(ms)) return { ms, kind: "date" };
  }
  return null;
}

export function deterministicSupersede(
  raw: string,
  opts: { minSimilarity?: number; now?: string } = {},
): SupersedeOutcome {
  const minSim = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const now = opts.now ?? new Date().toISOString();
  const lines = raw.split("\n");

  // 豁免区：META 头（首对 --- 之间）+ ## 要点 段（标题至下一 ## 标题）。
  let metaEnd = -1;
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === "---") {
        metaEnd = i;
        break;
      }
    }
  }
  const protectedFlag = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i <= metaEnd; i++) protectedFlag[i] = true;
  for (let i = 0; i < lines.length; i++) {
    if (!GIST_HEADING_RE.test(lines[i] ?? "")) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (HEADING_RE.test(lines[j] ?? "")) {
        end = j;
        break;
      }
    }
    for (let k = i; k < end; k++) protectedFlag[k] = true;
  }

  // 锚点 → 出现行号（含豁免行与已标行；新近由行内时间戳判定，与行序无关）。
  const groups = new Map<string, number[]>();
  for (let i = 0; i < lines.length; i++) {
    const ids = lines[i]?.match(ANCHOR_RE) ?? [];
    for (const id of ids) {
      const arr = groups.get(id);
      if (arr) arr.push(i);
      else groups.set(id, [i]);
    }
  }

  const out = lines.slice();
  const markedLines: number[] = [];
  const pairs: SupersedePair[] = [];
  let sparedLowSim = 0;
  let sparedNoDate = 0;
  let sparedNoCandidate = 0;
  const nowMs = Date.parse(now);
  for (let i = 0; i < out.length; i++) {
    const line = out[i] ?? "";
    if (protectedFlag[i] || isSupersededLine(line) || line.trim() === "") continue;
    const ids = [...new Set(line.match(ANCHOR_RE) ?? [])];
    if (ids.length === 0) continue;
    // 同锚多重集 >1 才有「重投」可言；唯一锚点行不进任何 spared 计数。
    const dupAnchor = ids.some((id) => (groups.get(id)?.length ?? 0) > 1);
    const lineTime = parseLineTime(line, nowMs);
    if (lineTime === null) {
      // 本行无时间戳 → 新旧不可判定，跳过（宁漏勿错）。
      if (dupAnchor) sparedNoDate++;
      continue;
    }
    let hasCandidate = false;
    let hit: SupersedePair | null = null;
    for (const id of ids) {
      // 对照行 = 同锚、非保护区、非已标、**同档位**、时间戳严格晚于本行的行（取最新；并列取最小行号保确定性）。
      let best = -1;
      let bestTime = lineTime.ms;
      for (const j of groups.get(id)!) {
        if (j === i) continue;
        if (protectedFlag[j] || isSupersededLine(out[j] ?? "")) continue;
        const t = parseLineTime(out[j] ?? "", nowMs);
        if (t === null || t.kind !== lineTime.kind || t.ms <= lineTime.ms) continue;
        if (t.ms > bestTime || (t.ms === bestTime && best >= 0 && j < best)) {
          best = j;
          bestTime = t.ms;
        }
      }
      if (best < 0) continue;
      hasCandidate = true;
      const sim = textSimilarity(stripAnchors(line), stripAnchors(out[best] ?? ""));
      if (sim >= minSim) {
        hit = { oldIndex: i, newIndex: best, anchor: id, similarity: sim };
        break;
      }
    }
    if (hit) {
      out[i] = `[SUPERSEDED ${now}] ${line}`;
      markedLines.push(i);
      pairs.push(hit);
    } else if (hasCandidate) {
      sparedLowSim++;
    } else if (dupAnchor) {
      sparedNoCandidate++;
    }
  }

  return { content: out.join("\n"), markedLines, pairs, sparedLowSim, sparedNoDate, sparedNoCandidate };
}

// ---- 配置解析（票 P1-6b 接线；同款先例：parseSceneCompactionConfig 拒绝式） ----

export type FactSupersedeMode = "off" | "shadow" | "on";

export interface FactSupersedeConfig {
  /** off=关闭；shadow=只计量不落盘；on=落盘写标记。 */
  mode: FactSupersedeMode;
  /** 同锚旧行与最新行的最低脱敏相似度（0,1）。 */
  minSimilarity: number;
}

export const FACT_SUPERSEDE_DEFAULT_MIN_SIMILARITY = 0.55;

/**
 * 解析 `persona.factSupersede`：
 * - undefined/null/false → undefined（off，Phase 5 零 I/O）
 * - true → { mode:"shadow", minSimilarity:0.55 }（安全默认=影子先量）
 * - 对象 → mode 缺省 "shadow"、minSimilarity 缺省 0.55；mode=off → undefined
 * - 非法 mode / 阈值越出 (0,1) / 非布尔非对象 → throw（不静默回落）
 */
export function parseFactSupersedeConfig(raw: unknown): FactSupersedeConfig | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;
  if (raw === true) return { mode: "shadow", minSimilarity: FACT_SUPERSEDE_DEFAULT_MIN_SIMILARITY };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("persona.factSupersede 必须为布尔或对象（{mode, minSimilarity}）");
  }
  const o = raw as Record<string, unknown>;
  const modeRaw = o.mode ?? "shadow";
  if (modeRaw !== "off" && modeRaw !== "shadow" && modeRaw !== "on") {
    throw new Error(`persona.factSupersede.mode 非法: ${String(modeRaw)}（只允许 off|shadow|on）`);
  }
  const simRaw = o.minSimilarity ?? FACT_SUPERSEDE_DEFAULT_MIN_SIMILARITY;
  if (typeof simRaw !== "number" || !Number.isFinite(simRaw) || simRaw <= 0 || simRaw >= 1) {
    throw new Error(`persona.factSupersede.minSimilarity 须为 (0,1) 开区间数值: ${String(simRaw)}`);
  }
  if (modeRaw === "off") return undefined;
  return { mode: modeRaw, minSimilarity: simRaw };
}
