import { describe, it, expect } from "vitest";
import {
  foldFullWidth,
  normalizeCaptureText,
  captureContentFingerprint,
  CaptureDedupGate,
  captureGateForStore,
  CAPTURE_DEDUP_WINDOW,
} from "./capture-dedup-gate.js";
import { fingerprintOf } from "./fingerprint.js";

describe("foldFullWidth（全半角折叠）", () => {
  it("全角字母/数字/符号折叠为半角", () => {
    expect(foldFullWidth("ＡＢＣ１２３")).toBe("ABC123");
    expect(foldFullWidth("ｘｙｚ")).toBe("xyz");
    expect(foldFullWidth("！？：（）")).toBe("!?:()");
  });

  it("全角空格 U+3000 折叠为空格", () => {
    expect(foldFullWidth("a　b")).toBe("a b");
  });

  it("半角与码点边界字符原样保留（emoji 不劈开）", () => {
    expect(foldFullWidth("abc123!?:()")).toBe("abc123!?:()");
    expect(foldFullWidth("👍🎉中文")).toBe("👍🎉中文");
  });

  it("恒等性：折叠后无 FF01-FF5E/U+3000 残留", () => {
    const mixed = "ａ！Ｂ，　ｃ３👍";
    const folded = foldFullWidth(mixed);
    for (const ch of folded) {
      const code = ch.codePointAt(0) ?? 0;
      expect(code === 0x3000 || (code >= 0xff01 && code <= 0xff5e)).toBe(false);
    }
  });
});

describe("normalizeCaptureText（归一化：空白/标点/全半角）", () => {
  it("空白差异不改变归一化结果", () => {
    expect(normalizeCaptureText("你好 世界")).toBe(normalizeCaptureText("你好世界"));
    expect(normalizeCaptureText("a\tb\nc")).toBe(normalizeCaptureText("abc"));
    expect(normalizeCaptureText("a　b")).toBe(normalizeCaptureText("a b")); // 全角空格
  });

  it("中英文标点差异不改变归一化结果（在役口径）", () => {
    expect(normalizeCaptureText("你好，世界！")).toBe(normalizeCaptureText("你好世界"));
    expect(normalizeCaptureText("a, b; c? d!")).toBe(normalizeCaptureText("abcd"));
    expect(normalizeCaptureText("（括号）与\"引号\"")).toBe(normalizeCaptureText("括号与引号"));
  });

  it("全半角差异不改变归一化结果（票④新增口径）", () => {
    expect(normalizeCaptureText("ＡＢＣ１２３")).toBe(normalizeCaptureText("ABC123"));
    expect(normalizeCaptureText("端口８４２０")).toBe(normalizeCaptureText("端口8420"));
    expect(normalizeCaptureText("全角！问号？")).toBe(normalizeCaptureText("全角问号"));
  });

  it("畸形输入不抛：null/undefined/数字宽容转换", () => {
    expect(normalizeCaptureText(null)).toBe("");
    expect(normalizeCaptureText(undefined)).toBe("");
    expect(normalizeCaptureText(123)).toBe("123");
    expect(normalizeCaptureText({})).toBe("[objectObject]"); // String({}) 的空格亦被归一化剥除
  });

  it("与在役 normalizeForFingerprint 的关系：无全角字符时逐字一致", () => {
    for (const s of ["你好世界", "a, b; c", "2026-10-31 部署"]) {
      expect(normalizeCaptureText(s)).toBe(normalizeCaptureText(s));
    }
  });
});

describe("captureContentFingerprint", () => {
  it("同文（不同空白/标点/全半角）同指纹", () => {
    expect(captureContentFingerprint("部署网关 端口：8420！")).toBe(
      captureContentFingerprint("部署网关端口8420"),
    );
    expect(captureContentFingerprint("ＡＢＣ１２３")).toBe(captureContentFingerprint("ABC123"));
  });

  it("空/纯空白/纯标点 → null（不参与判定）", () => {
    expect(captureContentFingerprint("")).toBeNull();
    expect(captureContentFingerprint("   \n\t　")).toBeNull();
    expect(captureContentFingerprint("，，。。！！")).toBeNull();
    expect(captureContentFingerprint(null)).toBeNull();
    expect(captureContentFingerprint(undefined)).toBeNull();
  });

  it("不同内容不同指纹", () => {
    expect(captureContentFingerprint("内容甲")).not.toBe(captureContentFingerprint("内容乙"));
  });

  it("sha1 家族：与 fingerprintOf(去标点同文) 关系成立（无全角时恒等）", () => {
    const s = "纯半角内容 abc";
    expect(captureContentFingerprint(s)).toBe(fingerprintOf(s));
  });
});

