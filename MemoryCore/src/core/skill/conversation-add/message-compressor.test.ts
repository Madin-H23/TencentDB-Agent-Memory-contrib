import { describe, expect, it } from "vitest";
import {
  compressMessage,
  compressMessages,
  DEFAULT_COMPRESS_OPTIONS,
  type CompressibleMessage,
} from "./message-compressor.js";

function tool(content: string): CompressibleMessage {
  return { role: "tool_result", content, tool_call_id: "AX7Q-call-0001" };
}

const SMALL = {
  toolContentThresholdBytes: 10,
  headBytes: 4,
  tailBytes: 4,
  placeholder: "<<CUT>>",
};

describe("message-compressor · E 组：角色门控", () => {
  it("非压缩角色（user/assistant/system）即使超长也原样返回（引用相等）", () => {
    for (const role of ["user", "assistant", "system"] as const) {
      const m: CompressibleMessage = { role, content: "x".repeat(100) };
      expect(compressMessage(m, SMALL)).toBe(m); // 恒压缩变异时此断言转红
      expect(compressMessage(m, SMALL).content).toBe("x".repeat(100));
    }
  });

  it("tool_call / tool_result 超阈值才压缩，未超阈值原样返回", () => {
    const call: CompressibleMessage = { role: "tool_call", content: "y".repeat(100) };
    const out = compressMessage(call, SMALL);
    expect(out).not.toBe(call);
    expect(out.content).toContain("<<CUT>>");
    const small = tool("short");
    expect(compressMessage(small, SMALL)).toBe(small);
  });

  it("默认 options 契约值钉死", () => {
    expect(DEFAULT_COMPRESS_OPTIONS.toolContentThresholdBytes).toBe(2048);
    expect(DEFAULT_COMPRESS_OPTIONS.headBytes).toBe(1024);
    expect(DEFAULT_COMPRESS_OPTIONS.tailBytes).toBe(1024);
  });
});

describe("message-compressor · F 组：阈值与 UTF-8 字节切分", () => {
  it("刚好等于阈值不压缩，超 1 字节才压缩", () => {
    const exact = tool("a".repeat(10)); // 10 bytes == 阈值
    expect(compressMessage(exact, SMALL)).toBe(exact);
    const over = tool("a".repeat(11));
    expect(compressMessage(over, SMALL)).not.toBe(over);
  });

  it("ASCII 超阈值：head/tail 按字节保留 + placeholder，metadata 双写", () => {
    const m = tool("abcdefghijklmnop"); // 16 bytes
    const out = compressMessage(m, SMALL);
    expect(out.content).toBe("abcd<<CUT>>mnop");
    expect(out.metadata).toMatchObject({ truncated: true, original_bytes: 16 });
    expect(out.tool_call_id).toBe("AX7Q-call-0001"); // 其它字段透传
  });

  it("UTF-8 多字节按字节切分，original_bytes 为字节数（非字符数）", () => {
    const content = "中文测试内容abcdef"; // 中文各 3 字节
    const bytes = Buffer.byteLength(content, "utf8");
    const m = tool(content);
    const out = compressMessage(m, { ...SMALL, toolContentThresholdBytes: 5, headBytes: 6, tailBytes: 6 });
    expect(out.metadata?.original_bytes).toBe(bytes);
    expect(out.content).toContain("<<CUT>>");
    // head 取前 6 字节 = 两枚完整汉字；不得切出半个 UTF-8 字符（乱码 U+FFFD）
    expect(out.content).not.toContain("\uFFFD");
    expect(out.content.startsWith("中文")).toBe(true);
  });
});

describe("message-compressor · G 组：identity-preserving", () => {
  it("compressMessages 空数组直通，返回新数组（非原引用）", () => {
    const out = compressMessages([], SMALL);
    expect(out).toEqual([]);
    expect(out).not.toBe(undefined);
  });

  it("未变消息共享原引用，压缩消息为新对象", () => {
    const unchanged: CompressibleMessage = { role: "user", content: "short" };
    const changed = tool("x".repeat(50));
    const src = [unchanged, changed];
    const out = compressMessages(src, SMALL);
    expect(out).not.toBe(src); // 新数组
    expect(out[0]).toBe(unchanged); // 未变 → 原引用（下游 diffing 依赖）
    expect(out[1]).not.toBe(changed); // 压缩 → 新对象
  });
});
