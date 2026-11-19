/**
 * SPEC-E Stage 1：确定性场景合并内核（默认 off）。
 *
 * 本文件是 `MemoryCore/SPEC-E-scene-merge.md` 的唯一新模块。T01 先落
 * `persona.mergeScene` 的配置 schema 与解析；planMerge/executeMerge/recoverMergeJournal
 * 由后续票加入，避免把事务逻辑塞进 scene-extractor.ts。
 *
 * 设计约束（见 SPEC-E §4.9）：
 * - 缺省/ false = off；off 不改变现有 L2 行为。
 * - Stage 1 只允许 off | shadow；on 显式拒绝（fail-closed，不静默降级）。
 * - mode 非 off 且 sceneCharCap <= 0 时拒绝启动/合并：`checkSceneCharCap` 对
 *   cap<=0 返回放行，不能把「帽关掉」误当安全。
 * - 所有非法值 throw，不回落默认值（对齐 sceneCompaction/factSupersede 先例）。
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { normalizeSceneFilename } from "./filename-normalizer.js";
import {
  formatSceneBlock,
  isArchiveSceneFile,
  normalizeSceneSummary,
  parseSceneBlock,
  type SceneBlock,
  type SceneBlockMeta,
} from "./scene-format.js";
import { buildV2ReadView, extractV2Gist, syncV2MetaSummary, V2_HEADING_RE } from "./scene-format-v2.js";
import { checkSceneCharCap } from "../../utils/scene-char-cap.js";
import { checkSceneCharCapWithSupersede, extractAnchorIds } from "../../utils/supersede.js";
import { renameWithRetry } from "../../utils/checkpoint.js";
import { readSceneIndex, syncSceneIndex, type SceneIndexEntry } from "./scene-index.js";
import { generateSceneNavigation, stripSceneNavigation } from "./scene-navigation.js";

/** Stage 1 允许的合并模式；on 在 Stage 3 另行批准前不可用。 */
export type MergeSceneMode = "off" | "shadow" | "on";

/** `persona.mergeScene` 的已解析配置。 */
export interface MergeSceneConfig {
  mode: MergeSceneMode;
  /** A.content.length + B.content.length 的阶段 1/2 上限。 */
  pairCharLimit: number;
  /** C 的阶段 1/2 上限；实际生效值还会被 min(本值, floor(sceneCharCap*0.9)) 夹住。 */
  cCharLimit: number;
  /** merge.lock 的 TTL（毫秒）。 */
  lockTtlMs: number;
  /** 锁心跳间隔（毫秒），必须小于 lockTtlMs。 */
  heartbeatMs: number;
  /** 获取锁的最长等待（毫秒）；超时返回 lock_busy。 */
  lockWaitMs: number;
  /** journal 目录，相对 dataDir；不得为绝对路径或含 `..`。 */
  journalDir: string;
  /** 头部禁入场景（已规范化的文件名，含 .md）；显式名单，不自动解禁。 */
  headScenes: string[];
  /** Stage 3 每轮最多合并对数。 */
  maxPairsPerRound: number;
}

export const MERGE_SCENE_DEFAULT_PAIR_CHAR_LIMIT = 40_000;
export const MERGE_SCENE_DEFAULT_C_CHAR_LIMIT = 60_000;
export const MERGE_SCENE_DEFAULT_LOCK_TTL_MS = 300_000;
export const MERGE_SCENE_DEFAULT_HEARTBEAT_MS = 30_000;
export const MERGE_SCENE_DEFAULT_LOCK_WAIT_MS = 5_000;
export const MERGE_SCENE_DEFAULT_JOURNAL_DIR = ".metadata/merge-journal";
export const MERGE_SCENE_DEFAULT_MAX_PAIRS_PER_ROUND = 1;

/**
 * 头部四场景禁入名单（SPEC-E §4.9）。名字必须是 `normalizeSceneFilenames`
 * 规范化后的形态；比较前调用方也要对输入做 `normalizeSceneFilename`。
 */
export const MERGE_SCENE_DEFAULT_HEAD_SCENES: readonly string[] = [
  "技术研究-TDAI记忆系统治理与观测.md",
  "PR战役3.0-分片作战.md",
  "PR战役3.0-S3S4-代码与Agent分片.md",
  "技术研究-it-ops架构学习.md",
];

function fail(detail: string): never {
  throw new Error(`[config] persona.mergeScene ${detail}`);
}

function positiveInt(key: string, value: unknown, fallback: number): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    fail(`${key} 非法值 ${JSON.stringify(value)}（必须是正整数）`);
  }
  return n;
}

function nonNegativeInt(key: string, value: unknown, fallback: number): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    fail(`${key} 非法值 ${JSON.stringify(value)}（必须是非负整数）`);
  }
  return n;
}

function parseJournalDir(raw: unknown): string {
  if (raw === undefined) return MERGE_SCENE_DEFAULT_JOURNAL_DIR;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    fail(`journalDir 非法值 ${JSON.stringify(raw)}（必须是非空相对路径字符串）`);
  }
  const value = raw.trim();
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\")) {
    fail(`journalDir 非法值 ${JSON.stringify(raw)}（必须是相对 dataDir 的路径）`);
  }
  const parts = value.split(/[\\/]+/);
  if (parts.some((p) => p === ".." || p === "." || p.length === 0)) {
    fail(`journalDir 非法值 ${JSON.stringify(raw)}（不得包含 . / .. / 空段）`);
  }
  return parts.join("/");
}

function parseHeadScenes(raw: unknown): string[] {
  const value = raw === undefined ? MERGE_SCENE_DEFAULT_HEAD_SCENES : raw;
  if (!Array.isArray(value) || value.length === 0) {
    fail(`headScenes 非法值 ${JSON.stringify(raw)}（必须是非空字符串数组）`);
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      fail(`headScenes 含非法项 ${JSON.stringify(item)}（必须是非空字符串）`);
    }
    const name = item.trim();
    if (/[\\/]/.test(name) || name === "." || name === "..") {
      fail(`headScenes 含非法项 ${JSON.stringify(item)}（只能是文件名，不得含路径）`);
    }
    const normalized = normalizeSceneFilename(name);
    if (!normalized.endsWith(".md")) {
      fail(`headScenes 含非法项 ${JSON.stringify(item)}（规范化后不是 .md 文件名）`);
    }
    out.push(normalized);
  }
  return out;
}

/**
 * 解析 `persona.mergeScene`。
 *
 * - undefined / null / false → undefined（off；现有行为逐字节不变）
 * - true → shadow + 全默认值（与 sceneArchive/factArchive 的 true=shadow 先例一致）
 * - 对象 → 缺省字段回落默认值；非法 mode / 阈值 / 路径 / 名单 → throw
 * - 其它类型 → throw
 *
 * `sceneCharCap` 由调用方传入（config.ts 的 persona 段），用于 mode 非 off 时的
 * fail-closed 校验；off 时不校验 cap。
 */
export function parseMergeSceneConfig(
  raw: unknown,
  sceneCharCap: number,
): MergeSceneConfig | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;

  let obj: Record<string, unknown>;
  if (raw === true) {
    obj = { mode: "shadow" };
  } else if (typeof raw === "object" && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  } else {
    throw new Error(
      `[config] persona.mergeScene 非法类型 ${typeof raw}（合法：缺省/false=off、true=shadow、{mode,...}）`,
    );
  }

  const modeRaw = obj.mode === undefined ? "off" : obj.mode;
  if (modeRaw !== "off" && modeRaw !== "shadow" && modeRaw !== "on") {
    fail(
      `mode 非法值 ${JSON.stringify(obj.mode)}（合法：off|shadow|on；Stage 1 只允许 off|shadow）`,
    );
  }
  if (modeRaw === "on") {
    fail("mode=on 在 Stage 1 不允许（Stage 1 只允许 off|shadow；on 需 Stage 3 另行批准）");
  }
  const mode = modeRaw as MergeSceneMode;

  const pairCharLimit = positiveInt(
    "pairCharLimit",
    obj.pairCharLimit,
    MERGE_SCENE_DEFAULT_PAIR_CHAR_LIMIT,
  );
  const cCharLimit = positiveInt("cCharLimit", obj.cCharLimit, MERGE_SCENE_DEFAULT_C_CHAR_LIMIT);
  if (cCharLimit <= pairCharLimit) {
    fail(`非法组合 cCharLimit=${cCharLimit} <= pairCharLimit=${pairCharLimit}（C 上限必须大于 A+B 上限）`);
  }
  if (pairCharLimit > MERGE_SCENE_DEFAULT_C_CHAR_LIMIT) {
    fail(
      `pairCharLimit 非法值 ${pairCharLimit}（Stage 1/2/3 均不得超过 ${MERGE_SCENE_DEFAULT_C_CHAR_LIMIT}）`,
    );
  }
  if (cCharLimit > MERGE_SCENE_DEFAULT_C_CHAR_LIMIT) {
    fail(`cCharLimit 非法值 ${cCharLimit}（任何阶段均不得超过 ${MERGE_SCENE_DEFAULT_C_CHAR_LIMIT}）`);
  }

  const lockTtlMs = positiveInt("lockTtlMs", obj.lockTtlMs, MERGE_SCENE_DEFAULT_LOCK_TTL_MS);
  const heartbeatMs = positiveInt(
    "heartbeatMs",
    obj.heartbeatMs,
    MERGE_SCENE_DEFAULT_HEARTBEAT_MS,
  );
  if (heartbeatMs >= lockTtlMs) {
    fail(`非法组合 heartbeatMs=${heartbeatMs} >= lockTtlMs=${lockTtlMs}（心跳必须小于 TTL）`);
  }
  const lockWaitMs = nonNegativeInt(
    "lockWaitMs",
    obj.lockWaitMs,
    MERGE_SCENE_DEFAULT_LOCK_WAIT_MS,
  );
  const maxPairsPerRound = positiveInt(
    "maxPairsPerRound",
    obj.maxPairsPerRound,
    MERGE_SCENE_DEFAULT_MAX_PAIRS_PER_ROUND,
  );
  const journalDir = parseJournalDir(obj.journalDir);
  const headScenes = parseHeadScenes(obj.headScenes);

  if (
    mode !== "off" &&
    (typeof sceneCharCap !== "number" || !Number.isFinite(sceneCharCap) || sceneCharCap <= 0)
  ) {
    fail(
      `mode=${mode} 但 sceneCharCap 非法/未开启（${JSON.stringify(sceneCharCap)}）；帽关闭时不允许合并且 fail-closed`,
    );
  }

  return {
    mode,
    pairCharLimit,
    cCharLimit,
    lockTtlMs,
    heartbeatMs,
    lockWaitMs,
    journalDir,
    headScenes,
    maxPairsPerRound,
  };
}


