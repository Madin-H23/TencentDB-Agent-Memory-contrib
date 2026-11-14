/**
 * Scene Block file format: parse and format the META-delimited Markdown files.
 */

import { redactPii } from "../../utils/pii-redact.js";

export interface SceneBlockMeta {
  created: string;
  updated: string;
  summary: string;
  heat: number;
}

export interface SceneBlock {
  filename: string;
  meta: SceneBlockMeta;
  content: string;
}

const META_START = "-----META-START-----";
const META_END = "-----META-END-----";

/**
 * Parse a Scene Block file into structured data.
 */
export function parseSceneBlock(raw: string, filename: string): SceneBlock {
  const startIdx = raw.indexOf(META_START);
  const endIdx = raw.indexOf(META_END);

  if (startIdx === -1 || endIdx === -1) {
    // No META section — treat entire file as content
    return {
      filename,
      meta: { created: "", updated: "", summary: "", heat: 0 },
      content: raw.trim(),
    };
  }

  const metaBlock = raw.slice(startIdx + META_START.length, endIdx).trim();
  const content = raw.slice(endIdx + META_END.length).trim();

  const meta: SceneBlockMeta = {
    created: extractMetaField(metaBlock, "created"),
    updated: extractMetaField(metaBlock, "updated"),
    summary: extractMetaField(metaBlock, "summary"),
    heat: parseInt(extractMetaField(metaBlock, "heat"), 10) || 0,
  };

  return { filename, meta, content };
}

/**
 * Format a Scene Block back into file content.
 */
export function formatSceneBlock(meta: SceneBlockMeta, content: string): string {
  return `${formatMeta(meta)}\n\n${content}`;
}

/**
 * Format the META section.
 */
export function formatMeta(meta: SceneBlockMeta): string {
  return [
    META_START,
    `created: ${meta.created}`,
    `updated: ${meta.updated}`,
    `summary: ${meta.summary}`,
    `heat: ${meta.heat}`,
    META_END,
  ].join("\n");
}

function extractMetaField(metaBlock: string, field: string): string {
  const re = new RegExp(`^${field}:\\s*(.*)$`, "m");
  const m = metaBlock.match(re);
  return m ? m[1]!.trim() : "";
}

/**
 * 场景摘要的字符预算。
 *
 * 背景（2026-10-20 审计 P0-2）：场景文件的 META.summary 会被模型写成逐批追加的
 * 流水账（现场最长 31,012 字符的单行），索引侧原样透传后**每次 L2 抽取都固定
 * 把 129,629 B 载荷带进提示词**，是上下文溢出的主要来源。
 *
 * 上游提示词里「每个 md 控制在 1500 字符内」是**建议性**的（见上游 issue #1543），
 * 写路径的强制裁剪在上游 PR #1591（尚未合并），属不可逆存量操作。
 * 这里先做**非破坏性**的一层：只规范**索引视图**（进提示词与 nav 段的摘要），
 * 不改动场景文件本体，存量正文不受影响。
 */
export const SCENE_SUMMARY_CHAR_BUDGET = 300;

/**
 * 规范化场景摘要：先 PII 脱敏，再按预算截断。
 *
 * - 脱敏：摘要来自场景文件正文，原样带进 nav 段会泄露私有邮箱/手机号
 *   （审计 P0-1）。此处脱敏保证索引与 nav 两个出口都是干净的。
 * - 截断：在字符边界处切断并补省略标记，避免把一个 UTF-16 代理对劈开。
 *
 * 幂等：对已规范化的摘要再次调用不产生变化。
 */
export function normalizeSceneSummary(summary: string, maxChars: number = SCENE_SUMMARY_CHAR_BUDGET): string {
  if (!summary || typeof summary !== "string") return "";
  const redacted = redactPii(summary);
  if (maxChars <= 0) return "";
  if (redacted.length <= maxChars) return redacted;
  // 留 1 个字符给省略号；避免在代理对中间截断
  const cut = redacted.slice(0, maxChars - 1);
  const lastChar = cut.charCodeAt(cut.length - 1);
  const isHighSurrogate = lastChar >= 0xd800 && lastChar <= 0xdbff;
  return `${isHighSurrogate ? cut.slice(0, -1) : cut}…`;
}
