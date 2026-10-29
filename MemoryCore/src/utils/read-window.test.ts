// 方案B：read 分段读 —— applyReadWindow 纯函数直测。
//
// 语义契约：
// - offset 缺省 0；limit 缺省 = 到文件尾。
// - 返回 = [offset, offset+limit) 的逐字切片（UTF-16 code unit 口径）。
// - 发生截断（offset>0 或 offset+limit<总长）时末尾追加一行标注：
//   `[... omitted N chars, offset=M limit=L of T total ...]`
//   N = 被省略字符总数（T - 切片长度），M/L = 实际生效的 offset/limit，T = 总长。
// - 越界安全：offset ≥ 总长 → 空串 + 标注。
// - 无 offset/limit（默认全文）→ 不追加任何标注（兼容钉：与旧实现逐字节一致）。
import { describe, expect, it } from "vitest";
import { applyReadWindow, formatReadWindowMarker } from "./read-window.js";

describe("applyReadWindow 默认行为（兼容钉）", () => {
  it("无参数：全文原样返回，不追加标注", () => {
    const content = "0123456789";
    expect(applyReadWindow(content)).toBe(content);
  });

  it("空文件无参数：返回空串", () => {
    expect(applyReadWindow("")).toBe("");
  });

  it("内容本身形似截断标注也原样返回", () => {
    const content = "abc[... omitted 1 chars, offset=0 limit=1 of 2 total ...]xyz";
    expect(applyReadWindow(content)).toBe(content);
  });

  it("offset=0 且 limit=总长：全文无标注（未截断）", () => {
    expect(applyReadWindow("0123456789", { offset: 0, limit: 10 })).toBe("0123456789");
  });

  it("limit 超过总长：全文无标注（未截断）", () => {
    expect(applyReadWindow("0123456789", { limit: 99 })).toBe("0123456789");
  });

  it("负 offset 视为 0：全文无标注", () => {
    expect(applyReadWindow("0123456789", { offset: -5 })).toBe("0123456789");
  });
});

describe("applyReadWindow 切片与标注", () => {
  it("offset+limit 切片正确并追加标注", () => {
    expect(applyReadWindow("0123456789", { offset: 3, limit: 4 })).toBe(
      "3456\n[... omitted 6 chars, offset=3 limit=4 of 10 total ...]",
    );
  });

  it("只传 offset：读到文件尾，标注含生效 limit", () => {
    expect(applyReadWindow("0123456789", { offset: 7 })).toBe(
      "789\n[... omitted 7 chars, offset=7 limit=3 of 10 total ...]",
    );
  });

  it("只传 limit：从头截取", () => {
    expect(applyReadWindow("0123456789", { limit: 5 })).toBe(
      "01234\n[... omitted 5 chars, offset=0 limit=5 of 10 total ...]",
    );
  });

  it("中段截取：标注 N = 前后省略字符总数", () => {
    const big = "a".repeat(1000);
    expect(applyReadWindow(big, { offset: 200, limit: 300 })).toBe(
      `${"a".repeat(300)}\n[... omitted 700 chars, offset=200 limit=300 of 1000 total ...]`,
    );
  });

  it("CJK 按 UTF-16 码元切片（BMP 内一字一码元）", () => {
    expect(applyReadWindow("零一二三四五六七八九", { offset: 3, limit: 4 })).toBe(
      "三四五六\n[... omitted 6 chars, offset=3 limit=4 of 10 total ...]",
    );
  });

  it("limit=0：空切片 + 标注（N=总长）", () => {
    expect(applyReadWindow("0123456789", { offset: 2, limit: 0 })).toBe(
      "[... omitted 10 chars, offset=2 limit=0 of 10 total ...]",
    );
  });
});

describe("applyReadWindow 越界与异常输入", () => {
  it("offset = 总长：空串 + 标注", () => {
    expect(applyReadWindow("0123456789", { offset: 10 })).toBe(
      "[... omitted 10 chars, offset=10 limit=0 of 10 total ...]",
    );
  });

  it("offset > 总长：空串 + 标注", () => {
    expect(applyReadWindow("0123456789", { offset: 42 })).toBe(
      "[... omitted 10 chars, offset=42 limit=0 of 10 total ...]",
    );
  });

  it("空文件 + offset>0：空串 + 标注", () => {
    expect(applyReadWindow("", { offset: 5 })).toBe(
      "[... omitted 0 chars, offset=5 limit=0 of 0 total ...]",
    );
  });

  it("负 limit 视为 0：空串 + 标注", () => {
    expect(applyReadWindow("0123456789", { limit: -3 })).toBe(
      "[... omitted 10 chars, offset=0 limit=0 of 10 total ...]",
    );
  });

  it("非整数 offset/limit 向下取整", () => {
    expect(applyReadWindow("0123456789", { offset: 3.9, limit: 4.9 })).toBe(
      "3456\n[... omitted 6 chars, offset=3 limit=4 of 10 total ...]",
    );
  });

  it("NaN/Infinity 视同缺省（offset→0，limit→到文件尾）", () => {
    expect(applyReadWindow("0123456789", { offset: Number.NaN, limit: Number.NaN })).toBe("0123456789");
    expect(applyReadWindow("0123456789", { offset: Number.POSITIVE_INFINITY, limit: Number.POSITIVE_INFINITY })).toBe(
      "0123456789",
    );
  });
});

describe("formatReadWindowMarker", () => {
  it("标注格式稳定", () => {
    expect(formatReadWindowMarker(700, 200, 300, 1000)).toBe(
      "[... omitted 700 chars, offset=200 limit=300 of 1000 total ...]",
    );
  });
});