// ---------------------------------------------------------------------------
// T02：纯规划器 planMerge（零 IO / 零时钟 / 零随机）
//
// 输入两个活动场景的原文 + 目标名 + 注入时间，输出 C 原文与度量，或结构化拒绝。
// 守恒口径（SPEC-E §4.4）：锚点只算 parseSceneBlock().content（不含 META.summary），
// 正文非空行剔除全部 v2 标题行后做精确多重集相加；重复锚点/重复正文行全部保留。
// ---------------------------------------------------------------------------

/** C 默认读视图上限（read-budget 口径，SPEC-E §5）。 */
export const MERGE_SCENE_READ_VIEW_CHAR_LIMIT = 40_000;

/** planMerge 的结构化拒绝码。 */
export type MergeSceneRejectCode =
  | "invalid_input"
  | "invalid_options"
  | "unsupported_layout"
  | "archive_input"
  | "deleted_input"
  | "empty_input"
  | "head_scene"
  | "target_invalid"
  | "target_exists"
  | "target_conflict"
  | "over_domain"
  | "over_c_char_limit"
  | "over_scene_char_cap"
  | "over_read_view"
  | "anchor_mismatch"
  | "body_mismatch"
  | "summary_mismatch";

export interface MergeSceneRejection {
  code: MergeSceneRejectCode;
  message: string;
  details?: Record<string, unknown>;
}

/** 合并输入：活动场景文件名（相对 scene_blocks）+ 原始全文。 */
export interface MergeSceneInput {
  filename: string;
  raw: string;
}

/** planMerge 的调用参数；时间必须注入，规划器不读时钟。 */
export interface PlanMergeOptions {
  config: MergeSceneConfig;
  /** 注入的当前时间（ISO 8601）；C 的 META.updated 使用其规范形式。 */
  now: string;
  /** C 的目标文件名；Stage 1/2 由调用方指定。 */
  target: string;
  /** 当前 persona.sceneCharCap；C 的裸长度与失效行口径都要过帽。 */
  sceneCharCap: number;
  /** 当前 scene_blocks 下全部 .md 文件名（含归档）；用于 target 冲突预检。 */
  existingSceneNames?: readonly string[];
}

export interface MergeScenePlanInput {
  filename: string;
  sha256: string;
  chars: number;
  anchors: number;
  meta: SceneBlockMeta;
}

export interface MergeScenePlanMetrics {
  charsA: number;
  charsB: number;
  pairChars: number;
  charsC: number;
  capLimit: number;
  capRatio: number;
  readViewChars: number;
  anchorsIn: number;
  anchorsOut: number;
  anchorLost: number;
  bodyLinesIn: number;
  bodyLinesOut: number;
  bodyLinesLost: number;
  duplicateAnchorIds: number;
}

export interface MergeScenePlan {
  key: string;
  target: string;
  concatOrder: string;
  now: string;
  a: MergeScenePlanInput;
  b: MergeScenePlanInput;
  c: {
    filename: string;
    raw: string;
    chars: number;
    readViewChars: number;
    meta: SceneBlockMeta;
  };
  metrics: MergeScenePlanMetrics;
}

export type PlanMergeResult =
  | { ok: true; plan: MergeScenePlan }
  | { ok: false; rejection: MergeSceneRejection };

type MergeV2Section = "gist" | "facts" | "archive";

const MERGE_V2_ORDER: readonly MergeV2Section[] = ["gist", "facts", "archive"];

const MERGE_V2_HEADING: Record<MergeV2Section, string> = {
  gist: "## 要点",
  facts: "## 事实",
  archive: "## 活动",
};

const MERGE_V2_BY_HEADING: Record<string, MergeV2Section> = {
  要点: "gist",
  事实: "facts",
  活动: "archive",
};

interface MergeV2Layout {
  preamble: string[];
  sections: Record<MergeV2Section, string[]>;
}

interface ParsedMergeInput {
  filename: string;
  raw: string;
  block: SceneBlock;
  content: string;
  layout: MergeV2Layout;
}

function reject(
  code: MergeSceneRejectCode,
  message: string,
  details?: Record<string, unknown>,
): { ok: false; rejection: MergeSceneRejection } {
  return { ok: false, rejection: { code, message, details } };
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hasPathSeparator(name: string): boolean {
  return /[\\/]/.test(name);
}

function lowerName(name: string): string {
  return name.toLowerCase();
}

function isWindowsReservedStem(stem: string): boolean {
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem);
}

function isValidIsoTime(value: string): boolean {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

/** 输入文件名的基础合法性：单段 .md，禁路径；规范化校验留给 target。 */
function validateInputFilename(name: unknown): string | null {
  if (typeof name !== "string" || name.trim().length === 0) return "文件名必须是非空字符串";
  if (hasPathSeparator(name)) return "文件名只能是单段，不得含路径分隔符";
  if (name === "." || name === "..") return "文件名不得是 . 或 ..";
  if (!name.toLowerCase().endsWith(".md")) return "文件名必须以 .md 结尾";
  if (name !== name.trim()) return "文件名不得有首尾空白";
  return null;
}

/**
 * 目标名校验：必须与 normalizeSceneFilename 同源（规范化后逐字相等），
 * 且不是归档名、不是 Windows 保留名、不是 A/B、不在现有文件里。
 */
function validateTargetName(
  target: unknown,
  inputNames: readonly string[],
  config: MergeSceneConfig,
  existingSceneNames: readonly string[] | undefined,
): { ok: true; target: string } | { ok: false; rejection: MergeSceneRejection } {
  if (typeof target !== "string" || target.trim().length === 0) {
    return reject("target_invalid", "target 必须是非空字符串");
  }
  if (hasPathSeparator(target)) {
    return reject("target_invalid", "target 只能是单段文件名，不得含路径分隔符", { target });
  }
  if (target !== target.trim()) {
    return reject("target_invalid", "target 不得有首尾空白", { target });
  }
  const normalized = normalizeSceneFilename(target);
  if (normalized !== target) {
    return reject("target_invalid", "target 必须已是规范化文件名（normalizeSceneFilename 同源）", {
      target,
      normalized,
    });
  }
  if (!target.toLowerCase().endsWith(".md")) {
    return reject("target_invalid", "target 必须以 .md 结尾", { target });
  }
  if (/-archive\.md$/i.test(target)) {
    return reject("target_invalid", "target 不得以 -archive.md 结尾（归档文件不可作为 C）", { target });
  }
  const stem = target.slice(0, -3);
  if (isWindowsReservedStem(stem)) {
    return reject("target_invalid", "target 不得使用 Windows 保留名", { target });
  }
  const targetLower = lowerName(target);
  for (const name of inputNames) {
    if (lowerName(name) === targetLower) {
      return reject("target_conflict", "target 不得与任一输入同名", { target, input: name });
    }
  }
  const headSet = new Set(config.headScenes.map((n) => lowerName(normalizeSceneFilename(n))));
  if (headSet.has(targetLower)) {
    return reject("target_invalid", "target 命中头部场景禁用名单", { target });
  }
  if (existingSceneNames) {
    for (const name of existingSceneNames) {
      if (lowerName(normalizeSceneFilename(name)) === targetLower) {
        return reject("target_exists", "target 已存在于 scene_blocks（活动或归档）", { target, existing: name });
      }
    }
  }
  return { ok: true, target };
}

/** 逐行扫描 v2 三段：重复的当前段标题归一化跳过；非当前段重入/乱序拒绝。 */
function parseV2Layout(
  content: string,
): { ok: true; layout: MergeV2Layout } | { ok: false; reason: string } {
  const lines = content.split("\n");
  const layout: MergeV2Layout = {
    preamble: [],
    sections: { gist: [], facts: [], archive: [] },
  };
  let current: MergeV2Section | null = null;
  const seen = new Set<MergeV2Section>();

  for (const line of lines) {
    const match = line.match(V2_HEADING_RE);
    if (!match) {
      if (current === null) layout.preamble.push(line);
      else layout.sections[current].push(line);
      continue;
    }
    const key = MERGE_V2_BY_HEADING[match[1] ?? ""];
    if (!key) return { ok: false, reason: "无法识别的 v2 段标题" };
    if (key === current) continue; // 同段连续重入：并入，不重复产出标题
    if (seen.has(key)) {
      return { ok: false, reason: "非当前 v2 段重入（已闭合的段再次出现）" };
    }
    if (current === null) {
      if (key !== "gist") return { ok: false, reason: "首个 v2 段必须是 ## 要点" };
    } else {
      const expected: MergeV2Section | undefined = MERGE_V2_ORDER[MERGE_V2_ORDER.indexOf(current) + 1];
      if (key !== expected) {
        return { ok: false, reason: "v2 段首次出现顺序必须为 要点→事实→活动" };
      }
    }
    current = key;
    seen.add(key);
  }

  if (seen.size !== MERGE_V2_ORDER.length) {
    const missing = MERGE_V2_ORDER.filter((key) => !seen.has(key)).map((key) => MERGE_V2_HEADING[key]);
    return { ok: false, reason: "缺少 v2 段：" + missing.join("、") };
  }
  return { ok: true, layout };
}

function parseMergeInput(
  input: MergeSceneInput,
): { ok: true; parsed: ParsedMergeInput } | { ok: false; rejection: MergeSceneRejection } {
  const nameError = validateInputFilename(input?.filename);
  if (nameError) return reject("invalid_input", nameError, { filename: input?.filename });
  if (typeof input.raw !== "string" || input.raw.length === 0) {
    return reject("invalid_input", "输入原文必须是非空字符串", { filename: input.filename });
  }
  const filename = input.filename;
  if (isArchiveSceneFile(filename, input.raw)) {
    return reject("archive_input", "归档场景不可作为合并输入", { filename });
  }
  const block = parseSceneBlock(input.raw, filename);
  const content = block.content;
  if (content.trim().length === 0) {
    return reject("empty_input", "输入场景正文为空", { filename });
  }
  if (content.trim() === "[DELETED]") {
    return reject("deleted_input", "输入场景已被软删除", { filename });
  }
  const layoutResult = parseV2Layout(content);
  if (!layoutResult.ok) {
    return reject("unsupported_layout", "输入不是受支持的 v2 布局：" + layoutResult.reason, {
      filename,
      reason: layoutResult.reason,
    });
  }
  return {
    ok: true,
    parsed: { filename, raw: input.raw, block, content, layout: layoutResult.layout },
  };
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  return lines.slice(start, end);
}

/** 按 要点→事实→活动 全文拼接；段内 A 在前 B 在后，仅丢弃重复的 v2 标题行。 */
function buildMergedBody(a: ParsedMergeInput, b: ParsedMergeInput): string {
  const parts: string[] = [];
  const preamble = trimBlankEdges(a.layout.preamble);
  if (preamble.length > 0) {
    parts.push(...preamble, "");
  }
  for (const key of MERGE_V2_ORDER) {
    parts.push(MERGE_V2_HEADING[key]);
    parts.push(...a.layout.sections[key], ...b.layout.sections[key]);
    if (key !== "archive") parts.push("");
  }
  return parts.join("\n");
}

function countsFrom(values: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const value of values) out.set(value, (out.get(value) ?? 0) + 1);
  return out;
}

