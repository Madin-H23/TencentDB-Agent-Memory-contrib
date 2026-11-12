/**
 * 票 P2-A3 C 案机制化：场景文件归档层（scene-archive）· pure 决策件。
 *
 * 动机：场景文件事实层只增不减（300K 帽），⑧ sceneCompaction 只折活动段**无锚点叙事**
 * （折成标记行只进轮换 .backup·keep=10 会丢），本机制把活动段内**旧批次段整体搬进**
 * `<scene>-archive.md`（可 read 召回·META archive:true 标记·零丢失）。
 *
 * 硬设计（子代理审核闭环·2026-11-12）：
 * - 切片单位＝活动段内旧批次段（头在 `## 活动` 段内且段体不伸出该段）；事实段/要点段/
 *   META 永不搬（默认读视图=要点+事实·搬它们=读损）
 * - 判据＝批次头日期 age > ageDays（rolling 窗口）；**未来段（>now+2d）fail-closed 跳过**
 *   （绝不归档最新段；12 月过去段照常判旧）
 * - 锚点全局守恒：planSceneSpill 内建断言 anchors(mainAfter) ∪ anchors(archiveAppend) ⊇
 *   anchors(before)；不守恒返回空计划（调用方不写盘）
 * - 写序（调用方执行）：archive 先行、main 后行；append 前按段 hash 去重
 * - 幂等：归档后主文件段消失+面包屑 ⇒ 天然幂等
 */

import { ANCHOR_RE } from "../../utils/supersede.js";

// ── 批次头识别（三形态·P1-1 审核补充） ─────────────────────
// `### ★MM-DD HH:MMZ` / `### MM-DD …` / `### YYYY-MM-DD …`；二至四级标题中只认 2-3 级；
// 防误切：裸日期须后跟空白/·/Z/行尾（挡「v1.2-3」「P0-3」「2026-11 版本」）。
export const BATCH_HEAD_RE =
  /^(?:###|##)[ \t]+(?:★[ \t]*)?(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2})(?:[ \t]+[^\n]*)?$/;

const HEADING_RE = /^##[ \t]/;
const ACT_HEADING = "## 活动";

const DAY_MS = 86_400_000;

// ── 配置（拒绝式·同 sceneCompaction/l1Archive 先例） ─────────
export interface SceneArchiveConfig {
  enabled: boolean;
  /** shadow=只计量不写盘；on=工程侧 spill。 */
  mode: "shadow" | "on";
  /** 批次头日期距今 > ageDays 天的段可归档。 */
  ageDays: number;
  /** 保护清单：这些场景永不归档。 */
  protectScenes: string[];
}

export const SCENE_ARCHIVE_DEFAULT_AGE_DAYS = 10;

export function parseSceneArchiveConfig(raw: unknown): SceneArchiveConfig | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;
  if (raw === true) {
    return { enabled: true, mode: "shadow", ageDays: SCENE_ARCHIVE_DEFAULT_AGE_DAYS, protectScenes: [] };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("persona.sceneArchive 必须为布尔或对象（{enabled, mode, ageDays, protectScenes}）");
  }
  const o = raw as Record<string, unknown>;
  const enabled = o.enabled ?? true;
  if (typeof enabled !== "boolean") throw new Error("persona.sceneArchive.enabled 须为布尔");
  if (enabled === false) return undefined;
  const modeRaw = o.mode ?? "shadow";
  if (modeRaw === "off") return undefined;
  if (modeRaw !== "shadow" && modeRaw !== "on") {
    throw new Error(`persona.sceneArchive.mode 非法: ${String(modeRaw)}（只允许 off|shadow|on）`);
  }
  const ageRaw = o.ageDays ?? SCENE_ARCHIVE_DEFAULT_AGE_DAYS;
  if (typeof ageRaw !== "number" || !Number.isFinite(ageRaw) || ageRaw <= 0) {
    throw new Error(`persona.sceneArchive.ageDays 须为正数: ${String(ageRaw)}`);
  }
  let protect: string[] = [];
  if (o.protectScenes !== undefined) {
    if (!Array.isArray(o.protectScenes) || o.protectScenes.some((x) => typeof x !== "string")) {
      throw new Error("persona.sceneArchive.protectScenes 须为字符串数组");
    }
    protect = o.protectScenes as string[];
  }
  return { enabled: true, mode: modeRaw, ageDays: ageRaw, protectScenes: protect };
}

// ── 头日期解析（年份推断·未来 fail-closed） ──────────────────

export interface HeadDate {
  ms: number;
  /** 是否未来（>now+2d）——未来段绝不归档。 */
  future: boolean;
}

