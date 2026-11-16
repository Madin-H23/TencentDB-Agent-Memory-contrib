/**
 * 票 origin#31（R4·v2 事实段治理两段式）：事实段行级归档·pure 决策件。
 *
 * 形态实证（2026-11-14）：v2 场景文件体量会从活动段转移到事实段（活动段仅 181 字符
 * 时文件 272K）——⑧ sceneCompaction 只折活动段、C 案 sceneArchive 只搬活动段旧批次，
 * 事实段完全无治理；帽口径【checkSceneCharCapWithSupersede】已排除 superseded 行，
 * 86% 压力主体=活跃（非 superseded）事实行堆积。提帽（300K→400K）只是买时间。
 *
 * 两段式（2026-11-17 拍板·用户授权以使用感受为主）：
 * - 段二（主菜）：冷活跃行归档（行内时间戳 age > ageDays·60d 默认）——治帽正解
 *   （帽 86% 压力主体=活跃行堆积）；取舍=场景召回缩窄（L1 检索/记忆搜索完全
 *   无损·archive 文件可 read 按需召回），走 shadow 先量候选规模再议 on（on
 *   切换留用户）。
 * - 段一（顺带）：superseded 行归档——帽已排除它们（治帽无关）；LLM 读路径
 *   也已过滤（llm-runner/storage-tools 组合 filterSupersededLines·缺省剔除），
 *   收益=纯体量卫生（物理文件瘦身·审计面 includeInvalidated 视图更干净），
 *   零取舍随机制顺带。
 *
 * 硬设计（沿 C 案 scene-archive 先例）：
 * - 行级切片：只动 `## 事实` 段（精确 v2 头）内行；要点/META/活动段永不触碰
 * - 未来行（>now+2d）fail-closed 跳过；无时间戳行跳过（宁漏勿错·同 ⑥ 哲学）
 * - 锚点全局守恒：planFactSpill 内建断言（不守恒返回空计划·调用方不写盘）
 * - 幂等：候选行摘除后二跑零候选
 * - shadow=只打 metric 不写盘；on=archive 先行 main 后行（调用方执行·防崩溃重复）
 */

import { ANCHOR_RE } from "../../utils/supersede.js";
import { isSupersededLine } from "../../utils/supersede.js";
import { parseLineTime } from "./scene-supersede.js";
import { V2_FACTS_HEADING } from "./scene-format-v2.js";

const HEADING_RE = /^##[ \t]/;
const ACT_HEADING = "## 活动";
const DAY_MS = 86_400_000;

// ── 配置（拒绝式·同 parseSceneArchiveConfig 先例） ─────────────
export interface SceneFactArchiveConfig {
  enabled: boolean;
  /** shadow=只计量不写盘；on=摘行写盘（archive 先行 main 后行）。 */
  mode: "shadow" | "on";
  /** 冷行判龄：行内时间戳距今 > ageDays 天可归档。 */
  ageDays: number;
  /** 保护清单：这些场景永不归档。 */
  protectScenes: string[];
}

export const SCENE_FACT_ARCHIVE_DEFAULT_AGE_DAYS = 60;

export function parseSceneFactArchiveConfig(raw: unknown): SceneFactArchiveConfig | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;
  if (raw === true) {
    return {
      enabled: true,
      mode: "shadow",
      ageDays: SCENE_FACT_ARCHIVE_DEFAULT_AGE_DAYS,
      protectScenes: [],
    };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("persona.sceneFactArchive 必须为布尔或对象（{enabled, mode, ageDays, protectScenes}）");
  }
  const o = raw as Record<string, unknown>;
  const enabled = o.enabled ?? true;
  if (typeof enabled !== "boolean") throw new Error("persona.sceneFactArchive.enabled 须为布尔");
  if (enabled === false) return undefined;
  const modeRaw = o.mode ?? "shadow";
  if (modeRaw === "off") return undefined;
  if (modeRaw !== "shadow" && modeRaw !== "on") {
    throw new Error(`persona.sceneFactArchive.mode 非法: ${String(modeRaw)}（只允许 off|shadow|on）`);
  }
  const ageRaw = o.ageDays ?? SCENE_FACT_ARCHIVE_DEFAULT_AGE_DAYS;
  if (typeof ageRaw !== "number" || !Number.isFinite(ageRaw) || ageRaw <= 0) {
    throw new Error(`persona.sceneFactArchive.ageDays 须为正数: ${String(ageRaw)}`);
  }
  let protect: string[] = [];
  if (o.protectScenes !== undefined) {
    if (!Array.isArray(o.protectScenes) || o.protectScenes.some((x) => typeof x !== "string")) {
      throw new Error("persona.sceneFactArchive.protectScenes 须为字符串数组");
    }
    protect = o.protectScenes as string[];
  }
  return { enabled: true, mode: modeRaw, ageDays: ageRaw, protectScenes: protect };
}

// ── 行选择 ─────────────────────────────────────────────────

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export interface FactArchiveLine {
  /** 行号（0-based）。 */
  startLine: number;
  /** superseded=段一（读视图去污染）；cold=段二（治帽）。 */
  kind: "superseded" | "cold";
  /** cold 行的行内时间戳龄（天·向下取整）；superseded 行为 null（不判龄）。 */
  ageDays: number | null;
  chars: number;
  /** 行原文哈希（FNV-1a 8 位·append 去重依据）。 */
  hash: string;
  /** 行原文。 */
  text: string;
}