function addCounts(...maps: readonly Map<string, number>[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const map of maps) {
    for (const [key, value] of map) out.set(key, (out.get(key) ?? 0) + value);
  }
  return out;
}

function diffCounts(
  expected: Map<string, number>,
  actual: Map<string, number>,
): { lost: string[]; extra: string[] } {
  const lost: string[] = [];
  const extra: string[] = [];
  const keys = new Set<string>([...expected.keys(), ...actual.keys()]);
  for (const key of keys) {
    const want = expected.get(key) ?? 0;
    const got = actual.get(key) ?? 0;
    if (got < want) lost.push(key + " (x" + (want - got) + ")");
    else if (got > want) extra.push(key + " (x" + (got - want) + ")");
  }
  return { lost, extra };
}

/** 正文非空行多重集：剔除 META（parseSceneBlock 已剥离）与全部 v2 标题行。 */
function bodyLineCounts(raw: string, filename: string): Map<string, number> {
  const content = parseSceneBlock(raw, filename).content;
  const lines: string[] = [];
  for (const line of content.split("\n")) {
    if (V2_HEADING_RE.test(line)) continue;
    if (line.trim().length === 0) continue;
    lines.push(line);
  }
  return countsFrom(lines);
}

/**
 * 合并守恒的单一实现：锚点多重集与正文非空行多重集都必须精确相等。
 *
 * planMerge 用它给出结构化拒绝，executeMerge 用同一实现从 preimage 复算一遍（防御 plan 被篡改），
 * 两个调用点共用可避免口径漂移。
 */
function checkConservation(
  cRaw: string,
  target: string,
  aRaw: string,
  aName: string,
  bRaw: string,
  bName: string,
): { kind: "anchor" | "body"; lost: string[]; extra: string[] } | null {
  const expectedAnchors = addCounts(
    countsFrom(extractAnchorIds(parseSceneBlock(aRaw, aName).content)),
    countsFrom(extractAnchorIds(parseSceneBlock(bRaw, bName).content)),
  );
  const anchorDiff = diffCounts(
    expectedAnchors,
    countsFrom(extractAnchorIds(parseSceneBlock(cRaw, target).content)),
  );
  if (anchorDiff.lost.length > 0 || anchorDiff.extra.length > 0) {
    return { kind: "anchor", ...anchorDiff };
  }
  const bodyDiff = diffCounts(
    addCounts(bodyLineCounts(aRaw, aName), bodyLineCounts(bRaw, bName)),
    bodyLineCounts(cRaw, target),
  );
  if (bodyDiff.lost.length > 0 || bodyDiff.extra.length > 0) {
    return { kind: "body", ...bodyDiff };
  }
  return null;
}