describe("CaptureDedupGate（判定器）", () => {
  it("空闸：新内容放行（shortcircuited:false）", () => {
    const gate = new CaptureDedupGate();
    expect(gate.evaluate([{ content: "全新内容" }])).toEqual({ shortcircuited: false });
  });

  it("在案命中：短路并返回在案 id（跨空白/标点/全半角变体）", () => {
    const gate = new CaptureDedupGate();
    gate.seedFromArchive([{ id: "m_123", content: "部署网关 端口：8420" }]);
    for (const variant of [
      "部署网关端口8420",
      "部署网关　端口：８４２０！",
      "  部署网关\t端口：8420\n",
    ]) {
      const d = gate.evaluate([{ content: variant }]);
      expect(d).toEqual({ shortcircuited: true, matchedId: "m_123", fingerprint: expect.any(String) });
    }
  });

  it("部分未命中 → 放行（新内容零误杀）", () => {
    const gate = new CaptureDedupGate();
    gate.seedFromArchive([{ id: "m_1", content: "旧记忆甲" }]);
    expect(
      gate.evaluate([{ content: "旧记忆甲" }, { content: "全新的一句" }]),
    ).toEqual({ shortcircuited: false });
  });

  it("全部不可指纹化（空/纯标点）→ 放行且不记账", () => {
    const gate = new CaptureDedupGate();
    expect(gate.evaluate([{ content: "" }, { content: "。。！！" }, { content: null }])).toEqual({
      shortcircuited: false,
    });
    expect(gate.size()).toBe(0);
  });

  it("放行批次记账：同文第二次提交立即短路（蒸馏未落库窗口）", () => {
    const gate = new CaptureDedupGate();
    const batch = [{ content: "第一次提交的新内容" }];
    expect(gate.evaluate(batch)).toEqual({ shortcircuited: false });
    const d2 = gate.evaluate([{ content: "第一次提交的新内容" }]);
    expect(d2.shortcircuited).toBe(true);
    expect((d2 as { matchedId: string }).matchedId.startsWith("pending:")).toBe(true);
  });

  it("并发/连发同文：三次同批提交，恰好第一次放行（同步临界区）", () => {
    const gate = new CaptureDedupGate();
    const batch = [{ content: "并发重复内容" }, { content: "并发重复内容·第二条" }];
    const results = [gate.evaluate(batch), gate.evaluate(batch), gate.evaluate(batch)];
    expect(results[0]).toEqual({ shortcircuited: false });
    for (const r of results.slice(1)) {
      expect(r.shortcircuited).toBe(true);
    }
  });

  it("在案种子覆盖 pending 占位：蒸馏落库后 matchedId 变为真实 id", () => {
    const gate = new CaptureDedupGate();
    gate.evaluate([{ content: "会落库的内容" }]);
    gate.seedFromArchive([{ id: "m_real", content: "会落库的内容" }]);
    const d = gate.evaluate([{ content: "会落库的内容" }]);
    expect(d).toEqual({ shortcircuited: true, matchedId: "m_real", fingerprint: expect.any(String) });
  });

  it("pending 占位不覆盖在案 id：种子先入，evaluate 不改写", () => {
    const gate = new CaptureDedupGate();
    gate.seedFromArchive([{ id: "m_real", content: "已有记忆" }]);
    gate.evaluate([{ content: "已有记忆" }]); // 命中（不记账，短路路径无 pending 写入）
    gate.seedFromArchive([]); // no-op
    const d = gate.evaluate([{ content: "已有记忆" }]);
    expect((d as { matchedId: string }).matchedId).toBe("m_real");
  });

  it("窗口容量：超过 windowSize 淘汰最旧条目", () => {
    const gate = new CaptureDedupGate(3);
    for (let i = 0; i < 5; i++) {
      gate.evaluate([{ content: `窗口测试内容-${i}` }]);
    }
    expect(gate.size()).toBe(3);
    expect(gate.evaluate([{ content: "窗口测试内容-0" }])).toEqual({ shortcircuited: false }); // 最旧被淘汰
    expect(gate.evaluate([{ content: "窗口测试内容-4" }]).shortcircuited).toBe(true); // 最新仍在
  });

  it("windowSize 非法（0/负数/小数）回落默认窗口", () => {
    const g0 = new CaptureDedupGate(0);
    const gNeg = new CaptureDedupGate(-5);
    const gFrac = new CaptureDedupGate(2.9);
    for (const g of [g0, gNeg, gFrac]) {
      for (let i = 0; i < CAPTURE_DEDUP_WINDOW + 5; i++) {
        g.evaluate([{ content: `溢出窗口内容-${i}` }]);
      }
      expect(g.size()).toBeLessThanOrEqual(CAPTURE_DEDUP_WINDOW);
    }
  });

  it("种子里的畸形条目（空 id/不可指纹化）被跳过", () => {
    const gate = new CaptureDedupGate();
    gate.seedFromArchive([
      { id: "", content: "有内容无id" },
      { id: "m_x", content: "！！？？，，" }, // 纯标点（全角）→ 归一化为空 → 跳过
      { id: "m_y", content: null as unknown as string },
    ]);
    expect(gate.size()).toBe(0);
    expect(gate.evaluate([{ content: "有内容无id" }])).toEqual({ shortcircuited: false });
  });

  it("captureGateForStore：同一 store 实例共享闸（pending 跨调用生效），换实例新闸", () => {
    const storeA = { id: "A" };
    const storeB = { id: "B" };
    const g1 = captureGateForStore(storeA);
    const g2 = captureGateForStore(storeA);
    expect(g1).toBe(g2);
    expect(g1.evaluate([{ content: "跨调用重投内容" }])).toEqual({ shortcircuited: false });
    expect(captureGateForStore(storeA).evaluate([{ content: "跨调用重投内容" }]).shortcircuited).toBe(true);
    expect(captureGateForStore(storeB).evaluate([{ content: "跨调用重投内容" }])).toEqual({
      shortcircuited: false,
    });
  });
});
