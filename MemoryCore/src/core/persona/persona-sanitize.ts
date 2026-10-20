/**
 * L3 persona 正文的落盘前净化（批次 1.1 补）。
 *
 * 抽成独立模块的理由：persona-generator 的 generate() 依赖 LLM runner、工具、
 * checkpoint 与 storage，搭完整测试脚手架成本高；而「落盘前净化」本身是
 * 纯函数，按纪律应当可直测。
 *
 * 两层净化各有分工，缺一不可：
 * - `escapeXmlTags`：转义 XML 注入边界标签（prompt injection 防护）
 * - `redactPii`：遮蔽 PII（隐私）。上游只做了前者——记忆内容管线全程无 PII
 *   过滤，私有邮箱/手机号会原样落进 persona.md，并经 /v2/core/read 与
 *   rowfs 的读时重渲染对外可见（实测 body 段 1 处邮箱 + nav 段 9 处）。
 */

import { escapeXmlTags } from "../../utils/sanitize.js";
import { redactPii } from "../../utils/pii-redact.js";
import { stripSceneNavigation } from "../scene/scene-navigation.js";

/**
 * 净化将要写入 persona 文件的正文。
 *
 * 顺序：先剥掉 LLM 可能自行追加的 nav 段（避免重复），再转义注入边界，
 * 最后脱敏 PII。
 */
export function sanitizePersonaBody(text: string): string {
  if (!text || typeof text !== "string") return "";
  return redactPii(escapeXmlTags(stripSceneNavigation(text).trim()));
}

/**
 * 判定「新正文」与「已有正文」是否实质相同（用于跳过无变化的 persona 写入）。
 *
 * 比较基准必须与写入路径用同一套净化，否则脱敏前后的差异会让「无变化」判定
 * 恒为 false，导致每次都重写 persona。
 */
export function personaBodyUnchanged(newBody: string, existingBody: string | undefined): boolean {
  if (existingBody === undefined) return false;
  return sanitizePersonaBody(newBody) === sanitizePersonaBody(existingBody);
}
