// #42 覆盖战役：add-handler.ts 两私有纯函数 totalMessagesBytes / countRoles 直测。
// 纯 export 零逻辑改动；复用 #39/#40 的 UTF-8 字节交叉验证 + 变异验证范式。
import { describe, it, expect } from "vitest";
import { totalMessagesBytes, countRoles } from "./add-handler.js";
import type { CompressibleMessage, CompressibleRole } from "./message-compressor.js";

function msg(role: CompressibleRole, content: string, extra?: Record<string, unknown>): CompressibleMessage {
  return { role, content, ...(extra ?? {}) };
}

describe("add-handler-helpers · A 组：totalMessagesBytes 按 UTF-8 字节", () => {
  it("空数组 → 0", () => {
    expect(totalMessagesBytes([])).toBe(0);
  });

  it("ASCII 逐条字节和精确值", () => {
    const msgs = [msg("user", "abc"), msg("assistant", "de")];
    // JSON.stringify 含 role/content 键与引号，用同一公式交叉验证而非硬编码
    const expected = msgs.reduce((s, m) => s + Buffer.byteLength(JSON.stringify(m), "utf8"), 0);
    expect(totalMessagesBytes(msgs)).toBe(expected);
  });

  it("中文/emoji 按 UTF-8 字节而非字符计数（变异成 content.length 时转红）", () => {
    const ascii = msg("user", "A");
    const cjk = msg("user", "中");
    const emoji = msg("user", "😀");
    expect(totalMessagesBytes([cjk])).toBe(Buffer.byteLength(JSON.stringify(cjk), "utf8"));
    expect(totalMessagesBytes([emoji])).toBe(Buffer.byteLength(JSON.stringify(emoji), "utf8"));
    expect(totalMessagesBytes([cjk])).toBeGreaterThan(totalMessagesBytes([ascii]));
    expect(totalMessagesBytes([emoji])).toBeGreaterThan(totalMessagesBytes([ascii]));
    expect(totalMessagesBytes([cjk])).not.toBe(cjk.content.length);
  });

  it("含 metadata/tool_call_id 等附加字段时 JSON 全量计入", () => {
    const plain = msg("tool_result", "x");
    const withMeta = msg("tool_result", "x", { tool_call_id: "AX7Q-call-0001", metadata: { truncated: true } });
    expect(totalMessagesBytes([withMeta])).toBeGreaterThan(totalMessagesBytes([plain]));
    expect(totalMessagesBytes([withMeta])).toBe(Buffer.byteLength(JSON.stringify(withMeta), "utf8"));
  });
});

describe("add-handler-helpers · B 组：countRoles 精确计数", () => {
  const toolRoles: ReadonlySet<CompressibleRole> = new Set(["tool_call", "tool_result"]);

  it("空数组 → 0；空 Set → 0", () => {
    expect(countRoles([], toolRoles)).toBe(0);
    expect(countRoles([msg("user", "x")], new Set())).toBe(0);
  });

  it("给定 Set 精确计数匹配角色，不匹配不计", () => {
    const msgs = [msg("user", "a"), msg("tool_call", "b"), msg("assistant", "c"), msg("tool_result", "d")];
    expect(countRoles(msgs, toolRoles)).toBe(2);
    expect(countRoles(msgs, new Set(["user"]))).toBe(1);
  });

  it("重复角色逐条累计", () => {
    const msgs = [msg("tool_call", "a"), msg("tool_call", "b"), msg("tool_call", "c")];
    expect(countRoles(msgs, new Set(["tool_call"]))).toBe(3);
  });

  it("变异恒 true 时转红：不匹配角色不得计入", () => {
    const msgs = [msg("user", "a"), msg("user", "b"), msg("tool_call", "c")];
    expect(countRoles(msgs, toolRoles)).toBe(1); // 恒 true 变异会给 3
  });
});

describe("add-handler-helpers · C 组：类型边界", () => {
  it("非 CompressibleRole 字符串被 Set.has 自然排除（钉契约，不改行为）", () => {
    const msgs = [msg("unknown-role" as CompressibleRole, "a"), msg("tool_call", "b")];
    expect(countRoles(msgs, new Set(["tool_call"]))).toBe(1);
  });
});
