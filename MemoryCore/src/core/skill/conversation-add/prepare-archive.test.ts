import { describe, expect, it } from "vitest";
import {
  prepareArchivePayload,
  totalMessagesBytes,
  type PrepareArchiveOptions,
} from "./prepare-archive.js";
import type { CompressibleMessage } from "./message-compressor.js";
import type { OversizeMessage } from "./oversize-strategy.js";

const COMPRESS = {
  toolContentThresholdBytes: 10,
  headBytes: 4,
  tailBytes: 4,
  placeholder: "<<CUT>>",
};

const OVERSIZE = {
  chunkMaxBytes: 100_000,
  headKeepBytes: 20,
  tailKeepBytes: 20,
  placeholderTemplate: "OMIT({n},{bytes})",
};

function opts(forceCompress: boolean, oversize = OVERSIZE): PrepareArchiveOptions {
  return { compress: COMPRESS, oversize, forceCompress };
}

function user(n: number): OversizeMessage {
  return { role: "user", content: String(n) };
}

describe("prepare-archive · A 组：非压缩直通", () => {
  it("forceCompress=false → 超长 tool 消息也不压缩，逐字段等于 existing + incoming", () => {
    const existing: OversizeMessage[] = [{ role: "assistant", content: "prev" }];
    const incoming: CompressibleMessage[] = [
      { role: "tool_result", content: "x".repeat(100), tool_call_id: "AX7Q-call-0001" },
    ];
    const out = prepareArchivePayload(existing, incoming, opts(false));
    expect(out.usedCompress).toBe(false);
    expect(out.usedOversize).toBe(false);
    expect(out.messages).toEqual([...existing, ...incoming]);
    expect(out.messages[1]).toBe(incoming[0]); // 原引用直通
  });

  it("空输入 → 全空结果、三标记 false", () => {
    const out = prepareArchivePayload([], [], opts(false));
    expect(out).toEqual({ messages: [], usedCompress: false, usedOversize: false });
  });
});

describe("prepare-archive · B 组：压缩路径", () => {
  it("forceCompress=true + 超阈值 tool → usedCompress=true，combined 与 metadata 正确", () => {
    const existing: OversizeMessage[] = [{ role: "assistant", content: "prev" }];
    const incoming: CompressibleMessage[] = [
      { role: "tool_result", content: "abcdefghijklmnop", tool_call_id: "AX7Q-call-0001" },
    ];
    const out = prepareArchivePayload(existing, incoming, opts(true));
    expect(out.usedCompress).toBe(true);
    expect(out.usedOversize).toBe(false);
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]).toEqual(existing[0]);
    expect(out.messages[1]!.content).toBe("abcd<<CUT>>mnop");
    expect(out.messages[1]!.metadata).toMatchObject({ truncated: true, original_bytes: 16 });
    expect(out.messages[1]!.tool_call_id).toBe("AX7Q-call-0001"); // 其它字段透传
  });
});

describe("prepare-archive · C 组：兜底截断", () => {
  it("combined 超 chunkMax → 走 oversize，placeholder 计数/字节精确，usedOversize=true", () => {
    const msgs = [1, 2, 3, 4, 5, 6].map(user);
    const one = totalMessagesBytes([msgs[0]!]);
    const out = prepareArchivePayload([], msgs, opts(true, {
      chunkMaxBytes: one * 3,
      headKeepBytes: one * 2,
      tailKeepBytes: one * 2,
      placeholderTemplate: "OMIT({n},{bytes})",
    }));
    expect(out.usedOversize).toBe(true);
    expect(out.messages).toHaveLength(5); // head2 + placeholder1 + tail2
    expect(out.messages[0]).toEqual(msgs[0]);
    expect(out.messages[1]).toEqual(msgs[1]);
    expect(out.messages[2]).toMatchObject({ role: "system" });
    expect(out.messages[3]).toEqual(msgs[4]);
    expect(out.messages[4]).toEqual(msgs[5]);
    expect(out.messages[2]!.content).toBe(`OMIT(2,${one * 2})`);
    expect(out.messages[2]!.metadata).toEqual({ omitted_message_count: 2, omitted_bytes: one * 2 });
    expect(out.usedCompress).toBe(false); // user 消息非压缩角色
  });
});

describe("prepare-archive · D 组：未超帽不兜底", () => {
  it("forceCompress=true 且 combined ≤ chunkMax → usedOversize=false，无 placeholder", () => {
    const msgs = [1, 2, 3].map(user);
    const out = prepareArchivePayload([], msgs, opts(true, {
      ...OVERSIZE,
      chunkMaxBytes: totalMessagesBytes(msgs),
    }));
    expect(out.usedOversize).toBe(false);
    expect(out.messages).toEqual(msgs);
  });
});

describe("prepare-archive · E 组：usedCompress 语义", () => {
  it("短 tool 消息未超阈值 → 即便 forceCompress=true 也 usedCompress=false（identity）", () => {
    const incoming: CompressibleMessage[] = [
      { role: "tool_result", content: "short", tool_call_id: "AX7Q-call-0001" },
    ];
    const out = prepareArchivePayload([], incoming, opts(true));
    expect(out.usedCompress).toBe(false); // 改成直接返回 forceCompress 时此断言转红
    expect(out.messages[0]).toBe(incoming[0]);
  });
});

describe("prepare-archive · F 组：UTF-8 多字节按字节", () => {
  it("totalMessagesBytes 对中文/emoji 按 UTF-8 字节求和（与 Buffer.byteLength 交叉验证）", () => {
    const ascii = { role: "user", content: "A" };
    const cjk = { role: "user", content: "中" };
    const emoji = { role: "user", content: "😀" };
    expect(totalMessagesBytes([cjk])).toBe(Buffer.byteLength(JSON.stringify(cjk), "utf8"));
    expect(totalMessagesBytes([emoji])).toBe(Buffer.byteLength(JSON.stringify(emoji), "utf8"));
    expect(totalMessagesBytes([cjk])).toBeGreaterThan(totalMessagesBytes([ascii]));
    expect(totalMessagesBytes([cjk, ascii, emoji])).toBe(
      totalMessagesBytes([cjk]) + totalMessagesBytes([ascii]) + totalMessagesBytes([emoji]),
    );
  });

  it("中文消息按字节预算决定兜底边界（非字符数）", () => {
    const msgs = ["中", "文", "字", "串", "末", "尾"].map((c) => ({ role: "user", content: c }));
    const one = totalMessagesBytes([msgs[0]!]);
    const out = prepareArchivePayload([], msgs, opts(true, {
      chunkMaxBytes: one * 3,
      headKeepBytes: one * 2,
      tailKeepBytes: one * 2,
      placeholderTemplate: "OMIT({n},{bytes})",
    }));
    expect(out.usedOversize).toBe(true);
    expect(out.messages[2]!.content).toBe(`OMIT(2,${one * 2})`);
  });
});