function minCreated(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function compareParsedInputs(a: ParsedMergeInput, b: ParsedMergeInput): number {
  if (a.block.meta.created !== b.block.meta.created) {
    return a.block.meta.created < b.block.meta.created ? -1 : 1;
  }
  if (a.filename === b.filename) return 0;
  return a.filename < b.filename ? -1 : 1;
}

function planInputToSummary(input: ParsedMergeInput): MergeScenePlanInput {
  return {
    filename: input.filename,
    sha256: sha256Text(input.raw),
    chars: input.content.length,
    anchors: extractAnchorIds(input.content).length,
    meta: { ...input.block.meta },
  };
}

/**
 * 幂等键：sortedNames + 两个输入 raw 的 sha256 + 规范拼接序。不含 target。
 * 换序调用必须得到同一 key（输入会先按 created/filename 规范化）。
 */
export function deriveMergeKey(
  a: { filename: string; raw: string },
  b: { filename: string; raw: string },
  concatOrder: string,
): string {
  const ordered = a.filename <= b.filename ? [a, b] : [b, a];
  const sortedNames = [a.filename, b.filename].sort().join("|");
  return sha256Text(
    "merge-v1|" +
      sortedNames +
      "|" +
      sha256Text(ordered[0]!.raw) +
      "|" +
      sha256Text(ordered[1]!.raw) +
      "|" +
      concatOrder,
  );
}
/**
 * Stage 3 自动命名的确定性占位：由两个输入文件名派生可读 target 名。
 *
 * 只做规范化与稳定排序；是否可用仍由 `planMerge` 的 target 校验/同名检查决定。
 * 换序调用得到同一名字（与 `deriveMergeKey` 的稳定性一致）。
 */
export function deriveMergeTargetName(aFilename: string, bFilename: string): string {
  const stems = [aFilename, bFilename]
    .map((name) => normalizeSceneFilename(name).replace(/[.]md$/i, ""))
    .filter((stem) => stem.length > 0)
    .sort();
  return normalizeSceneFilename(stems.join("-") + "-合并.md");
}

/**
 * 纯规划器：两个活动场景 → C 原文/度量，或结构化拒绝。零 fs、零时钟、零随机。
 * now 必须是调用方注入的合法 ISO 时间；规划器只做确定性变换。
 */
export function planMerge(
  inputA: MergeSceneInput,
  inputB: MergeSceneInput,
  opts: PlanMergeOptions,
): PlanMergeResult {
  const config = opts?.config;
  if (
    !config ||
    !Array.isArray(config.headScenes) ||
    typeof config.pairCharLimit !== "number" ||
    typeof config.cCharLimit !== "number"
  ) {
    return reject("invalid_options", "config 缺失或字段类型非法");
  }
  if (!isValidIsoTime(opts.now)) {
    return reject("invalid_options", "now 必须是合法的 ISO 8601 时间字符串", { now: opts.now });
  }
  if (
    typeof opts.sceneCharCap !== "number" ||
    !Number.isFinite(opts.sceneCharCap) ||
    opts.sceneCharCap <= 0
  ) {
    return reject("invalid_options", "sceneCharCap 必须是正数（帽关闭时不允许合并）", {
      sceneCharCap: opts.sceneCharCap,
    });
  }
  if (
    typeof config.pairCharLimit !== "number" ||
    !Number.isFinite(config.pairCharLimit) ||
    config.pairCharLimit <= 0 ||
    typeof config.cCharLimit !== "number" ||
    !Number.isFinite(config.cCharLimit) ||
    config.cCharLimit <= 0
  ) {
    return reject("invalid_options", "pairCharLimit/cCharLimit 必须是正数");
  }

  const parsedA = parseMergeInput(inputA);
  if (!parsedA.ok) return parsedA;
  const parsedB = parseMergeInput(inputB);
  if (!parsedB.ok) return parsedB;

  if (lowerName(parsedA.parsed.filename) === lowerName(parsedB.parsed.filename)) {
    return reject("invalid_input", "两个输入不能是同一个场景文件", {
      filename: parsedA.parsed.filename,
    });
  }

  const [a, b] =
    compareParsedInputs(parsedA.parsed, parsedB.parsed) <= 0
      ? [parsedA.parsed, parsedB.parsed]
      : [parsedB.parsed, parsedA.parsed];

  if (trimBlankEdges(b.layout.preamble).length > 0) {
    return reject("unsupported_layout", "B 的 v2 首个标题前存在非空序言（合并会丢失该内容）", {
      filename: b.filename,
    });
  }

  const headSet = new Set(config.headScenes.map((name) => lowerName(normalizeSceneFilename(name))));
  for (const input of [a, b]) {
    if (headSet.has(lowerName(input.filename))) {
      return reject("head_scene", "头部场景在 Stage 1/2 禁止合并", { filename: input.filename });
    }
  }

  const targetResult = validateTargetName(
    opts.target,
    [a.filename, b.filename],
    config,
    opts.existingSceneNames,
  );
  if (!targetResult.ok) return targetResult;
  const target = targetResult.target;

  const pairChars = a.content.length + b.content.length;
  if (pairChars > config.pairCharLimit) {
    return reject("over_domain", "A+B 超出阶段 1/2 域上限", {
      pairChars,
      pairCharLimit: config.pairCharLimit,
    });
  }

  const meta: SceneBlockMeta = {
    created: minCreated(a.block.meta.created, b.block.meta.created),
    updated: new Date(opts.now).toISOString(),
    summary: "",
    heat: Math.max(a.block.meta.heat, b.block.meta.heat),
  };
  const cRaw = syncV2MetaSummary(formatSceneBlock(meta, buildMergedBody(a, b)));
  const cBlock = parseSceneBlock(cRaw, target);

  const derivedSummary = normalizeSceneSummary(extractV2Gist(cRaw) ?? "");
  if (cBlock.meta.summary !== derivedSummary) {
    return reject("summary_mismatch", "C 的 META.summary 与要点段派生值不一致", {
      summary: cBlock.meta.summary,
      derivedSummary,
    });
  }

  const conservation = checkConservation(cRaw, target, a.raw, a.filename, b.raw, b.filename);
  if (conservation && conservation.kind === "anchor") {
    return reject("anchor_mismatch", "锚点多重集不守恒", {
      lost: conservation.lost.slice(0, 10),
      extra: conservation.extra.slice(0, 10),
      lostCount: conservation.lost.length,
      extraCount: conservation.extra.length,
    });
  }
  if (conservation && conservation.kind === "body") {
    return reject("body_mismatch", "正文非空行多重集不守恒", {
      lost: conservation.lost.slice(0, 10),
      extra: conservation.extra.slice(0, 10),
      lostCount: conservation.lost.length,
      extraCount: conservation.extra.length,
    });
  }

  const capLimit = Math.min(config.cCharLimit, Math.floor(opts.sceneCharCap * 0.9));
  if (cRaw.length > capLimit) {
    return reject("over_c_char_limit", "C 超出合并域字符上限", {
      chars: cRaw.length,
      capLimit,
      cCharLimit: config.cCharLimit,
      sceneCharCap: opts.sceneCharCap,
    });
  }
  const rawCap = checkSceneCharCap(cRaw, opts.sceneCharCap);
  if (rawCap) {
    return reject("over_scene_char_cap", "C 的裸长度超出 sceneCharCap", { ...rawCap });
  }
  const liveCap = checkSceneCharCapWithSupersede(cRaw, opts.sceneCharCap);
  if (liveCap) {
    return reject("over_scene_char_cap", "C 的失效行口径超出 sceneCharCap", { ...liveCap });
  }

  const readViewChars = buildV2ReadView(cRaw).length;
  if (readViewChars > MERGE_SCENE_READ_VIEW_CHAR_LIMIT) {
    return reject("over_read_view", "C 的默认读视图超出 40,000 字符", {
      readViewChars,
      limit: MERGE_SCENE_READ_VIEW_CHAR_LIMIT,
    });
  }

  const concatOrder = a.filename + ">" + b.filename;
  const key = deriveMergeKey(a, b, concatOrder);
  // metrics 独立复算（守恒已在上面通过；这里只喂观测字段，不再参与判定）。
  const anchorsIn = extractAnchorIds(a.content).length + extractAnchorIds(b.content).length;
  const anchorsOut = extractAnchorIds(cBlock.content).length;
  const duplicateAnchorIds = [...addCounts(
    countsFrom(extractAnchorIds(a.content)),
    countsFrom(extractAnchorIds(b.content)),
  ).values()].filter((count) => count > 1).length;
  const expectedBody = addCounts(bodyLineCounts(a.raw, a.filename), bodyLineCounts(b.raw, b.filename));
  const actualBody = bodyLineCounts(cRaw, target);
  const bodyLinesIn = [...expectedBody.values()].reduce((sum, value) => sum + value, 0);

  return {
    ok: true,
    plan: {
      key,
      target,
      concatOrder,
      now: new Date(opts.now).toISOString(),
      a: planInputToSummary(a),
      b: planInputToSummary(b),
      c: {
        filename: target,
        raw: cRaw,
        chars: cRaw.length,
        readViewChars,
        meta: { ...cBlock.meta },
      },
      metrics: {
        charsA: a.content.length,
        charsB: b.content.length,
        pairChars,
        charsC: cRaw.length,
        capLimit,
        capRatio: cRaw.length / capLimit,
        readViewChars,
        anchorsIn,
        anchorsOut,
        anchorLost: 0,
        bodyLinesIn,
        bodyLinesOut: [...actualBody.values()].reduce((sum, value) => sum + value, 0),
        bodyLinesLost: 0,
        duplicateAnchorIds,
      },
    },
  };
}
// ---------------------------------------------------------------------------
// T03：事务执行器 executeMerge（本地 fs、journal、preimage、跨进程锁、崩溃可见）
//
// SPEC-E §4.6–§4.8。Stage 1/2 固定本地 fs：`StorageAdapter.rename` 与
// `LocalStorageBackend.putObject` 都不具备原子/fsync 语义，storage/COS/rowfs
// 模式在 preflight 直接拒绝（MERGE_UNSUPPORTED_ATOMICITY），不得以 journal-only
// 冒充可收敛。生产 dataDir 由路径守卫硬拒绝，只有隔离的临时 dataDir 可执行。
// ---------------------------------------------------------------------------

export type MergeSceneBackend = "local" | "storage" | "cos" | "rowfs";

export type MergeSceneExecuteErrorCode =
  | "MERGE_UNSUPPORTED_ATOMICITY"
  | "MERGE_PRODUCTION_DATADIR"
  | "MERGE_MODE_OFF"
  | "MERGE_CONFLICT"
  | "MERGE_TARGET_EXISTS"
  | "MERGE_LOCK_BUSY"
  | "MERGE_JOURNAL_CORRUPT"
  | "MERGE_IO_ERROR";

export interface MergeSceneExecuteError {
  code: MergeSceneExecuteErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface ExecuteMergeOptions {
  plan: MergeScenePlan;
  config: MergeSceneConfig;
  sceneCharCap: number;
  dataDir: string;
  /** 缺省 local；storage/COS/rowfs 一律在 preflight 拒绝。 */
  backend?: MergeSceneBackend;
  /** 仅供测试注入；缺省 node:fs/promises（真实本地 fs）。 */
  fsMod?: typeof fs;
}

export type MergeJournalStage =
  | "prepared"
  | "c_persisted"
  | "a_deleted"
  | "b_deleted"
  | "done"
  | "failed"
  | "rolled_back";

export interface MergeJournalAttempt {
  at: string;
  pid: number;
  host: string;
  result: string;
}

export interface MergeJournal {
  version: 1;
  key: string;
  inputs: { a: MergeScenePlanInput; b: MergeScenePlanInput };
  concatOrder: string;
  target: { filename: string; sha256: string; chars: number };
  stage: MergeJournalStage;
  attempts: MergeJournalAttempt[];
  pid: number;
  host: string;
  startedAt: string;
  updatedAt: string;
  metrics: MergeScenePlanMetrics;
  error?: string;
  recovery?: { at: string; action: string; note: string };
}

export interface MergeJournalPaths {
  root: string;
  file: string;
  preimageDir: string;
  tmpDir: string;
  part: string;
}

export interface MergeSceneExecuted {
  ok: true;
  /** merged=本事务写入；skipped=幂等命中已有 journal，零写。 */
  status: "merged" | "skipped";
  /** skipped 时可能来自别的 target，故以 journal 记录为准。 */
  journalStage?: MergeJournalStage;
  /** 幂等/不重试原因等人类可读说明。 */
  message?: string;
  key: string;
  target: string;
  journalPath: string;
  preimageDir: string;
  index: SceneIndexEntry[];
  navigation: string;
}

export type ExecuteMergeResult =
  | MergeSceneExecuted
  | { ok: false; error: MergeSceneExecuteError };

class MergeExecutionError extends Error {
  readonly code: MergeSceneExecuteErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: MergeSceneExecuteErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MergeExecutionError";
    this.code = code;
    this.details = details;
  }
}

function executionError(err: unknown): MergeSceneExecuteError {
  if (err instanceof MergeExecutionError) {
    return { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: "MERGE_IO_ERROR", message };
}

function isErrnoCode(err: unknown, code: string): boolean {
  return !!err && typeof err === "object" && (err as NodeJS.ErrnoException).code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 生产数据目录硬拒绝：Stage 1/2 只允许隔离临时 dataDir。 */
function assertNotProductionDataDir(dataDir: string): void {
  const normalized = path.resolve(dataDir).replace(/\\/g, "/").toLowerCase();
  if (
    normalized.includes("/.memory-tencentdb") ||
    normalized.endsWith("/.memory-tencentdb") ||
    normalized.includes("/memory-tencentdb") ||
    normalized.includes("/memory-tdai/")
  ) {
    throw new MergeExecutionError(
      "MERGE_PRODUCTION_DATADIR",
      "拒绝在生产数据目录执行合并事务（Stage 1/2 只允许隔离临时 dataDir）",
      { dataDir },
    );
  }
}

function ensurePlainFilename(name: unknown, label: string): string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new MergeExecutionError("MERGE_CONFLICT", label + " 必须是非空文件名");
  }
  if (name !== name.trim() || hasPathSeparator(name) || name === "." || name === "..") {
    throw new MergeExecutionError("MERGE_CONFLICT", label + " 只能是单段文件名", { name });
  }
  if (!name.toLowerCase().endsWith(".md")) {
    throw new MergeExecutionError("MERGE_CONFLICT", label + " 必须以 .md 结尾", { name });
  }
  return name;
}

function assertPlanShape(plan: MergeScenePlan): void {
  if (!plan || typeof plan !== "object") {
    throw new MergeExecutionError("MERGE_CONFLICT", "plan 缺失");
  }
  if (!/^[0-9a-f]{64}$/.test(plan.key)) {
    throw new MergeExecutionError("MERGE_CONFLICT", "plan.key 不是 sha256 十六进制", { key: plan.key });
  }
  ensurePlainFilename(plan.a?.filename, "plan.a.filename");
  ensurePlainFilename(plan.b?.filename, "plan.b.filename");
  ensurePlainFilename(plan.target, "plan.target");
  if (plan.a.filename.toLowerCase() === plan.b.filename.toLowerCase()) {
    throw new MergeExecutionError("MERGE_CONFLICT", "plan 的两个输入同名");
  }
  if (typeof plan.c?.raw !== "string" || plan.c.raw.length === 0) {
    throw new MergeExecutionError("MERGE_CONFLICT", "plan.c.raw 缺失");
  }
}

/** journal/preimage/.part 路径；config.journalDir 为相对 dataDir 的已解析路径。 */
export function mergeJournalPaths(
  dataDir: string,
  config: Pick<MergeSceneConfig, "journalDir">,
  key: string,
): MergeJournalPaths {
  if (!/^[0-9a-f]{64}$/.test(key)) {
    throw new MergeExecutionError("MERGE_CONFLICT", "journal key 不是 sha256 十六进制", { key });
  }
  const root = path.join(dataDir, ...config.journalDir.split("/"));
  return {
    root,
    file: path.join(root, key + ".json"),
    preimageDir: path.join(root, key),
    tmpDir: path.join(dataDir, ".metadata", "merge-tmp"),
    part: path.join(dataDir, ".metadata", "merge-tmp", key + ".md.part"),
  };
}

async function readTextOrNull(fsMod: typeof fs, file: string): Promise<string | null> {
  try {
    return await fsMod.readFile(file, "utf8");
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return null;
    throw err;
  }
}

async function writeFileDurable(fsMod: typeof fs, file: string, content: string): Promise<void> {
  await fsMod.mkdir(path.dirname(file), { recursive: true });
  const handle = await fsMod.open(file, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const ATOMIC_REPLACE_TMP_SUFFIX = ".merge-tmp";

/**
 * 原子替换已存在文件：同目录临时文件写完 fsync，再 rename 覆盖目标。
 *
 * 不能直接用 open(file, "w")：它会先截断目标，进程在 write 之前被 kill 会留下空文件；
 * 恢复侧把「非 preimage 非 [DELETED]」判定为外部并发写而拒绝覆盖，事务永久卡死（T07 k04/k06）。
 * 临时文件后缀不以 .md 结尾，不会进入 scene_index / Phase5 清理范围。
 */
async function writeFileAtomicDurable(fsMod: typeof fs, file: string, content: string): Promise<void> {
  const tmp = file + ATOMIC_REPLACE_TMP_SUFFIX;
  await writeFileDurable(fsMod, tmp, content);
  await renameWithRetry(fsMod, tmp, file);
}

/** 清理崩溃残留的原子替换临时文件；应在持有 merge 锁时调用。 */
async function removeAtomicReplaceTemps(fsMod: typeof fs, dir: string): Promise<void> {
  let names: string[];
  try {
    names = await fsMod.readdir(dir);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return;
    throw err;
  }
  for (const name of names) {
    if (!name.endsWith(ATOMIC_REPLACE_TMP_SUFFIX)) continue;
    await unlinkIfExists(fsMod, path.join(dir, name));
  }
}

async function writeJsonAtomic(fsMod: typeof fs, file: string, value: unknown): Promise<void> {
  const tmp = file + ".tmp";
  await writeFileDurable(fsMod, tmp, JSON.stringify(value, null, 2) + "\n");
  await renameWithRetry(fsMod, tmp, file);
}

async function unlinkIfExists(fsMod: typeof fs, file: string): Promise<void> {
  try {
    await fsMod.unlink(file);
  } catch (err) {
    if (!isErrnoCode(err, "ENOENT")) throw err;
  }
}

async function listMarkdown(fsMod: typeof fs, sceneDir: string): Promise<string[]> {
  try {
    const names = await fsMod.readdir(sceneDir);
    return names.filter((name) => name.toLowerCase().endsWith(".md")).sort();
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return [];
    throw err;
  }
}

interface MergeLockHandle {
  token: string;
  release(): Promise<void>;
}

interface MergeLockFileState {
  raw: string;
  mtimeMs?: number;
  owner?: string;
  ts?: number;
  ttlMs?: number;
}

async function readMergeLockFile(fsMod: typeof fs, lockPath: string): Promise<MergeLockFileState | null> {
  const raw = await readTextOrNull(fsMod, lockPath);
  if (raw === null) return null;
  let mtimeMs: number | undefined;
  try {
    const info = await fsMod.stat(lockPath);
    mtimeMs = info.mtimeMs;
  } catch (err) {
    if (!isErrnoCode(err, "ENOENT")) throw err;
  }
  try {
    const parsed = JSON.parse(raw) as { owner?: unknown; ts?: unknown; ttlMs?: unknown };
    return {
      raw,
      mtimeMs,
      owner: typeof parsed.owner === "string" ? parsed.owner : undefined,
      ts: typeof parsed.ts === "number" && Number.isFinite(parsed.ts) ? parsed.ts : undefined,
      ttlMs: typeof parsed.ttlMs === "number" && Number.isFinite(parsed.ttlMs) ? parsed.ttlMs : undefined,
    };
  } catch {
    return { raw, mtimeMs };
  }
}

/**
 * 跨进程 merge 锁：本地 fs O_EXCL + TTL 心跳。
 *
 * 过期接管：先 rename 移走「观察到的」锁文件，再复读确认移走的确实是该
 * owner/ts（并发替换时不删他人的锁，尽量还原后按普通竞争重试）；接管成功
 * 后 O_EXCL 新建。释放前校验 owner token，token 不匹配绝不 unlink。
 */
async function acquireMergeLock(
  fsMod: typeof fs,
  dataDir: string,
  config: MergeSceneConfig,
  key: string,
): Promise<MergeLockHandle | null> {
  const lockPath = path.join(dataDir, ".metadata", "merge.lock");
  await fsMod.mkdir(path.dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const deadline = Date.now() + config.lockWaitMs;
  const payload = () =>
    JSON.stringify({
      owner: token,
      pid: process.pid,
      host: hostname(),
      ts: Date.now(),
      ttlMs: config.lockTtlMs,
      key,
    });

  const tryCreate = async (): Promise<boolean> => {
    try {
      const handle = await fsMod.open(lockPath, "wx");
      try {
        await handle.writeFile(payload(), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return true;
    } catch (err) {
      if (isErrnoCode(err, "EEXIST")) return false;
      throw err;
    }
  };

  for (;;) {
    if (await tryCreate()) break;
    if (Date.now() >= deadline) return null;
    const observed = await readMergeLockFile(fsMod, lockPath);
    // 崩溃可能留下空/半写锁文件：无 ts 时退化为按文件 mtime 判过期，
    // 否则接管方会一直等到 deadline 并误报 MERGE_LOCK_BUSY。
    const observedTtl = observed?.ttlMs ?? config.lockTtlMs;
    const observedAt = observed?.ts ?? observed?.mtimeMs;
    if (
      observed &&
      observed.owner !== token &&
      observedAt !== undefined &&
      Date.now() - observedAt > observedTtl
    ) {
      const stalePath = lockPath + ".stale-" + token;
      try {
        await renameWithRetry(fsMod, lockPath, stalePath);
        const moved = await readTextOrNull(fsMod, stalePath);
        if (moved !== null && moved === observed.raw) {
          if (await tryCreate()) {
            await unlinkIfExists(fsMod, stalePath);
            break;
          }
          // 抢占窗口被别的进程抢先；清掉已过期的旧锁文件，继续普通竞争。
          await unlinkIfExists(fsMod, stalePath);
        } else {
          // 移走的不是我们观察到的锁：并发替换发生，尽量还原，绝不删除他人锁。
          const current = await readTextOrNull(fsMod, lockPath);
          if (current === null) {
            try {
              await renameWithRetry(fsMod, stalePath, lockPath);
            } catch {
              // 还原失败：残留 .stale-* 由后续清理；不覆盖当前持锁者。
            }
          }
        }
      } catch {
        // rename 抢占失败按普通竞争重试，等待 TTL/下一次循环。
      }
    }
    await sleep(50);
  }

  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        const current = await readTextOrNull(fsMod, lockPath);
        if (!current) return;
        const parsed = JSON.parse(current) as { owner?: unknown };
        if (parsed.owner !== token) return;
        await writeFileDurable(fsMod, lockPath, payload());
      } catch {
        // 心跳失败不改变主事务；TTL 到期后由接管方决定。
      }
    })();
  }, config.heartbeatMs);
  heartbeat.unref?.();

  return {
    token,
    async release(): Promise<void> {
      clearInterval(heartbeat);
      try {
        const current = await readTextOrNull(fsMod, lockPath);
        if (!current) return;
        const parsed = JSON.parse(current) as { owner?: unknown };
        if (parsed.owner !== token) return;
        await unlinkIfExists(fsMod, lockPath);
      } catch {
        // 释放失败不掩盖主结果；锁 TTL 会兜底。
      }
    },
  };
}

/** 落盘 C 的独立复算：结构必须恰好三个 v2 段标题，锚点/正文多重集与 summary 不变量。 */
function verifyMergedRaw(
  cRaw: string,
  target: string,
  aRaw: string,
  aName: string,
  bRaw: string,
  bName: string,
): string | null {
  const block = parseSceneBlock(cRaw, target);
  if (block.content.trim().length === 0) return "C 正文为空";
  const layout = parseV2Layout(block.content);
  if (!layout.ok) return "C 不是受支持的 v2 布局：" + layout.reason;
  const headings = block.content.split("\n").filter((line) => V2_HEADING_RE.test(line));
  if (headings.length !== 3) return "C 的 v2 段标题数不是 3（实际 " + headings.length + "）";

  const conservation = checkConservation(cRaw, target, aRaw, aName, bRaw, bName);
  if (conservation && conservation.kind === "anchor") return "C 的锚点多重集不守恒";
  if (conservation && conservation.kind === "body") return "C 的正文非空行多重集不守恒";

  const gist = extractV2Gist(block.content);
  if (gist === null || block.meta.summary !== normalizeSceneSummary(gist)) {
    return "C 的 META.summary 与要点段派生值不一致";
  }
  return null;
}

async function replaceWithDeleted(
  fsMod: typeof fs,
  file: string,
  preimageRaw: string,
  expectedSha: string,
  label: string,
): Promise<void> {
  const current = await readTextOrNull(fsMod, file);
  if (current === null) {
    throw new MergeExecutionError("MERGE_CONFLICT", label + " 在事务中途消失", { file });
  }
  if (current !== preimageRaw || sha256Text(current) !== expectedSha) {
    throw new MergeExecutionError(
      "MERGE_CONFLICT",
      label + " 已被外部并发写，拒绝用 preimage 覆盖",
      { file, currentSha: sha256Text(current), expectedSha },
    );
  }
  await writeFileAtomicDurable(fsMod, file, "[DELETED]");
}

async function refreshNavigation(
  fsMod: typeof fs,
  dataDir: string,
  entries: SceneIndexEntry[],
): Promise<string> {
  const navigation = generateSceneNavigation(entries);
  const personaPath = path.join(dataDir, "persona.md");
  const existing = await readTextOrNull(fsMod, personaPath);
  if (!existing || existing.trim().length === 0) return navigation;
  const body = stripSceneNavigation(existing).trimEnd();
  if (body.length === 0) return navigation;
  const updated = navigation ? body + "\n\n" + navigation + "\n" : body + "\n";
  await writeFileAtomicDurable(fsMod, personaPath, updated);
  return navigation;
}

/**
 * 执行一次合并事务（Stage 1/2 仅本地 fs、仅隔离 dataDir）。
 *
 * 成功返回落盘后的索引与导航；失败返回结构化错误，且 journal 在写 C 之后才
 * 标记 failed（T04 的恢复扫描据此补完/回滚）。锁在任何返回路径都释放。
 */
export async function executeMerge(opts: ExecuteMergeOptions): Promise<ExecuteMergeResult> {
  const fsMod = opts?.fsMod ?? fs;
  try {
    const backend = opts?.backend ?? "local";
    if (backend !== "local") {
      throw new MergeExecutionError(
        "MERGE_UNSUPPORTED_ATOMICITY",
        "Stage 1/2 只支持本地 fs；storage/COS/rowfs 不具备原子 rename，拒绝进入写路径",
        { backend },
      );
    }
    if (!opts?.config || opts.config.mode === "off") {
      throw new MergeExecutionError("MERGE_MODE_OFF", "mergeScene.mode=off，executeMerge 不执行");
    }
    if (!Number.isFinite(opts.sceneCharCap) || opts.sceneCharCap <= 0) {
      throw new MergeExecutionError("MERGE_CONFLICT", "sceneCharCap 非法（帽关闭时不允许合并）");
    }
    if (typeof opts.dataDir !== "string" || opts.dataDir.trim().length === 0) {
      throw new MergeExecutionError("MERGE_IO_ERROR", "dataDir 必须是非空字符串");
    }
    const dataDir = path.resolve(opts.dataDir);
    assertNotProductionDataDir(dataDir);
    const plan = opts.plan;
    assertPlanShape(plan);

    const sceneDir = path.join(dataDir, "scene_blocks");
    const targetPath = path.join(sceneDir, plan.target);
    const aPath = path.join(sceneDir, plan.a.filename);
    const bPath = path.join(sceneDir, plan.b.filename);

    const lock = await acquireMergeLock(fsMod, dataDir, opts.config, plan.key);
    if (!lock) {
      return {
        ok: false,
        error: { code: "MERGE_LOCK_BUSY", message: "merge.lock 被占用，等待超时" },
      };
    }

    let journal: MergeJournal | null = null;
    let journalPath = "";
    let journalStarted = false;
    // failed/rolled_back 的同 key 重试种子（SPEC-E §4.8）；非空时复用原 journal 的
    // attempts/startedAt，只把 stage 重置为 prepared。
    let retrySeed: MergeJournal | null = null;
    try {
       // ---- 幂等/崩溃恢复：同 key journal 已存在时不再产出第二个 C ----
      const existingPaths = mergeJournalPaths(dataDir, opts.config, plan.key);
      const existingRead = await readJournalFile(fsMod, existingPaths.file);
      if (existingRead.kind === "corrupt") {
        throw new MergeExecutionError("MERGE_JOURNAL_CORRUPT", existingRead.message, {
          journalPath: existingPaths.file,
        });
      }
      if (existingRead.kind === "ok") {
        let existingJournal = existingRead.journal;
        if (
          existingJournal.stage === "prepared" ||
          existingJournal.stage === "c_persisted" ||
          existingJournal.stage === "a_deleted" ||
          existingJournal.stage === "b_deleted"
        ) {
          await recoverJournalUnderLock(fsMod, dataDir, opts.config, existingJournal, existingPaths.file);
          const afterRecovery = await readJournalFile(fsMod, existingPaths.file);
          if (afterRecovery.kind === "ok") existingJournal = afterRecovery.journal;
        }
        if (existingJournal.stage === "done") {
          const currentTarget = await readTextOrNull(
            fsMod,
            path.join(sceneDir, existingJournal.target.filename),
          );
          if (currentTarget === null || sha256Text(currentTarget) !== existingJournal.target.sha256) {
            throw new MergeExecutionError("MERGE_CONFLICT", "journal 已完成但目标文件缺失或被改写", {
              target: existingJournal.target.filename,
            });
          }
          const currentIndex = await readSceneIndex(dataDir);
          return {
            ok: true,
            status: "skipped",
            key: existingJournal.key,
            target: existingJournal.target.filename,
            journalPath: existingPaths.file,
            preimageDir: existingPaths.preimageDir,
            index: currentIndex,
            navigation: generateSceneNavigation(currentIndex),
            journalStage: "done",
            message: "幂等：该合并已完成，未重复写入",
          };
        }
        if (existingJournal.stage === "failed" || existingJournal.stage === "rolled_back") {
          // SPEC-E §4.8：failed/rolled_back 允许同 key 重试（attempts+1）。
          // C 已落盘则先补完（绝不产生第二个 C）；C 未落盘则先恢复 A/B preimage 再重跑。
          const retried = await retryFailedJournalUnderLock(
            fsMod,
            dataDir,
            opts.config,
            plan,
            existingJournal,
            existingPaths.file,
          );
          if (retried.kind === "finished") {
            const afterRetry = await readJournalFile(fsMod, existingPaths.file);
            const finalJournal = afterRetry.kind === "ok" ? afterRetry.journal : existingJournal;
            const currentIndex = await readSceneIndex(dataDir);
            return {
              ok: true,
              status: "skipped",
              key: finalJournal.key,
              target: finalJournal.target.filename,
              journalPath: existingPaths.file,
              preimageDir: existingPaths.preimageDir,
              index: currentIndex,
              navigation: generateSceneNavigation(currentIndex),
              journalStage: finalJournal.stage,
              message: "重试：C 已落盘，补完未完成事务，未产生第二个 C",
            };
          }
          retrySeed = retried.journal;
        }
      }

      // ---- preflight（锁内重读，零数据写）----
      const aRaw = await readTextOrNull(fsMod, aPath);
      const bRaw = await readTextOrNull(fsMod, bPath);
      if (aRaw === null || bRaw === null) {
        throw new MergeExecutionError("MERGE_CONFLICT", "输入场景在 preflight 时不存在", {
          a: plan.a.filename,
          b: plan.b.filename,
        });
      }
      if (sha256Text(aRaw) !== plan.a.sha256 || sha256Text(bRaw) !== plan.b.sha256) {
        throw new MergeExecutionError("MERGE_CONFLICT", "输入场景在 plan 之后被改写", {
          aMatch: sha256Text(aRaw) === plan.a.sha256,
          bMatch: sha256Text(bRaw) === plan.b.sha256,
        });
      }
      const existing = await listMarkdown(fsMod, sceneDir);
      const targetLower = plan.target.toLowerCase();
      if (existing.some((name) => name.toLowerCase() === targetLower)) {
        throw new MergeExecutionError("MERGE_TARGET_EXISTS", "目标场景已存在", { target: plan.target });
      }
      const replanned = planMerge(
        { filename: plan.a.filename, raw: aRaw },
        { filename: plan.b.filename, raw: bRaw },
        {
          config: opts.config,
          now: plan.now,
          target: plan.target,
          sceneCharCap: opts.sceneCharCap,
          existingSceneNames: existing,
        },
      );
      if (!replanned.ok) {
        throw new MergeExecutionError("MERGE_CONFLICT", "锁内复算被拒绝：" + replanned.rejection.message, {
          rejection: replanned.rejection,
        });
      }
      if (replanned.plan.key !== plan.key || replanned.plan.c.raw !== plan.c.raw) {
        throw new MergeExecutionError("MERGE_CONFLICT", "锁内复算与传入 plan 不一致");
      }
      const targetSha = sha256Text(plan.c.raw);
      const paths = mergeJournalPaths(dataDir, opts.config, plan.key);
      const at = nowIso();
      journal = {
        version: 1,
        key: plan.key,
        inputs: { a: { ...plan.a }, b: { ...plan.b } },
        concatOrder: plan.concatOrder,
        target: { filename: plan.target, sha256: targetSha, chars: plan.c.raw.length },
        stage: "prepared",
        attempts: retrySeed
          ? [...retrySeed.attempts, { at, pid: process.pid, host: hostname(), result: "prepared" }]
          : [{ at, pid: process.pid, host: hostname(), result: "prepared" }],
        pid: process.pid,
        host: hostname(),
        startedAt: retrySeed?.startedAt ?? at,
        updatedAt: at,
        metrics: { ...plan.metrics },
      };
      journalPath = paths.file;

      // ---- journal(prepared) + preimage：必须在写 C 之前落盘 ----
      await writeFileDurable(fsMod, path.join(paths.preimageDir, "A.pre.md"), aRaw);
      await writeFileDurable(fsMod, path.join(paths.preimageDir, "B.pre.md"), bRaw);
      await writeJsonAtomic(fsMod, journalPath, journal);
      journalStarted = true;

      // ---- C 写 .part → fsync → 复读校验 → 原子 rename ----
      await writeFileDurable(fsMod, paths.part, plan.c.raw);
      const readback = await fsMod.readFile(paths.part, "utf8");
      if (readback !== plan.c.raw || sha256Text(readback) !== targetSha) {
        throw new MergeExecutionError("MERGE_IO_ERROR", ".part 复读内容与 plan.c.raw 不一致");
      }
      const verifyError = verifyMergedRaw(
        readback,
        plan.target,
        aRaw,
        plan.a.filename,
        bRaw,
        plan.b.filename,
      );
      if (verifyError) {
        throw new MergeExecutionError("MERGE_CONFLICT", verifyError);
      }
      await renameWithRetry(fsMod, paths.part, targetPath);
      journal.stage = "c_persisted";
      journal.updatedAt = nowIso();
      journal.attempts.push({ at: journal.updatedAt, pid: process.pid, host: hostname(), result: "c_persisted" });
      await writeJsonAtomic(fsMod, journalPath, journal);

      // ---- 逐个软删 A/B：先逐字节比对 preimage，冲突不覆盖 ----
      await replaceWithDeleted(fsMod, aPath, aRaw, plan.a.sha256, "A");
      journal.stage = "a_deleted";
      journal.updatedAt = nowIso();
      journal.attempts.push({ at: journal.updatedAt, pid: process.pid, host: hostname(), result: "a_deleted" });
      await writeJsonAtomic(fsMod, journalPath, journal);

      await replaceWithDeleted(fsMod, bPath, bRaw, plan.b.sha256, "B");
      journal.stage = "b_deleted";
      journal.updatedAt = nowIso();
      journal.attempts.push({ at: journal.updatedAt, pid: process.pid, host: hostname(), result: "b_deleted" });
      await writeJsonAtomic(fsMod, journalPath, journal);

      // ---- Stage 1 不跑生产 Phase5：显式 unlink A/B 后自行同步索引/导航 ----
      await unlinkIfExists(fsMod, aPath);
      await unlinkIfExists(fsMod, bPath);
      const index = await syncSceneIndex(dataDir);
      const navigation = await refreshNavigation(fsMod, dataDir, index);
      journal.stage = "done";
      journal.updatedAt = nowIso();
      journal.attempts.push({ at: journal.updatedAt, pid: process.pid, host: hostname(), result: "done" });
      await writeJsonAtomic(fsMod, journalPath, journal);

      return {
        ok: true,
        status: "merged",
        key: plan.key,
        target: plan.target,
        journalPath,
        preimageDir: paths.preimageDir,
        index,
        navigation,
      };
    } catch (err) {
      if (journal && journalStarted) {
        journal.stage = "failed";
        journal.updatedAt = nowIso();
        journal.error = err instanceof Error ? err.message : String(err);
        journal.attempts.push({ at: journal.updatedAt, pid: process.pid, host: hostname(), result: "failed" });
        try {
          await writeJsonAtomic(fsMod, journalPath, journal);
        } catch {
          // 失败标记写不进去时保留现场，交由 T04 恢复扫描/外部快照处理。
        }
      }
      return { ok: false, error: executionError(err) };
    } finally {
      await lock.release();
    }
  } catch (err) {
    return { ok: false, error: executionError(err) };
  }
}

// ---------------------------------------------------------------------------
// T04：崩溃恢复、冲突收敛、幂等与锁接管
//
// SPEC-E §4.7–§4.8。恢复扫描必须持 merge 锁；每个 journal 只能收敛到
// 「C 已落盘、A/B 已 unlink、索引/导航为 2」或「A/B 原样、C 不存在、索引为 3」。
// 任何外部改写都返回 MERGE_CONFLICT 并保留现场，禁止用 preimage 覆盖。
// ---------------------------------------------------------------------------

export type MergeRecoveryAction = "noop" | "completed" | "rolled_back" | "skipped";

export interface MergeRecoveryOutcome {
  key: string;
  stageBefore: MergeJournalStage;
  stageAfter: MergeJournalStage;
  action: MergeRecoveryAction;
  target: string;
  message?: string;
}

export interface RecoverMergeOptions {
  dataDir: string;
  config: MergeSceneConfig;
  backend?: MergeSceneBackend;
  fsMod?: typeof fs;
  /** 只恢复指定 key；缺省扫描 journalDir 下全部 *.json。 */
  key?: string;
}

export type RecoverMergeResult =
  | {
      ok: true;
      scanned: number;
      outcomes: MergeRecoveryOutcome[];
      index: SceneIndexEntry[];
      navigation: string;
    }
  | {
      ok: false;
      error: MergeSceneExecuteError;
      outcomes?: MergeRecoveryOutcome[];
    };

const MERGE_JOURNAL_STAGES: readonly MergeJournalStage[] = [
  "prepared",
  "c_persisted",
  "a_deleted",
  "b_deleted",
  "done",
  "failed",
  "rolled_back",
];

function isJournalInput(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const input = value as { filename?: unknown; sha256?: unknown; chars?: unknown };
  try {
    ensurePlainFilename(input.filename, "journal.input.filename");
  } catch {
    return false;
  }
  if (typeof input.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.sha256)) return false;
  if (typeof input.chars !== "number" || !Number.isFinite(input.chars)) return false;
  return true;
}

