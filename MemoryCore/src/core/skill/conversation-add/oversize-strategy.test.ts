import { describe, expect, it } from "vitest";
import {
  applyOversizeStrategy,
  DEFAULT_OVERSIZE_OPTIONS,
  messageBytes,
  totalBytes,
  type OversizeMessage,
  type OversizeOptions,
} from "./oversize-strategy.js";

function msg(content: string): OversizeMessage {
  return { role: "user", content };
}

const OPTS: OversizeOptions = {
  chunkMaxBytes: 2, // 强制超帽，触发截断分支
  headKeepBytes: 1,
  tailKeepBytes: 1,
  placeholderTemplate: "OMIT({n},{bytes})",
};

describe("oversize-strategy · A 组：直通", () => {
  it("空数组 → 全空结果、truncated=false", () => {
    expect(applyOversizeStrategy([], OPTS)).toEqual({
      messages: [], truncated: false, omittedMessageCount: 0, omittedBytes: 0,
    });
  });

  it("总量 ≤ chunkMaxBytes → passthrough，逐字段相等", () => {
    const msgs = [msg("a"), msg("b")];
    const out = applyOversizeStrategy(msgs, { ...OPTS, chunkMaxBytes: totalBytes(msgs) });
    expect(out.truncated).toBe(false);
    expect(out.omittedMessageCount).toBe(0);
    expect(out.messages).toEqual(msgs);
  });

  it("默认 options 契约值钉死", () => {
    expect(DEFAULT_OVERSIZE_OPTIONS.chunkMaxBytes).toBe(81_920);
    expect(DEFAULT_OVERSIZE_OPTIONS.headKeepBytes).toBe(20_480);
    expect(DEFAULT_OVERSIZE_OPTIONS.tailKeepBytes).toBe(20_480);
  });
});

describe("oversize-strategy · B 组：截断与 placeholder", () => {
  it("超帽：head/tail 各保留、中间段替换为一条 system placeholder，计数/字节精确", () => {
    // 6 条等长单字符消息；预算按「单条消息 JSON 字节」精确设定 head=2/tail=2
    const msgs = [msg("1"), msg("2"), msg("3"), msg("4"), msg("5"), msg("6")];
    const one = messageBytes(msg("X"));
    const opts: OversizeOptions = {
      chunkMaxBytes: one * 3,
      headKeepBytes: one * 2,
      tailKeepBytes: one * 2,
      placeholderTemplate: "OMIT({n},{bytes})",
    };
    const out = applyOversizeStrategy(msgs, opts);
    expect(out.truncated).toBe(true);
    expect(out.messages).toHaveLength(5); // head2 + placeholder1 + tail2
    expect(out.messages[0]).toEqual(msgs[0]);
    expect(out.messages[1]).toEqual(msgs[1]);
    expect(out.messages[2]).toMatchObject({ role: "system" });
    expect(out.messages[3]).toEqual(msgs[4]);
    expect(out.messages[4]).toEqual(msgs[5]);
    expect(out.omittedMessageCount).toBe(2);
    expect(out.omittedBytes).toBe(one * 2);
    expect(out.messages[2]!.content).toBe(`OMIT(2,${one * 2})`);
    expect(out.messages[2]!.metadata).toEqual({ omitted_message_count: 2, omitted_bytes: one * 2 });
  });
});

describe("oversize-strategy · C 组：极端边界", () => {
  it("单条消息超 head/tail 预算 → 头保留 1 条；无中间省略 → passthrough", () => {
    const big = msg("x".repeat(200));
    const out = applyOversizeStrategy([big], { ...OPTS, headKeepBytes: 1, tailKeepBytes: 1 });
    expect(out.truncated).toBe(false);
    expect(out.messages).toEqual([big]);
    expect(out.omittedMessageCount).toBe(0);
  });

  it("head+tail 覆盖全部消息（omitted=0）→ passthrough", () => {
    const msgs = [msg("a"), msg("b"), msg("c"), msg("d")];
    const out = applyOversizeStrategy(msgs, {
      ...OPTS,
      headKeepBytes: totalBytes(msgs),
      tailKeepBytes: totalBytes(msgs),
    });
    expect(out.truncated).toBe(false);
    expect(out.messages).toEqual(msgs);
  });
});

describe("oversize-strategy · D 组：UTF-8 多字节按字节计数", () => {
  it("messageBytes 对中文/emoji 按 UTF-8 字节而非字符计数", () => {
    const ascii = { role: "user", content: "A" };
    const cjk = { role: "user", content: "中" };
    const emoji = { role: "user", content: "😀" };
    expect(messageBytes(cjk)).toBe(Buffer.byteLength(JSON.stringify(cjk), "utf8"));
    expect(messageBytes(emoji)).toBe(Buffer.byteLength(JSON.stringify(emoji), "utf8"));
    // 字符数同为 1，但字节数不同 —— 变异成 content.length 时此断言转红
    expect(messageBytes(cjk)).toBeGreaterThan(messageBytes(ascii));
    expect(messageBytes(emoji)).toBeGreaterThan(messageBytes(ascii));
    expect(messageBytes(cjk)).not.toBe(cjk.content.length);
  });

  it("totalBytes 为逐条 messageBytes 之和", () => {
    const msgs = [msg("中"), msg("A"), msg("😀x")];
    expect(totalBytes(msgs)).toBe(msgs.reduce((s, m) => s + messageBytes(m), 0));
  });

  it("截断场景下中文消息按字节预算（非字符数）决定保留边界", () => {
    const msgs = [msg("中"), msg("文"), msg("字"), msg("串"), msg("末"), msg("尾")];
    const one = messageBytes(msg("中")); // == messageBytes(msg("文"))（同为 3 字节 UTF-8 + JSON 壳）
    const opts: OversizeOptions = {
      chunkMaxBytes: one * 3,
      headKeepBytes: one * 2,
      tailKeepBytes: one * 2,
      placeholderTemplate: "OMIT({n},{bytes})",
    };
    const out = applyOversizeStrategy(msgs, opts);
    expect(out.omittedMessageCount).toBe(2);
    expect(out.omittedBytes).toBe(one * 2);
    expect(out.messages[2]!.content).toBe(`OMIT(2,${one * 2})`);
  });
});
