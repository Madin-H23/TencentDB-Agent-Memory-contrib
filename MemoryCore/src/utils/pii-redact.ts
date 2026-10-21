/**
 * PII 脱敏（记忆内容侧）。
 *
 * 背景（2026-10-20 审计 P0-1）：记忆内容管线全程无 PII 过滤。上游
 * `persona-generator.ts` 先对 LLM 写的 body 做脱敏，随后由工程代码追加的
 * Scene Navigation 段**不经过任何脱敏**；而 nav 段里的 `Summary` 逐字来自
 * `scene_blocks/*.md` 的 META.summary。于是场景文件里出现的私有邮箱/手机号
 * 会原样落进 persona.md，并通过 `/v2/core/read` 与 rowfs 的读时重渲染对外可见。
 *
 * 这里提供的是一个**纯函数**脱敏层：调用点自行决定何时应用（渲染期、索引构建期），
 * 便于向上游提 PR 时只带这一层。
 *
 * 设计取舍：
 * - 一律整体遮蔽为 `***REDACTED***`（与上游配置脱敏的既有约定一致），
 *   不做部分保留——保留域名/号段仍构成可关联的标识。
 * - 不处理本地文件路径：nav 段里的绝对路径是给本地 agent 用 read 工具回读的
 *   必要信息，脱敏它会直接破坏功能。
 * - 幂等：对已脱敏文本再次应用不产生额外变化。
 */

/** 统一遮蔽标记（与上游配置脱敏的 `***REDACTED***` 约定一致）。 */
export const PII_REDACTION = "***REDACTED***";

/**
 * 各模式的匹配顺序有意义：先整体匹配更长的形态，避免被短模式切碎
 * （例如手机号邮箱必须先于裸手机号命中，否则 `13800138000@example.invalid`
 * 会被拆成 `***REDACTED***@example.invalid`，域名反而留在结果里）。
 */
const PII_PATTERNS: RegExp[] = [
  // 邮箱（含数字、手机号形态的邮箱）
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  // 中国大陆手机号（11 位，1 开头且第二位 3-9）
  /(?<![0-9])1[3-9][0-9]{9}(?![0-9])/g,
  // 身份证号（18 位，含 X；或 15 位旧格式）
  /(?<![0-9A-Za-z])[1-9][0-9]{5}(?:19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx](?![0-9A-Za-z])/g,
  /(?<![0-9A-Za-z])[1-9][0-9]{5}[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3}(?![0-9A-Za-z])/g,
  // 常见 API key 前缀
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  // Bearer 令牌
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
  // 长十六进制串（≥32 位，典型为密钥/哈希）。
  // 必须**同时含数字与字母**才算命中：纯 aaaa… 这类长串虽符合 hex 形状，
  // 但显然是普通文本（误判实测：300 个 'a' 会被整段抹掉，技术类摘要受损），
  // 而真实密钥几乎必然数字字母混排。
  /\b(?=[0-9a-fA-F]*[0-9])(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{32,}\b/g,
];

/**
 * 对文本做 PII 脱敏。
 *
 * @param text 待脱敏文本；非字符串按空串处理
 * @returns 脱敏后的文本；无命中时原样返回（保持引用相等，便于上层判空）
 */
export function redactPii(text: string): string {
  if (!text || typeof text !== "string") return text ?? "";
  let out = text;
  for (const re of PII_PATTERNS) {
    out = out.replace(re, PII_REDACTION);
  }
  return out;
}

/**
 * 判断文本是否含 PII（供上层做「是否需要改写」的判定，避免无谓的字符串分配）。
 */
export function containsPii(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  return PII_PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}