/**
 * 选出事实段内可归档行（superseded 段一 + 冷行段二）。
 * 约束：只动 `## 事实` 精确段内行（跨界 fail-closed）；未来行跳过；
 * 无时间戳行跳过；protectScenes 命中/非 v2 格式返空。
 */
export function selectFactArchiveLines(
  raw: string,
  cfg: SceneFactArchiveConfig,
  nowMs: number,
  sceneName?: string,
): FactArchiveLine[] {
  if (sceneName && cfg.protectScenes.includes(sceneName)) return [];
  const lines = raw.split("\n");

  // 事实段边界：精确 v2 头 → 下一异名 ## 头（事实段内无批次头）
  let factStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === V2_FACTS_HEADING) {
      factStart = i;
      break;
    }
  }
  if (factStart < 0) return []; // 非 v2·视图恒等前提不成立
  let factEnd = lines.length;
  for (let i = factStart + 1; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i]!)) {
      factEnd = i;
      break;
    }
  }

  const out: FactArchiveLine[] = [];
  for (let i = factStart + 1; i < factEnd; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (isSupersededLine(line)) {
      out.push({ startLine: i, kind: "superseded", ageDays: null, chars: line.length, hash: fnv1a(line.trimEnd()), text: line });
      continue;
    }
    const t = parseLineTime(line, nowMs);
    if (t === null) continue; // 无时间戳 → 龄不可判，跳过（宁漏勿错）
    if (t.ms > nowMs + 2 * DAY_MS) continue; // 未来行 fail-closed
    const ageMs = nowMs - t.ms;
    if (ageMs <= cfg.ageDays * DAY_MS) continue; // 严格大于（对齐 C 案）
    out.push({
      startLine: i,
      kind: "cold",
      ageDays: Math.floor(ageMs / DAY_MS),
      chars: line.length,
      hash: fnv1a(line.trimEnd()),
      text: line,
    });
  }
  return out;
}

// ── spill 计划 ─────────────────────────────────────────────

export interface FactSpillPlan {
  scene: string;
  lines: FactArchiveLine[];
  /** spill 后主文件全文（不守恒时逐字节等于原文）。 */
  mainAfter: string;
  /** 追加到 archive 文件的行块（原序·\n join）。 */
  archiveAppend: string;
  /** 主文件减少的字符数。 */
  freedChars: number;
  /** 锚点全局守恒是否成立。 */
  anchorsConserved: boolean;
  supersededCount: number;
  coldCount: number;
}

function factBreadcrumb(scene: string, n: number, freed: number): string {
  return `[archived→${scene}-archive.md] ${n} 条事实行（${freed} 字符）已归档（fact-archive 机制·锚点全局守恒·superseded/冷行）`;
}

/**
 * 生成事实段行级 spill 计划（pure·调用方负责「archive 先行 main 后行」写盘+去重）。
 * 面包屑插在活动段头后（默认读视图=要点+事实·面包屑不进读视图，同 C 案）。
 * 锚点不守恒时返回空计划（mainAfter===raw）。
 */
export function planFactSpill(
  scene: string,
  raw: string,
  cfg: SceneFactArchiveConfig,
  nowMs: number,
): FactSpillPlan {
  const cand = selectFactArchiveLines(raw, cfg, nowMs, scene);
  if (cand.length === 0) {
    return {
      scene,
      lines: [],
      mainAfter: raw,
      archiveAppend: "",
      freedChars: 0,
      anchorsConserved: true,
      supersededCount: 0,
      coldCount: 0,
    };
  }
  const lines = raw.split("\n");
  const kept = [...lines];
  let freed = 0;
  for (let k = cand.length - 1; k >= 0; k--) {
    const l = cand[k]!;
    // 审查 P3：末行候选无尾换行，不 +1（防 freedChars 口径虚高）
    const isLastLine = l.startLine === lines.length - 1;
    freed += l.text.length + (isLastLine ? 0 : 1);
    kept.splice(l.startLine, 1);
  }
  // 面包屑插活动段头后（防御：无活动段则不插）
  const actIdx = kept.findIndex((l) => l.trim() === ACT_HEADING);
  if (actIdx >= 0) {
    kept.splice(actIdx + 1, 0, factBreadcrumb(scene, cand.length, freed));
  }
  const mainAfter = kept.join("\n");
  const archiveAppend = cand.map((l) => l.text).join("\n") + "\n";

  // 锚点全局守恒断言（摘行原文全量迁入 archive ⇒ 天然守恒；断言兜底防未来改坏）
  const before = new Set(raw.match(ANCHOR_RE) ?? []);
  const main = new Set(mainAfter.match(ANCHOR_RE) ?? []);
  const arch = new Set(archiveAppend.match(ANCHOR_RE) ?? []);
  const union = new Set([...main, ...arch]);
  const conserved = [...before].every((x) => union.has(x));

  return {
    scene,
    lines: cand,
    mainAfter: conserved ? mainAfter : raw,
    archiveAppend: conserved ? archiveAppend : "",
    freedChars: conserved ? freed : 0,
    anchorsConserved: conserved,
    supersededCount: cand.filter((l) => l.kind === "superseded").length,
    coldCount: cand.filter((l) => l.kind === "cold").length,
  };
}
