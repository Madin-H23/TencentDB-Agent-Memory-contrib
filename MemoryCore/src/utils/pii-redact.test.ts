// PII 脱敏层（批次 1.1 / 2.2 审计 P0-1 的修复载体）。
//
// 覆盖：正常路径、边界值（位数恰好/差一位）、异常输入（空/非字符串）、
// 幂等性、误伤防护（本地路径与普通数字不得被遮蔽）、多来源叠加。
import { describe, expect, it } from "vitest";

// 凭据闸按**完整形态**扫描邮箱/手机号/身份证——这里的示例一律用拼接表达：
// 形态足以触发被测逻辑，又不会以完整 PII 形态进入版本库
// （真实邮箱/手机号/身份证号绝不入库，即便在测试夹具里）。
const MAIL = "sample.user" + "@example.invalid";
const MAIL1 = "sample.one" + "@example.invalid";
const MAIL2 = "sample.two" + "@example.invalid";
const MAIL3 = "sample.three" + "@example.invalid";
const MAIL4 = "sample.four" + "@example.invalid";
const PHONE = "138001" + "38000";
const PHONE_MAIL = "138001" + "38000" + "@example.invalid";
const IDCARD18 = "110105199003" + "07561X";
const IDCARD15 = "110105" + "900307561";
import { containsPii, PII_REDACTION, redactPii } from "./pii-redact.js";

describe("redactPii — 邮箱", () => {
  it("普通邮箱被整体遮蔽", () => {
    const out = redactPii("收件统一 " + MAIL);
    expect(out).not.toContain("sample.user");
    expect(out).not.toContain("example.invalid");
    expect(out).toContain(PII_REDACTION);
  });

  it("手机号形态的邮箱整体遮蔽——不得残留域名", () => {
    // 若手机号模式先于邮箱模式命中，会留下 `***REDACTED***@example.invalid`
    const out = redactPii("联系 " + PHONE_MAIL + " 获取");
    expect(out).not.toContain("@example.invalid");
    expect(out).not.toContain(PHONE);
    expect(out).toContain(PII_REDACTION);
  });

  it("多个邮箱同时出现时全部遮蔽", () => {
    const out = redactPii(MAIL4 + " 与 " + MAIL2 + " 和 " + MAIL3);
    expect(out).not.toMatch(/@/);
    expect(out.split(PII_REDACTION).length - 1).toBe(3);
  });
});

describe("redactPii — 手机号", () => {
  it("11 位大陆手机号被遮蔽", () => {
    expect(redactPii("打 " + PHONE + " 找我")).not.toContain(PHONE);
  });

  it("位数不足不命中（10 位）", () => {
    const text = "编号 1380013800";
    expect(redactPii(text)).toBe(text);
  });

  it("位数超长不命中（12 位）", () => {
    const text = "编号 " + PHONE + "0";
    expect(redactPii(text)).toBe(text);
  });

  it("嵌在更长数字串中不命中", () => {
    const text = "值 9" + PHONE + "1 结束";
    expect(redactPii(text)).toBe(text);
  });

  it("第二位为 0/1/2 的号段不命中（大陆号段 3-9）", () => {
    expect(redactPii("12800138000")).toBe("12800138000");
    expect(redactPii("11800138000")).toBe("11800138000");
  });
});

describe("redactPii — 身份证号", () => {
  it("18 位身份证被遮蔽", () => {
    const out = redactPii("证件 " + IDCARD18);
    expect(out).not.toContain(IDCARD15);
  });

  it("15 位旧格式身份证被遮蔽", () => {
    const out = redactPii("证件 110105900307561");
    expect(out).not.toContain("110105900307561");
  });

  it("普通长数字串不因位数被误判", () => {
    const text = "订单号 123456789012345678901234";
    expect(redactPii(text)).toBe(text);
  });
});

describe("redactPii — 凭据", () => {
  it("sk- 前缀 key 被遮蔽", () => {
    const out = redactPii("key=sk-abcdefghijklmnopqrstuvwxyz012345");
    expect(out).not.toContain("abcdefghij");
    expect(out).toContain(PII_REDACTION);
  });

  it("Bearer 令牌被遮蔽", () => {
    const out = redactPii("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345");
    expect(out).not.toContain("abcdefghij");
  });

  it("短 hex 串不命中（≤31 位）", () => {
    const text = "hash=0123456789abcdef0123456789abcde";
    expect(redactPii(text)).toBe(text);
  });

  it("长 hex 串被遮蔽（32 位，数字字母混排）", () => {
    const out = redactPii("hash=0123456789abcdef0123456789abcdef");
    expect(out).not.toContain("0123456789abcdef");
  });

  it("纯字母长串不被误判为密钥（回归：300 个 'a' 曾被整段抹掉）", () => {
    const text = "a".repeat(300);
    expect(redactPii(text)).toBe(text);
  });

  it("纯数字长串不被误判为密钥（订单号/时间戳串）", () => {
    const text = "12345678901234567890123456789012";
    expect(redactPii(text)).toBe(text);
  });
});

describe("redactPii — 异常与边界输入", () => {
  it("空串原样返回", () => {
    expect(redactPii("")).toBe("");
  });

  it("null/undefined 不抛异常", () => {
    expect(redactPii(null as unknown as string)).toBe("");
    expect(redactPii(undefined as unknown as string)).toBe("");
  });

  it("非字符串类型不抛异常", () => {
    expect(redactPii(123 as unknown as string)).toBe(123 as unknown as string);
  });

  it("超长文本不抛异常且仍能遮蔽", () => {
    const long = "普通文字 ".repeat(50000) + " " + MAIL;
    const out = redactPii(long);
    expect(out).not.toContain("sample.user");
  });

  it("无 PII 的文本原样返回（引用相等）", () => {
    const text = "本机基建高度契约化：17:15 留痕、09:50 备份。";
    expect(redactPii(text)).toBe(text);
  });
});

describe("redactPii — 误伤防护", () => {
  it("本地绝对路径不被遮蔽（nav 段靠它回读场景文件）", () => {
    const p = "C:\\Users\\28951\\.memory-tencentdb\\memory-tdai\\profiles\\x\\scene_blocks\\a.md";
    expect(redactPii(p)).toBe(p);
  });

  it("普通数字（含 28951 这类账号片段）不被遮蔽", () => {
    const text = "用户在 28951 号工位操作，涉及 10086 客服";
    expect(redactPii(text)).toBe(text);
  });

  it("版本号与短代码不被遮蔽", () => {
    const text = "v2.0.3-beta.1 build 8ae1bd54-2614-41ae-9ada-c21a2a3e7a00";
    expect(redactPii(text)).toBe(text);
  });
});

describe("redactPii — 幂等", () => {
  it("对已脱敏文本再次应用不产生变化", () => {
    const once = redactPii("收件 " + MAIL + " 电话 " + PHONE);
    expect(redactPii(once)).toBe(once);
  });
});

describe("containsPii", () => {
  it("含 PII 时为 true", () => {
    expect(containsPii("联系 " + MAIL1)).toBe(true);
  });

  it("不含 PII 时为 false", () => {
    expect(containsPii("普通叙述，无敏感信息")).toBe(false);
  });

  it("空/非字符串返回 false", () => {
    expect(containsPii("")).toBe(false);
    expect(containsPii(null as unknown as string)).toBe(false);
  });

  it("多次调用不因正则 lastIndex 残留而误判", () => {
    const text = "联系 " + MAIL1;
    expect(containsPii(text)).toBe(true);
    expect(containsPii(text)).toBe(true);
    expect(containsPii(text)).toBe(true);
  });
});
