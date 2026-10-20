/**
 * L1 记忆的用户归属归一化（确定性护栏，v2 3eb7c8b 移植）。
 *
 * 背景（v2 2026-09-24 实测事故）：纯提示词约束挡不住模型往「用户（X）」的姓名
 * 括号里填非姓名内容——路径片段（C:\Users\28951）、角色标签（导师/开发者）、
 * 时间状语、甚至命理排盘原文，产出「用户（王缘林）」「用户（导师）」这类身份
 * 误归属，并经 L2/L3 聚合扩散。
 *
 * 规则：出现 `用户（X）` 时——
 *   - X ∈ 自指词（用户/本人/我…）→ 归一为「用户」
 *   - X ∈ 配置白名单（extraction.userIdentityNames）→ 原样保留
 *   - 其余一切（第三方姓名、角色、路径数字、状语、乱码）→ 丢弃括号、归一为
 *     「用户」，并回传被丢弃的标签供日志审计
 *
 * 事实不丢：错位的括号内容在 L0 原文与场景文件里仍可追溯。
 *
 * 复合标签（2026-10-20 批次 2.1 增补）：模型常写「用户（何伟健/heweijian）」
 * 这类**同一身份的多写法**。原实现按整串精确匹配，会把用户自己的别名误判成
 * 第三方姓名而丢弃（实测 7 行：何伟健/heweijian、Weijian He / GitHub Madin-H23）。
 * 现按分隔符切分复合标签，**要求每一段都命中白名单**才整串保留；只要有一段
 * 不命中就整体丢弃（偏保守方向，宁可丢归属也不放过第三方姓名）。
 */

/** 自指词：这些标签等价于"用户"本身，不构成第三方归属。 */
const SELF_LABELS = new Set(["用户", "本人", "我", "用户本人", "自己"]);

/** 复合标签的分隔符：斜杠 / 顿号 / 中英文逗号 / 竖线 / &。空格不在其中（"Weijian He" 是一个名字）。 */
const LABEL_SEPARATORS = /[/、，,|&]/;

// 半角/全角括号都覆盖；限长避免误吞长句
const ATTR_RE = /用户[（(]([^）)]{1,60})[）)]/g;

export interface AttributionSanitizeResult {
  text: string;
  /** 被丢弃的伪姓名标签（去重、保序） */
  dropped: string[];
}

/**
 * 归一化标签：转小写并去掉所有非字母数字字符，使 "Weijian He"、"weijian-he"、
 * "GitHub Madin-H23" 与白名单项可比对（保留 Unicode 字母，CJK 不受影响）。
 */
function normalizeLabel(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * 一段标签是否命中白名单：归一化后做包含比较。
 *
 * 用包含而非相等，是为了让 "GitHub Madin-H23" 这类带前缀的写法命中白名单项
 * "Madin-H23"；白名单项本身是长且有辨识度的名字，误命中风险极低。
 */
function labelMatchesAllowlist(label: string, allow: string[]): boolean {
  const norm = normalizeLabel(label);
  if (!norm) return false;
  return allow.some((entry) => {
    const e = normalizeLabel(entry);
    return e.length > 0 && norm.includes(e);
  });
}

export function sanitizeUserAttribution(
  text: string,
  allowedNames: string[] = [],
): AttributionSanitizeResult {
  if (!text || !text.includes("用户")) return { text, dropped: [] };
  const allow = (allowedNames ?? []).map((n) => n.trim()).filter(Boolean);
  const dropped: string[] = [];
  const out = text.replace(ATTR_RE, (match, raw: string) => {
    const label = raw.trim();
    // 复合标签切分：所有分段都必须是自指词或命中白名单，才保留整串
    const segments = label.split(LABEL_SEPARATORS).map((s) => s.trim()).filter(Boolean);
    const segs = segments.length > 0 ? segments : [label];
    if (segs.every((s) => SELF_LABELS.has(s))) return "用户";
    if (segs.every((s) => labelMatchesAllowlist(s, allow))) return match;
    if (!dropped.includes(label)) dropped.push(label);
    return "用户";
  });
  return { text: out, dropped };
}
