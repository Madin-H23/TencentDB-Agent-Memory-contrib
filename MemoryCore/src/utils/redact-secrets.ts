/**
 * 日志脱敏：任何进入日志的错误串 / 文本先去密钥形态。
 *
 * 语义门与回填都在热路径调用远端 embedding/LLM，错误串可能带
 * `Authorization: Bearer sk-...` 或厂商 key 片段；SPEC §6 要求
 * 「key 任何情况不进日志」。只做形态擦除，不引入配置依赖。
 */

/** 返回脱敏后的文本（永不抛错）。 */
export function redactSecrets(text: string): string {
  let out: string;
  try {
    // OpenAI / SiliconFlow / 通用 sk- 形态（整体替换，输出不含 "sk-" 前缀）
    out = text.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-key]");
    // Bearer <token>（保留 "Bearer " 便于定位，token 擦除）
    out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted-key]");
  } catch {
    return "[redacted]";
  }
  return out;
}

/** 把 unknown 错误转成脱敏后的可日志字符串。 */
export function redactError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return redactSecrets(message);
}