function isMergeJournal(value: unknown): value is MergeJournal {
  if (!value || typeof value !== "object") return false;
  const journal = value as Record<string, unknown>;
  if (journal.version !== 1) return false;
  if (typeof journal.key !== "string" || !/^[0-9a-f]{64}$/.test(journal.key)) return false;
  if (typeof journal.stage !== "string" || !MERGE_JOURNAL_STAGES.includes(journal.stage as MergeJournalStage)) {
    return false;
  }
  const inputs = journal.inputs as { a?: unknown; b?: unknown } | undefined;
  if (!inputs || !isJournalInput(inputs.a) || !isJournalInput(inputs.b)) return false;
  const target = journal.target as { filename?: unknown; sha256?: unknown; chars?: unknown } | undefined;
  if (!target) return false;
  try {
    ensurePlainFilename(target.filename, "journal.target.filename");
  } catch {
    return false;
  }
  if (typeof target.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(target.sha256)) return false;
  if (typeof target.chars !== "number" || !Number.isFinite(target.chars)) return false;
  if (typeof journal.concatOrder !== "string") return false;
  if (!Array.isArray(journal.attempts)) return false;
  if (typeof journal.pid !== "number" || typeof journal.host !== "string") return false;
  if (typeof journal.startedAt !== "string" || typeof journal.updatedAt !== "string") return false;
  if (!journal.metrics || typeof journal.metrics !== "object") return false;
  return true;
}

