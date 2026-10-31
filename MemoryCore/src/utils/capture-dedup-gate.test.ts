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
      expect(d).toEqual({
        shortcircuited: true,
        matchedId: "m_123",
        fingerprint: expect.any(String),
        heatId: "m_123", // 在案命中携带热度 id；pending/持久命中不携带（不推 L1 热度）
      });
    }
  });

  it("部分未命中 → 放行 + 消息级排除命中项（新内容零误杀；v2 持久门语义）", () => {
    const gate = new CaptureDedupGate();
    gate.seedFromArchive([{ id: "m_1", content: "旧记忆甲" }]);
    expect(
      gate.evaluate([{ content: "旧记忆甲" }, { content: "全新的一句" }]),
    ).toEqual({ shortcircuited: false, excluded: [0] });
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
    expect(d).toEqual({
      shortcircuited: true,
      matchedId: "m_real",
      fingerprint: expect.any(String),
      heatId: "m_real",
    });
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

// ── v2（复核修复轮）：分容器 + 水位增量种子 + 持久 L0 近窗 + 消息级语义 ──

describe("CaptureDedupGate v2·分容器（P1-1 窗口饥饿修复）", () => {
  const BIG = 250; // > CAPTURE_DEDUP_WINDOW(200)：复现在役 L1=2,336≫200 的规模关系

  it("大库（archive>window）全量再种子后，连发二过闸仍短路（旧实现 pending 被挤掉→放行）", () => {
    const gate = new CaptureDedupGate();
    const bigLib = Array.from({ length: BIG }, (_, i) => ({ id: `m_${i}`, content: `在案记忆第${i}条内容` }));
    expect(gate.evaluate([{ content: "大库连发新内容甲" }]).shortcircuited).toBe(false); // 放行→pending
    gate.seedFromArchive(bigLib); // 旧实现：200 窗口环被 250 条种子清场，pending 占位被淘汰
    expect(gate.evaluate([{ content: "大库连发新内容甲" }]).shortcircuited).toBe(true);
    gate.seedFromArchive(bigLib); // 再来一轮全量再种子（旧装配点每批行为）
    expect(gate.evaluate([{ content: "大库连发新内容甲" }]).shortcircuited).toBe(true);
  });

  it("三过闸：每批之间都全量再种子，短路不退化（收敛声明在产线规模成立）", () => {
    const gate = new CaptureDedupGate();
    const bigLib = Array.from({ length: BIG }, (_, i) => ({ id: `m_${i}`, content: `库条目${i}` }));
    for (let round = 0; round < 3; round++) {
      gate.seedFromArchive(bigLib);
      expect(gate.evaluate([{ content: "跨轮重投内容" }]).shortcircuited).toBe(round > 0);
    }
  });

  it("pending 环按自身 windowSize 独立淘汰，种子进入不占 pending 容量（无重复计数）", () => {
    const gate = new CaptureDedupGate(3);
    gate.seedFromArchive([{ id: "m_a", content: "在案内容a" }]); // 进 archive 容器
    for (let i = 0; i < 5; i++) gate.evaluate([{ content: `pending环内容-${i}` }]);
    const stats = gate.stats();
    expect(stats.pending).toBe(3); // pending 环自身封顶
    expect(stats.archive).toBe(1); // 种子不与 pending 混装
    // 在案命中不受 pending 环淘汰影响
    expect(gate.evaluate([{ content: "在案内容a" }]).shortcircuited).toBe(true);
  });

  it("stats()：三分容器计数可观测（archive/persist/pending）", () => {
    const gate = new CaptureDedupGate();
    gate.seedFromArchive([{ id: "m_1", content: "甲" }]);
    gate.seedPersist([{ id: "l0_1", content: "乙", ts: Date.now() }]);
    gate.evaluate([{ content: "丙" }]);
    expect(gate.stats()).toEqual({ archive: 1, persist: 1, pending: 1 });
  });
});

describe("CaptureDedupGate v2·持久 L0 近窗（跨重启接住冗余重投）", () => {
  it("seedPersist：命中短路，matchedId=持久记录 id，不携带 heatId（非 L1 不推热度）", () => {
    const gate = new CaptureDedupGate();
    gate.seedPersist([{ id: "l0_abc", content: "上周捕获过的内容", ts: Date.now() - 3600_000 }]);
    const d = gate.evaluate([{ content: "上周捕获过的内容" }]);
    expect(d).toEqual({
      shortcircuited: true,
      matchedId: "l0_abc",
      fingerprint: expect.any(String),
    });
    expect((d as { heatId?: string }).heatId).toBeUndefined();
  });

  it("TTL：超过持久 TTL（默认 7 天）的条目不参与判定（过期=放行，零误杀）", () => {
    const gate = new CaptureDedupGate();
    gate.seedPersist([{ id: "l0_old", content: "八天前的内容", ts: Date.now() - 8 * 86400_000 }]);
    expect(gate.evaluate([{ content: "八天前的内容" }])).toEqual({ shortcircuited: false });
  });

  it("TTL 边界：恰好 TTL 内的条目仍命中", () => {
    const gate = new CaptureDedupGate();
    const now = 1_800_000_000_000;
    gate.seedPersist([{ id: "l0_edge", content: "边界内容", ts: now - 7 * 86400_000 + 1000 }]);
    expect(gate.evaluate([{ content: "边界内容" }], { now }).shortcircuited).toBe(true);
  });

  it("封顶：超过 persistCap 淘汰最旧条目（容量封顶，防无界）", () => {
    const gate = new CaptureDedupGate();
    const cap = (gate as unknown as { persistCap: number }).persistCap;
    const entries = Array.from({ length: cap + 10 }, (_, i) => ({
      id: `l0_${i}`,
      content: `持久近窗条目-${i}`,
      ts: Date.now() - 3600_000 + i, // 升序：最旧在前；近窗内不被 TTL 过期
    }));
    gate.seedPersist(entries);
    expect(gate.stats().persist).toBe(cap);
    // 最旧的 10 条被淘汰
    expect(gate.evaluate([{ content: "持久近窗条目-0" }]).shortcircuited).toBe(false);
    expect(gate.evaluate([{ content: `持久近窗条目-${cap + 9}` }]).shortcircuited).toBe(true);
  });

  it("畸形持久条目（空 id/不可指纹化/缺 ts）被跳过", () => {
    const gate = new CaptureDedupGate();
    gate.seedPersist([
      { id: "", content: "有内容无id", ts: Date.now() },
      { id: "l0_x", content: "！！？？", ts: Date.now() },
      { id: "l0_y", content: "正常内容", ts: Number.NaN },
    ]);
    expect(gate.stats().persist).toBe(0);
    expect(gate.evaluate([{ content: "有内容无id" }])).toEqual({ shortcircuited: false });
  });

  it("在案 id 优先于持久 id（同指纹两处都有：matchedId 报 L1 真实 id）", () => {
    const gate = new CaptureDedupGate();
    gate.seedPersist([{ id: "l0_first", content: "两处都有的内容", ts: Date.now() }]);
    gate.seedFromArchive([{ id: "m_l1", content: "两处都有的内容" }]);
    const d = gate.evaluate([{ content: "两处都有的内容" }]);
    expect((d as { matchedId: string }).matchedId).toBe("m_l1");
  });
});

describe("CaptureDedupGate v2·seedFromStore（全量一次 + 水位增量）", () => {
  /** 可录制的假 store：L1 文本 + 增量能力 + L0 近窗能力。 */
  function makeFakeStore(seed: {
    l1?: Array<{ record_id: string; content: string; updated_time: string }>;
    l0?: Array<{ record_id: string; message_text: string; timestamp: number }>;
  }) {
    const calls = { getAllL1Texts: 0, getL1TextsSince: [] as string[], getRecentL0Texts: [] as number[] };
    return {
      calls,
      getAllL1Texts: async () => {
        calls.getAllL1Texts++;
        return seed.l1 ?? [];
      },
      getL1TextsSince: async (since: string, _limit: number) => {
        calls.getL1TextsSince.push(since);
        return (seed.l1 ?? []).filter((r) => r.updated_time >= since);
      },
      getRecentL0Texts: async (afterTs: number, _limit: number) => {
        calls.getRecentL0Texts.push(afterTs);
        return (seed.l0 ?? []).filter((r) => r.timestamp >= afterTs);
      },
    };
  }

  it("首次全量（L1 全量 + L0 近窗一次），后续只增量（getAllL1Texts 不再被调）", async () => {
    const store = makeFakeStore({
      l1: [
        { record_id: "m_1", content: "在案甲", updated_time: "2026-10-30T00:00:00.000Z" },
        { record_id: "m_2", content: "在案乙", updated_time: "2026-10-31T00:00:00.000Z" },
      ],
      l0: [{ record_id: "l0_1", message_text: "昨日捕获内容", timestamp: Date.now() - 3600_000 }],
    });
    const gate = new CaptureDedupGate();
    await gate.seedFromStore(store);
    expect(gate.stats()).toEqual({ archive: 2, persist: 1, pending: 0 });
    // 全量种子后放行一条新内容 → pending
    expect(gate.evaluate([{ content: "首次种子后的新内容" }]).shortcircuited).toBe(false);

    await gate.seedFromStore(store); // 第二次捕获：增量
    expect(store.calls.getAllL1Texts).toBe(1); // 全量只此一次
    expect(store.calls.getL1TextsSince.length).toBe(1);
    expect(store.calls.getL1TextsSince[0]).toBe("2026-10-31T00:00:00.000Z"); // 水位=全量最大 updated_time
    expect(store.calls.getRecentL0Texts.length).toBe(2);
    // L0 水位单调非降（首拍=now-TTL 下界；有行后推进到最大行 ts，边界行幂等重种）
    expect(store.calls.getRecentL0Texts[1]).toBeGreaterThanOrEqual(store.calls.getRecentL0Texts[0]);
    // 增量种子不重复计数
    expect(gate.stats()).toEqual({ archive: 2, persist: 1, pending: 1 });
  });

  it("增量拾取：水位之后的 L1/L0 新行入容器并可命中", async () => {
    const data = {
      l1: [{ record_id: "m_1", content: "初始在案", updated_time: "2026-10-30T00:00:00.000Z" }],
      l0: [] as Array<{ record_id: string; message_text: string; timestamp: number }>,
    };
    const store = makeFakeStore(data);
    const gate = new CaptureDedupGate();
    await gate.seedFromStore(store);
    // 模拟时间推进：新增 L1 与 L0 行
    data.l1.push({ record_id: "m_2", content: "蒸馏新落库", updated_time: "2026-10-31T12:00:00.000Z" });
    data.l0.push({ record_id: "l0_9", message_text: "上一批放行的消息", timestamp: Date.now() });
    await gate.seedFromStore(store);
    expect(gate.stats().archive).toBe(2);
    expect(gate.stats().persist).toBe(1);
    expect(gate.evaluate([{ content: "蒸馏新落库" }]).shortcircuited).toBe(true);
    expect(gate.evaluate([{ content: "上一批放行的消息" }]).shortcircuited).toBe(true);
  });

  it("无增量能力的 store：回退每批全量 getAllL1Texts（行为同旧；pending 仍不被挤掉）", async () => {
    const store = {
      getAllL1Texts: async () => [
        { record_id: "m_1", content: "无能力库在案", updated_time: "2026-10-30T00:00:00.000Z" },
      ],
    };
    const gate = new CaptureDedupGate();
    await gate.seedFromStore(store);
    expect(gate.evaluate([{ content: "无能力库新内容" }]).shortcircuited).toBe(false);
    await gate.seedFromStore(store); // 第二批：全量回退
    expect(gate.evaluate([{ content: "无能力库新内容" }]).shortcircuited).toBe(true); // pending 存活
  });

  it("无 L0 近窗能力的 store：持久层静默缺席，pending/archive 照常", async () => {
    const store = {
      getAllL1Texts: async () => [{ record_id: "m_1", content: "仅L1库", updated_time: "2026-10-30T00:00:00.000Z" }],
    };
    const gate = new CaptureDedupGate();
    await gate.seedFromStore(store);
    expect(gate.stats()).toEqual({ archive: 1, persist: 0, pending: 0 });
  });

  it("getAllL1Texts 抛错 → seedFromStore 拒绝（装配点降级放行，既有契约）", async () => {
    const store = {
      getAllL1Texts: async () => {
        throw new Error("store read failed");
      },
    };
    const gate = new CaptureDedupGate();
    await expect(gate.seedFromStore(store)).rejects.toThrow("store read failed");
  });

  it("getRecentL0Texts 抛错 → 同样整体降级（fail-safe：放行零误杀，非致命）", async () => {
    const store = {
      getAllL1Texts: async () => [],
      getRecentL0Texts: async () => {
        throw new Error("l0 probe failed");
      },
    };
    const gate = new CaptureDedupGate();
    await expect(gate.seedFromStore(store)).rejects.toThrow("l0 probe failed");
  });

  it("pending 记账带 TTL：超过 24h 的占位过期放行（蒸馏失败后可重投）", () => {
    const gate = new CaptureDedupGate();
    const t0 = 1_800_000_000_000;
    expect(gate.evaluate([{ content: "当日新内容" }], { now: t0 }).shortcircuited).toBe(false);
    expect(gate.evaluate([{ content: "当日新内容" }], { now: t0 + 3600_000 }).shortcircuited).toBe(true);
    expect(gate.evaluate([{ content: "当日新内容" }], { now: t0 + 25 * 3600_000 }).shortcircuited).toBe(false);
  });
});
