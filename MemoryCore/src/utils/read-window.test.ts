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

// ---------------------------------------------------------------------------
// P2（2026-10-30 交叉评审修复）：切片端点对齐码点边界。
// 切片 start/end 落在 UTF-16 代理对中间时向外扩到码点边界（start 左移 / end 右移，
// 宁可多给字符也不产生孤立代理项）；标注中的 offset/limit 反映外扩后实际生效的窗口。
// ---------------------------------------------------------------------------

/** 检查字符串是否含孤立代理项（被拆散的 UTF-16 代理对的一半）。 */
function hasOrphanSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      const prev = i > 0 ? s.charCodeAt(i - 1) : 0;
      if (!(prev >= 0xd800 && prev <= 0xdbff)) return true;
    }
  }
  return false;
}

/** 去掉末尾截断标注行（本语料不含换行，切片与标注以 "\n" 分隔）。 */
function stripMarker(out: string): string {
  return out.split("\n[... omitted")[0];
}

const EMOJI = "a👍b🎉c"; // 7 个 UTF-16 码元：a, 👍(2), b, 🎉(2), c

describe("applyReadWindow 码点边界（P2：代理对中间切分向外扩，不产生孤立代理项）", () => {
  it("start 落在 👍 中间（offset=2）：左扩到码点边界", () => {
    expect(applyReadWindow(EMOJI, { offset: 2, limit: 1 })).toBe(
      "👍\n[... omitted 5 chars, offset=1 limit=2 of 7 total ...]",
    );
  });

  it("end 落在 👍 中间（offset=1 limit=1）：右扩到码点边界", () => {
    expect(applyReadWindow(EMOJI, { offset: 1, limit: 1 })).toBe(
      "👍\n[... omitted 5 chars, offset=1 limit=2 of 7 total ...]",
    );
  });

  it("end 落在 👍 中间（offset=0 limit=2）：右扩到码点边界", () => {
    expect(applyReadWindow(EMOJI, { offset: 0, limit: 2 })).toBe(
      "a👍\n[... omitted 4 chars, offset=0 limit=3 of 7 total ...]",
    );
  });

  it("start 落在 🎉 中间（offset=5 limit=1）：左扩到码点边界", () => {
    expect(applyReadWindow(EMOJI, { offset: 5, limit: 1 })).toBe(
      "🎉\n[... omitted 5 chars, offset=4 limit=2 of 7 total ...]",
    );
  });

  it("窗口含完整 👍 且 end 拆 🎉（offset=1 limit=4）：end 右扩", () => {
    // "👍b🎉" = 5 个 UTF-16 码元（2+1+2），omitted = 7 - 5 = 2
    expect(applyReadWindow(EMOJI, { offset: 1, limit: 4 })).toBe(
      "👍b🎉\n[... omitted 2 chars, offset=1 limit=5 of 7 total ...]",
    );
  });

  it("end 拆 🎉（offset=3 limit=2）：右扩一个码元", () => {
    expect(applyReadWindow(EMOJI, { offset: 3, limit: 2 })).toBe(
      "b🎉\n[... omitted 4 chars, offset=3 limit=3 of 7 total ...]",
    );
  });

  it("limit=0：空窗口不外扩，标注反映请求窗口", () => {
    expect(applyReadWindow(EMOJI, { offset: 2, limit: 0 })).toBe(
      "[... omitted 7 chars, offset=2 limit=0 of 7 total ...]",
    );
  });

  it("右扩抵达文件尾时视为未截断：不追加标注（a👍 limit=2 → 全文）", () => {
    expect(applyReadWindow("a👍", { offset: 0, limit: 2 })).toBe("a👍");
  });

  it("端点未落在代理对中间时行为不变（offset=6 limit=1 → c）", () => {
    expect(applyReadWindow(EMOJI, { offset: 6, limit: 1 })).toBe(
      "c\n[... omitted 6 chars, offset=6 limit=1 of 7 total ...]",
    );
  });

  it("源本身含孤立代理（退化输入）时按码元原样切片、不崩", () => {
    expect(applyReadWindow("\uD800x", { offset: 0, limit: 1 })).toBe(
      "\uD800\n[... omitted 1 chars, offset=0 limit=1 of 2 total ...]",
    );
  });

  for (let offset = 0; offset <= EMOJI.length + 1; offset++) {
    for (const limit of [0, 1, 2, 3, 4, 5, undefined]) {
      it(`矩阵 offset=${offset} limit=${limit ?? "缺省"}：无孤立代理项，且覆盖原始请求切片`, () => {
        const out = applyReadWindow(EMOJI, { offset, limit });
        expect(hasOrphanSurrogate(out)).toBe(false);
        // 外扩语义：返回切片必须是「不外扩切片」的超集（宁可多给不拆对）。
        const start0 = Math.max(0, Math.min(offset, EMOJI.length));
        const end0 = Math.min(EMOJI.length, start0 + (limit ?? EMOJI.length - start0));
        expect(stripMarker(out)).toContain(EMOJI.slice(start0, end0));
      });
    }
  }
});