type JournalReadResult =
  | { kind: "missing" }
  | { kind: "ok"; journal: MergeJournal }
  | { kind: "corrupt"; message: string };

async function readJournalFile(fsMod: typeof fs, file: string): Promise<JournalReadResult> {
  const raw = await readTextOrNull(fsMod, file);
  if (raw === null) return { kind: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      kind: "corrupt",
      message: "journal JSON 解析失败：" + (err instanceof Error ? err.message : String(err)),
    };
  }
  if (!isMergeJournal(parsed)) return { kind: "corrupt", message: "journal 字段缺失或非法" };
  if (path.basename(file) !== parsed.key + ".json") {
    return { kind: "corrupt", message: "journal 文件名与 key 不一致" };
  }
  return { kind: "ok", journal: parsed };
}

function isDeletedText(value: string): boolean {
  return value.trim() === "[DELETED]";
}

async function persistRecoveryStage(
  fsMod: typeof fs,
  journalPath: string,
  journal: MergeJournal,
  stage: MergeJournalStage,
  action: string,
  note: string,
): Promise<void> {
  journal.stage = stage;
  journal.updatedAt = nowIso();
  journal.recovery = { at: journal.updatedAt, action, note };
  journal.attempts.push({ at: journal.updatedAt, pid: process.pid, host: hostname(), result: stage });
  await writeJsonAtomic(fsMod, journalPath, journal);
}

