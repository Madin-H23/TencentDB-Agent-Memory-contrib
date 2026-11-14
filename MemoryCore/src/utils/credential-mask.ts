/**
 * 票 origin#28（S1·L0 明文凭据三件套——写入侧掩码）：凭据掩码纯函数+拒绝式配置。
 *
 * 缺陷实证（2026-11-05）：2026-10-09 一条 sk- 前缀 API Key 明文消息被 auto-capture
 * 落库，面板 L0 视图原样渲染、检索上下文再带出（二次暴露面）。commit 侧凭据闸
 * 已拦 git 面，数据面是系统性缺口——本模块在 L0 写入前掩码（接线点
 * l0-recorder Step 3 sanitize 链，覆盖 JSONL 留痕/L0 行/L1 蒸馏源全下游）。
 *
 * 设计取舍（防误伤优先——掩码不可逆，误掩正常代码比漏掩代价高）：
 * - sk- 前必须非 [A-Za-z0-9_-]（负回顾）："task-sk-xxx" 连字命名不掩、"sklearn" 无 "-" 恒不掩
 * - sk- 后需 20+ 位连续字母数字（19 位不掩）；OpenAI sk-proj- 二段形态需第二段 24+
 * - Bearer token 需 16+ 位；自定义前缀同理 16+ 位（短前缀误伤面大，不入默认）
 * - 掩码值保留前缀（sk-***masked***）供审计辨形；metric 行只打计数零回显
 * - 默认 off（未配置=行为逐字节不变）；shadow 先量（不改文只计量）后启用（on 留用户）
 */

/** 解析产物（off=undefined，调用方不接线）。 */
export interface CredentialMaskConfig {
  mode: "shadow" | "on";
  /** 自定义前缀（字面匹配·非空·≤32 字符）；内置 sk-/Bearer 恒开不受此项影响。 */
  prefixes: string[];
}

/** 自定义前缀长度上限（防超长前缀变成另一条内容规则）。 */
const MAX_PREFIX_LEN = 32;
/** 自定义前缀 token 最短长度。 */
const CUSTOM_PREFIX_MIN_TOKEN = 16;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 掩码一条文本（纯函数·不可变入参）。
 * @param prefixes 自定义前缀列表（字面匹配）
 * @returns 掩码后文本；无命中时返回原文（同一字符串内容）
 */
export function maskCredentials(text: string, prefixes: readonly string[] = []): string {
  let out = text;
  // sk- + 20+ 位连续字母数字（SiliconFlow/智谱/DeepSeek 等主流形态）。
  // 负回顾：sk- 前不能是字母/数字/连字符/下划线——"task-sk-xxx" 不掩。
  out = out.replace(
    /(?<![A-Za-z0-9_-])(sk-)[A-Za-z0-9]{20,}/g,
    "$1***masked***",
  );
  // OpenAI 二段形态（sk-proj-/sk-svcacct-…）：首段 3+ 位，第二段 24+ 位。
  // 第二段阈值抬高（24）压词组误伤面（"sk-learn-model-pipeline" 14 位不掩）。
  out = out.replace(
    /(?<![A-Za-z0-9_-])(sk-)[A-Za-z0-9]{3,}-[A-Za-z0-9_-]{24,}/g,
    "$1***masked***",
  );
  // HTTP Authorization 形态（Bearer 大小写不敏感·保留原文大小写）。
  out = out.replace(
    /(?<![A-Za-z0-9_-])(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
    "$1 ***masked***",
  );
  for (const prefix of prefixes) {
    const re = new RegExp(
      `(?<![A-Za-z0-9_-])(${escapeRegExp(prefix)})[A-Za-z0-9_-]{${CUSTOM_PREFIX_MIN_TOKEN},}`,
      "g",
    );
    out = out.replace(re, "$1***masked***");
  }
  return out;
}

/**
 * 解析 `extraction.captureCredentialMask`（拒绝式·畸形 throw 不静默回落）：
 * - undefined/null/false → undefined（off=现有行为逐字节不变）
 * - true → { mode: "on", prefixes: [] }
 * - 对象 → mode 必填且 ∈ {shadow, on}（off 用 false/缺省表达，不设 "off" 字面值）；
 *   prefixes 可选 string[]（非空串·≤32 字符）
 */
export function parseCredentialMaskConfig(raw: unknown): CredentialMaskConfig | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;
  if (raw === true) return { mode: "on", prefixes: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `[config] extraction.captureCredentialMask 非法类型 ${typeof raw}（合法：缺省/false=off、true=on、{mode,prefixes?}）`,
    );
  }
  const o = raw as Record<string, unknown>;
  if (o.mode !== "shadow" && o.mode !== "on") {
    throw new Error(
      `[config] extraction.captureCredentialMask.mode 非法值 ${String(o.mode)}（合法：shadow|on；off 用缺省/false 表达）`,
    );
  }
  let prefixes: string[] = [];
  if (o.prefixes !== undefined) {
    if (!Array.isArray(o.prefixes)) {
      throw new Error("[config] extraction.captureCredentialMask.prefixes 须为字符串数组");
    }
    prefixes = o.prefixes.map((p) => {
      if (typeof p !== "string" || p.length === 0 || p.length > MAX_PREFIX_LEN) {
        throw new Error(
          `[config] extraction.captureCredentialMask.prefixes 项须为非空且 ≤${MAX_PREFIX_LEN} 字符的字符串: ${String(p)}`,
        );
      }
      return p;
    });
  }
  return { mode: o.mode, prefixes };
}

/** 最小日志接口（结构类型——调用方传完整 Logger 即兼容）。 */
interface MaskLogger {
  info?(msg: string): void;
  debug?(msg: string): void;
}

/**
 * 由配置构造 L0 写入侧掩码闭包（接线用）：
 * - off/缺省 → undefined（调用方不接线·行为逐字节不变）
 * - on → 闭包：命中即掩（保留前缀）
 * - shadow → 闭包：返回原文逐字节不变，只累计命中数并打 metric 行
 *   （`metric=capture_credential_mask_shadow hits=N`·零内容回显）
 */
export function createCredentialMasker(
  raw: unknown,
  logger?: MaskLogger,
): ((text: string) => string) | undefined {
  const cfg = parseCredentialMaskConfig(raw);
  if (!cfg) return undefined;
  if (cfg.mode === "on") {
    return (text: string) => {
      const masked = maskCredentials(text, cfg.prefixes);
      if (masked !== text) {
        logger?.debug?.("[memory-tdai][l0] metric=capture_credential_mask value=1 (masked on write)");
      }
      return masked;
    };
  }
  // shadow：只计量不改文
  let hits = 0;
  return (text: string) => {
    const masked = maskCredentials(text, cfg.prefixes);
    if (masked !== text) {
      hits++;
      logger?.info?.(`[memory-tdai][l0] metric=capture_credential_mask_shadow hits=${hits}`);
    }
    return text;
  };
}