/** 解析批次头日期：MM-DD（年份推断）或 YYYY-MM-DD（显式）。 */
export function parseHeadDate(headText: string, nowMs: number): HeadDate | null {
  const m = headText.match(/(\d{4})-(\d{1,2})-(\d{1,2})/) ?? headText.match(/(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  let ms: number;
  if (m.length === 4) {
    ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  } else {
    const year = new Date(nowMs).getUTCFullYear();
    ms = Date.UTC(year, Number(m[1]) - 1, Number(m[2]));
    if (ms > nowMs + 2 * DAY_MS) ms = Date.UTC(year - 1, Number(m[1]) - 1, Number(m[2]));
  }
  if (!Number.isFinite(ms)) return null;
  // 未来判定以「显式年」为准；MM-DD 已做回退，回退后仍 >now+2d 才是真未来
  const future = ms > nowMs + 2 * DAY_MS;
  return { ms, future };
}

// ── 段选择 ─────────────────────────────────────────────────

export interface ArchiveSegment {
  /** 头日期原文（如 "10-29"）。 */
  date: string;
  /** 段在 lines 中的起始行（含头行）。 */
  startLine: number;
  /** 段结束行（不含·即下一头行或活动段尾）。 */
  endLine: number;
  /** 段内容哈希（FNV-1a 8 位·append 去重依据）。 */
  hash: string;
  /** 段字符数。 */
  chars: number;
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * 选出活动段内可归档的旧批次段。
 * 约束：头与段体都在 `## 活动` 段内（跨界 fail-closed）；未来段跳过；
 * age 严格大于 ageDays；protectScenes 命中返空。
 */
export function selectArchiveSegments(
  raw: string,
  cfg: SceneArchiveConfig,
  nowMs: number,
  sceneName?: string,
): ArchiveSegment[] {
  if (sceneName && cfg.protectScenes.includes(sceneName)) return [];
  const lines = raw.split("\n");

  // 活动段边界（精确 v2 段标题）
  let actStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === ACT_HEADING) {
      actStart = i;
      break;
    }
  }
  if (actStart < 0) return []; // 非精确 v2·视图恒等前提不成立
  let actEnd = lines.length;
  for (let i = actStart + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (HEADING_RE.test(l) && !BATCH_HEAD_RE.test(l)) {
      actEnd = i; // 异名 v2 头=活动段结束
      break;
    }
  }

  // 收集活动段内批次头
  const heads: Array<{ line: number; date: string; ms: number }> = [];
  for (let i = actStart + 1; i < actEnd; i++) {
    const l = lines[i]!;
    if (!BATCH_HEAD_RE.test(l)) continue;
    const hd = parseHeadDate(l, nowMs);
    if (!hd) continue;
    heads.push({ line: i, date: l.match(/(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2})/)![0]!, ms: hd.ms });
  }

  const out: ArchiveSegment[] = [];
  for (let k = 0; k < heads.length; k++) {
    const h = heads[k]!;
    if (h.ms > nowMs + 2 * DAY_MS) continue; // 未来段 fail-closed
    if (nowMs - h.ms <= cfg.ageDays * DAY_MS) continue; // 严格大于
    const endLine = k + 1 < heads.length ? heads[k + 1]!.line : actEnd;
    const text = lines.slice(h.line, endLine).join("\n");
    out.push({
      date: h.date,
      startLine: h.line,
      endLine,
      hash: fnv1a(text),
      chars: text.length,
    });
  }
  return out;
}

// ── spill 计划 ─────────────────────────────────────────────

export interface SpillPlan {
  scene: string;
  segments: ArchiveSegment[];
  /** spill 后主文件全文。 */
  mainAfter: string;
  /** 追加到 archive 文件的内容段（不含 META·调用方合并）。 */
  archiveAppend: string;
  /** 主文件减少的字符数。 */
  freedChars: number;
  /** 锚点守恒是否成立。 */
  anchorsConserved: boolean;
}

/** 构造面包屑（替代被搬走的段）。 */
function breadcrumb(scene: string, segs: ArchiveSegment[], freed: number): string {
  const dates = segs.map((s) => s.date).join("/");
  return `\n[archived→${scene}-archive.md] ${dates} 等 ${segs.length} 个旧批次段（${freed} 字符）已归档（scene-archive 机制·锚点全局守恒·默认读视图不受影响）\n`;
}

/**
 * 生成 spill 计划（pure·调用方负责按「archive 先行 main 后行」写盘+去重）。
 * 锚点不守恒时返回空计划（mainAfter===raw）。
 */
export function planSceneSpill(
  scene: string,
  raw: string,
  cfg: SceneArchiveConfig,
  nowMs: number,
): SpillPlan {
  const segs = selectArchiveSegments(raw, cfg, nowMs, scene);
  if (segs.length === 0) {
    return { scene, segments: [], mainAfter: raw, archiveAppend: "", freedChars: 0, anchorsConserved: true };
  }
  const lines = raw.split("\n");
  // 从后往前删段·保行号有效
  const kept = [...lines];
  let freed = 0;
  for (let k = segs.length - 1; k >= 0; k--) {
    const s = segs[k]!;
    freed += lines.slice(s.startLine, s.endLine).join("\n").length + 1;
    kept.splice(s.startLine, s.endLine - s.startLine);
  }
  // 面包屑插在活动段标题后（活动段必在·select 已保证）
  let actIdx = kept.findIndex((l) => l.trim() === ACT_HEADING);
  const bc = breadcrumb(scene, segs, freed);
  if (actIdx >= 0) {
    kept.splice(actIdx + 1, 0, ...bc.split("\n").filter((l, i) => !(i === 0 && l === "")));
    actIdx = kept.findIndex((l) => l.trim() === ACT_HEADING);
  }
  const mainAfter = kept.join("\n");
  const archiveAppend = segs
    .map((s) => lines.slice(s.startLine, s.endLine).join("\n"))
    .join("\n\n") + "\n";

  // 锚点全局守恒断言
  const before = new Set(raw.match(ANCHOR_RE) ?? []);
  const main = new Set(mainAfter.match(ANCHOR_RE) ?? []);
  const arch = new Set(archiveAppend.match(ANCHOR_RE) ?? []);
  const union = new Set([...main, ...arch]);
  const conserved = [...before].every((x) => union.has(x));

  return {
    scene,
    segments: segs,
    mainAfter: conserved ? mainAfter : raw,
    archiveAppend: conserved ? archiveAppend : "",
    freedChars: conserved ? freed : 0,
    anchorsConserved: conserved,
  };
}