async function readJournalPreimages(
  fsMod: typeof fs,
  paths: MergeJournalPaths,
): Promise<{ a: string; b: string } | null> {
  const a = await readTextOrNull(fsMod, path.join(paths.preimageDir, "A.pre.md"));
  const b = await readTextOrNull(fsMod, path.join(paths.preimageDir, "B.pre.md"));
  if (a === null || b === null) return null;
  return { a, b };
}

async function rollbackPreparedJournal(
  fsMod: typeof fs,
  dataDir: string,
  journalPath: string,
  journal: MergeJournal,
  paths: MergeJournalPaths,
  preimages: { a: string; b: string },
  stageBefore: MergeJournalStage,
  reason: string,
): Promise<MergeRecoveryOutcome> {
  const sceneDir = path.join(dataDir, "scene_blocks");
  const aPath = path.join(sceneDir, journal.inputs.a.filename);
  const bPath = path.join(sceneDir, journal.inputs.b.filename);
  const targetPath = path.join(sceneDir, journal.target.filename);
  const aCurrent = await readTextOrNull(fsMod, aPath);
  const bCurrent = await readTextOrNull(fsMod, bPath);
  if (aCurrent !== preimages.a || bCurrent !== preimages.b) {
    throw new MergeExecutionError("MERGE_CONFLICT", "回退前 A/B 已不是 preimage，拒绝覆盖", {
      aMatch: aCurrent === preimages.a,
      bMatch: bCurrent === preimages.b,
    });
  }
  const targetRaw = await readTextOrNull(fsMod, targetPath);
  if (targetRaw !== null) {
    if (targetRaw.trim().length > 0) {
      throw new MergeExecutionError("MERGE_CONFLICT", "目标 C 内容异常，拒绝删除", {
        target: journal.target.filename,
      });
    }
    await unlinkIfExists(fsMod, targetPath);
  }
  await unlinkIfExists(fsMod, paths.part);
  await persistRecoveryStage(fsMod, journalPath, journal, "rolled_back", "rollback", reason);
  const index = await syncSceneIndex(dataDir);
  await refreshNavigation(fsMod, dataDir, index);
  return {
    key: journal.key,
    stageBefore,
    stageAfter: "rolled_back",
    action: "rolled_back",
    target: journal.target.filename,
    message: reason,
  };
}

async function writeRecoveredDeletion(
  fsMod: typeof fs,
  file: string,
  current: string | null,
  preimage: string,
  label: string,
  tolerateMissing: boolean,
): Promise<void> {
  if (current === null) {
    if (tolerateMissing) return;
    throw new MergeExecutionError("MERGE_CONFLICT", label + " 在恢复时消失", { file });
  }
  if (isDeletedText(current)) return;
  if (current !== preimage) {
    throw new MergeExecutionError("MERGE_CONFLICT", label + " 已被外部并发写，拒绝覆盖", { file });
  }
  await writeFileAtomicDurable(fsMod, file, "[DELETED]");
}

async function finishMergedJournal(
  fsMod: typeof fs,
  dataDir: string,
  journalPath: string,
  journal: MergeJournal,
  preimages: { a: string; b: string },
  stageBefore: MergeJournalStage,
): Promise<MergeRecoveryOutcome> {
  const sceneDir = path.join(dataDir, "scene_blocks");
  const targetPath = path.join(sceneDir, journal.target.filename);
  const aPath = path.join(sceneDir, journal.inputs.a.filename);
  const bPath = path.join(sceneDir, journal.inputs.b.filename);
  const targetRaw = await readTextOrNull(fsMod, targetPath);
  if (targetRaw === null || targetRaw.trim().length === 0 || sha256Text(targetRaw) !== journal.target.sha256) {
    throw new MergeExecutionError("MERGE_CONFLICT", "恢复时 C 缺失或 sha 不匹配", {
      target: journal.target.filename,
    });
  }
  const tolerateMissing = journal.stage === "b_deleted";
  const aCurrent = await readTextOrNull(fsMod, aPath);
  const bCurrent = await readTextOrNull(fsMod, bPath);
  await writeRecoveredDeletion(fsMod, aPath, aCurrent, preimages.a, "A", tolerateMissing);
  await persistRecoveryStage(fsMod, journalPath, journal, "a_deleted", "recover", "补写 A=[DELETED]");
  await writeRecoveredDeletion(fsMod, bPath, bCurrent, preimages.b, "B", tolerateMissing);
  await persistRecoveryStage(fsMod, journalPath, journal, "b_deleted", "recover", "补写 B=[DELETED]");
  await unlinkIfExists(fsMod, aPath);
  await unlinkIfExists(fsMod, bPath);
  const index = await syncSceneIndex(dataDir);
  await refreshNavigation(fsMod, dataDir, index);
  await persistRecoveryStage(fsMod, journalPath, journal, "done", "recover", "恢复补完并同步索引/导航");
  return {
    key: journal.key,
    stageBefore,
    stageAfter: "done",
    action: "completed",
    target: journal.target.filename,
    message: "已补完合并并收敛到 2 个活动场景",
  };
}

async function recoverJournalUnderLock(
  fsMod: typeof fs,
  dataDir: string,
  config: MergeSceneConfig,
  journal: MergeJournal,
  journalPath: string,
): Promise<MergeRecoveryOutcome> {
  const stageBefore = journal.stage;
  const paths = mergeJournalPaths(dataDir, config, journal.key);
  const sceneDir = path.join(dataDir, "scene_blocks");
  const targetPath = path.join(sceneDir, journal.target.filename);
  const targetRaw = await readTextOrNull(fsMod, targetPath);
  const cValid =
    targetRaw !== null && targetRaw.trim().length > 0 && sha256Text(targetRaw) === journal.target.sha256;

  if (stageBefore === "done") {
    if (!cValid) {
      throw new MergeExecutionError("MERGE_CONFLICT", "journal=done 但目标 C 缺失或 sha 不匹配");
    }
    return {
      key: journal.key,
      stageBefore,
      stageAfter: "done",
      action: "noop",
      target: journal.target.filename,
    };
  }
  const preimages = await readJournalPreimages(fsMod, paths);
  if (!preimages) {
    throw new MergeExecutionError("MERGE_JOURNAL_CORRUPT", "journal 缺少 preimage(A.pre.md/B.pre.md)", {
      preimageDir: paths.preimageDir,
    });
  }

  if (stageBefore === "failed") {
    if (cValid) {
      // C 已落盘但 journal=failed：补完删除/索引/导航，避免永久半合并态（SPEC-E §4.8）。
      return finishMergedJournal(fsMod, dataDir, journalPath, journal, preimages, stageBefore);
    }
    return {
      key: journal.key,
      stageBefore,
      stageAfter: stageBefore,
      action: "skipped",
      target: journal.target.filename,
      message: "failed 且 C 未落盘：A/B 未被半合并，等待同 key 重试",
    };
  }
  if (stageBefore === "rolled_back") {
    if (cValid) {
      throw new MergeExecutionError("MERGE_CONFLICT", "journal=rolled_back 但目标 C 仍存在，现场不一致");
    }
    return {
      key: journal.key,
      stageBefore,
      stageAfter: stageBefore,
      action: "skipped",
      target: journal.target.filename,
      message: "已回滚到 3 个活动场景，等待同 key 重试",
    };
  }

  if (stageBefore === "prepared") {
    if (!cValid) {
      if (targetRaw !== null && targetRaw.trim().length > 0) {
        throw new MergeExecutionError("MERGE_CONFLICT", "prepared 状态下 C 已存在且 sha 不匹配，拒绝覆盖");
      }
      return rollbackPreparedJournal(
        fsMod,
        dataDir,
        journalPath,
        journal,
        paths,
        preimages,
        stageBefore,
        "C 未落盘，按 prepared 回退到 3 个活动场景",
      );
    }
    await persistRecoveryStage(fsMod, journalPath, journal, "c_persisted", "recover", "C 已落盘，补记 c_persisted");
    return finishMergedJournal(fsMod, dataDir, journalPath, journal, preimages, stageBefore);
  }

  if (!cValid) {
    if (stageBefore === "c_persisted" && targetRaw === null) {
      const aCurrent = await readTextOrNull(fsMod, path.join(sceneDir, journal.inputs.a.filename));
      const bCurrent = await readTextOrNull(fsMod, path.join(sceneDir, journal.inputs.b.filename));
      if (aCurrent === preimages.a && bCurrent === preimages.b) {
        return rollbackPreparedJournal(
          fsMod,
          dataDir,
          journalPath,
          journal,
          paths,
          preimages,
          stageBefore,
          "C 丢失且 A/B 完好，回退到 3 个活动场景",
        );
      }
    }
    throw new MergeExecutionError("MERGE_CONFLICT", "恢复时 C 缺失或 sha 不匹配");
  }

  return finishMergedJournal(fsMod, dataDir, journalPath, journal, preimages, stageBefore);
}

type RetryJournalResult =
  | { kind: "finished"; outcome: MergeRecoveryOutcome; journal: MergeJournal }
  | { kind: "restarted"; journal: MergeJournal };

/**
 * SPEC-E §4.8：failed/rolled_back 的同 key 重试。
 *
 * - C 已落盘且 sha 匹配：直接补完事务（写 [DELETED]、unlink、sync），不产生第二个 C；
 * - C 未落盘/为空：只允许 A/B 处于 preimage 或本事务留下的 [DELETED]，恢复为 preimage
 *   后把 journal 重置为 prepared（attempts+1），由 executeMerge 重跑写路径。
 */
async function retryFailedJournalUnderLock(
  fsMod: typeof fs,
  dataDir: string,
  config: MergeSceneConfig,
  plan: MergeScenePlan,
  journal: MergeJournal,
  journalPath: string,
): Promise<RetryJournalResult> {
  const paths = mergeJournalPaths(dataDir, config, journal.key);
  const preimages = await readJournalPreimages(fsMod, paths);
  if (!preimages) {
    throw new MergeExecutionError("MERGE_JOURNAL_CORRUPT", "journal 缺少 preimage(A.pre.md/B.pre.md)", {
      preimageDir: paths.preimageDir,
    });
  }
  if (journal.target.filename !== plan.target || journal.target.sha256 !== sha256Text(plan.c.raw)) {
    throw new MergeExecutionError("MERGE_CONFLICT", "重试的 plan 与原 journal 的 target 不一致，拒绝产生第二个 C", {
      journalTarget: journal.target.filename,
      planTarget: plan.target,
    });
  }
  if (sha256Text(preimages.a) !== plan.a.sha256 || sha256Text(preimages.b) !== plan.b.sha256) {
    throw new MergeExecutionError("MERGE_JOURNAL_CORRUPT", "journal preimage 与 plan 输入 sha 不一致");
  }
  const sceneDir = path.join(dataDir, "scene_blocks");
  const targetPath = path.join(sceneDir, journal.target.filename);
  const targetRaw = await readTextOrNull(fsMod, targetPath);
  const cValid = targetRaw !== null && targetRaw.trim().length > 0 && sha256Text(targetRaw) === journal.target.sha256;
  if (targetRaw !== null && targetRaw.trim().length > 0 && !cValid) {
    throw new MergeExecutionError("MERGE_CONFLICT", "重试时 C 已存在且 sha 不匹配，拒绝覆盖", {
      target: journal.target.filename,
    });
  }
  if (cValid) {
    const outcome = await finishMergedJournal(fsMod, dataDir, journalPath, journal, preimages, journal.stage);
    return { kind: "finished", outcome, journal };
  }
  const sides: Array<[string, string, string]> = [
    ["A", path.join(sceneDir, journal.inputs.a.filename), preimages.a],
    ["B", path.join(sceneDir, journal.inputs.b.filename), preimages.b],
  ];
  for (const [label, file, preimage] of sides) {
    const current = await readTextOrNull(fsMod, file);
    if (current === null) {
      throw new MergeExecutionError("MERGE_CONFLICT", "重试时 " + label + " 不存在", { file });
    }
    if (current === preimage) continue;
    if (!isDeletedText(current)) {
      throw new MergeExecutionError("MERGE_CONFLICT", label + " 已被外部并发写，拒绝覆盖", { file });
    }
    await writeFileAtomicDurable(fsMod, file, preimage);
  }
  await unlinkIfExists(fsMod, targetPath);
  await unlinkIfExists(fsMod, paths.part);
  journal.stage = "prepared";
  journal.updatedAt = nowIso();
  journal.attempts.push({ at: journal.updatedAt, pid: process.pid, host: hostname(), result: "retry" });
  delete journal.error;
  journal.recovery = { at: journal.updatedAt, action: "retry", note: "重置为 prepared，同 key 重试" };
  await writeJsonAtomic(fsMod, journalPath, journal);
  return { kind: "restarted", journal };
}

/**
 * 扫描并恢复 journal。必须持 merge 锁（无 journal 时不加锁、零写）。
 * 每个 journal 独立收敛；有 corrupt/conflict 时继续处理其余 journal，最终返回失败。
 */
export async function recoverMergeJournal(opts: RecoverMergeOptions): Promise<RecoverMergeResult> {
  const fsMod = opts?.fsMod ?? fs;
  let outcomes: MergeRecoveryOutcome[] = [];
  try {
    const backend = opts?.backend ?? "local";
    if (backend !== "local") {
      throw new MergeExecutionError(
        "MERGE_UNSUPPORTED_ATOMICITY",
        "Stage 1/2 只支持本地 fs 的 journal 恢复",
        { backend },
      );
    }
    if (typeof opts?.dataDir !== "string" || opts.dataDir.trim().length === 0) {
      throw new MergeExecutionError("MERGE_IO_ERROR", "dataDir 必须是非空字符串");
    }
    if (!opts.config) {
      throw new MergeExecutionError("MERGE_IO_ERROR", "config 缺失");
    }
    const dataDir = path.resolve(opts.dataDir);
    assertNotProductionDataDir(dataDir);
    const journalRoot = path.join(dataDir, ...opts.config.journalDir.split("/"));
    let files: string[];
    if (opts.key) {
      const one = mergeJournalPaths(dataDir, opts.config, opts.key);
      files = [one.file];
    } else {
      try {
        const names = await fsMod.readdir(journalRoot);
        files = names.filter((name) => name.endsWith(".json")).sort().map((name) => path.join(journalRoot, name));
      } catch (err) {
        if (!isErrnoCode(err, "ENOENT")) throw err;
        files = [];
      }
    }
    if (files.length === 0) {
      const emptyIndex = await readSceneIndex(dataDir);
      return {
        ok: true,
        scanned: 0,
        outcomes: [],
        index: emptyIndex,
        navigation: generateSceneNavigation(emptyIndex),
      };
    }

    const lock = await acquireMergeLock(fsMod, dataDir, opts.config, opts.key ?? "recover");
    if (!lock) {
      return {
        ok: false,
        error: { code: "MERGE_LOCK_BUSY", message: "merge.lock 被占用，恢复扫描放弃" },
      };
    }
    let scanned = 0;
    let firstError: MergeSceneExecuteError | null = null;
    try {
      // 上次崩溃可能留下 .merge-tmp；持锁清理，避免孤儿文件被后续扫描当成场景。
      await removeAtomicReplaceTemps(fsMod, path.join(dataDir, "scene_blocks"));
      await removeAtomicReplaceTemps(fsMod, dataDir);
      for (const file of files) {
        const read = await readJournalFile(fsMod, file);
        if (read.kind === "missing") continue;
        scanned += 1;
        if (read.kind === "corrupt") {
          firstError = firstError ?? { code: "MERGE_JOURNAL_CORRUPT", message: read.message, details: { file } };
          continue;
        }
        try {
          const outcome = await recoverJournalUnderLock(fsMod, dataDir, opts.config, read.journal, file);
          outcomes.push(outcome);
        } catch (err) {
          const parsed = executionError(err);
          firstError = firstError ?? parsed;
        }
      }
    } finally {
      await lock.release();
    }
    const index = await readSceneIndex(dataDir);
    const navigation = generateSceneNavigation(index);
    if (firstError) {
      return { ok: false, error: firstError, outcomes };
    }
    return { ok: true, scanned, outcomes, index, navigation };
  } catch (err) {
    return { ok: false, error: executionError(err), outcomes };
  }
}
