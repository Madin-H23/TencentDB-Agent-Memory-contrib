/**
 * 票⑥（exp/p1-6-supersede-inval）纯模块测试：显式失效替代硬删。
 * 覆盖：标记判定（正常/半截/变体/行中）、行过滤（尾换行/全滤/逐字节）、
 * 失效字符计量、锚点多重集守卫、C 帽排除口径、重定位检查、码点边界、畸形输入。
 */
import { describe, expect, it } from "vitest";
import {
  ANCHOR_RE,
  checkAnchorPreservation,
  checkSceneCharCapWithSupersede,
  countSupersededChars,
  countSupersededLines,
  extractAnchorIds,
  filterSupersededLines,
  findUnrelocatedAnchors,
  isSupersededLine,
  supersedeDelta,
} from "./supersede.js";

const MARK = "[SUPERSEDED 2026-10-31T10:00:00.000Z]";

describe("isSupersededLine：行级失效判定", () => {
  it("标准标记行（ISO 时间 + 正文）", () => {
    expect(isSupersededLine(`${MARK} - [2026-10-22] 记忆ID: m_1787881381525_2eee472e 旧事实`)).toBe(true);
  });
  it("纯标记（无时间戳，方括号闭合）", () => {
    expect(isSupersededLine("[SUPERSEDED] 旧事实")).toBe(true);
  });
  it("冒号变体", () => {
    expect(isSupersededLine("[SUPERSEDED: 2026-10-31] 旧事实")).toBe(true);
  });
  it("允许前导空白", () => {
    expect(isSupersededLine(`  \t${MARK} x`)).toBe(true);
  });
  it("半截标记不判失效（[SUPERSEDE）", () => {
    expect(isSupersededLine("[SUPERSEDE 2026-10-31] x")).toBe(false);
  });
  it("变体词不判失效（[SUPERSEDED2 / [SUPERSEDED-FOO）", () => {
    expect(isSupersededLine("[SUPERSEDED2 x]")).toBe(false);
    expect(isSupersededLine("[SUPERSEDED-FOO] x")).toBe(false);
  });
  it("行中字样不判失效（前缀必须行首）", () => {
    expect(isSupersededLine(`正文引用 ${MARK} 不算`)).toBe(false);
  });
  it("空行/无标记行", () => {
    expect(isSupersededLine("")).toBe(false);
    expect(isSupersededLine("- [2026-10-22] 正常事实行")).toBe(false);
  });
  it("[DELETED] 标记不是失效行（文件级删除是另一机制）", () => {
    expect(isSupersededLine("[DELETED]")).toBe(false);
  });
});

describe("filterSupersededLines：read 默认过滤 / includeInvalidated 审计", () => {
  it("过滤失效行、保留其余（含锚点行）", () => {
    const content = ["## 核心叙事", `${MARK} - 旧批次事实 m_1787881381525_2eee472e`, "- 新事实 m_1788449899823_245dfba6"].join("\n");
    const out = filterSupersededLines(content);
    expect(out).toBe("## 核心叙事\n- 新事实 m_1788449899823_245dfba6");
  });
  it("includeInvalidated=true 原样逐字节返回（审计面）", () => {
    const content = `A\n${MARK} B\nC`;
    expect(filterSupersededLines(content, { includeInvalidated: true })).toBe(content);
  });
  it("无标记内容逐字节不变", () => {
    const content = "line1\r\nline2\n\nline4";
    expect(filterSupersededLines(content)).toBe(content);
  });
  it("全标记文件 → 空串（纯标记行畸形输入）", () => {
    const content = `${MARK} a\n[SUPERSEDED] b\n`;
    expect(filterSupersededLines(content)).toBe("");
  });
  it("空串输入 → 空串", () => {
    expect(filterSupersededLines("")).toBe("");
  });
  it("尾换行语义保留：标记行后仍有尾空行时输出保尾换行", () => {
    const content = `A\n${MARK} B\n`;
    expect(filterSupersededLines(content)).toBe("A\n");
  });
  it("首行标记被滤、其余保留", () => {
    const content = `${MARK} A\nB`;
    expect(filterSupersededLines(content)).toBe("B");
  });
  it("窗口残行（offset 落行中切掉前缀）不过滤——保守", () => {
    // 切片把 "[SUPERSED" 切掉，残行 "EDED 2026] A" 不构成前缀
    expect(filterSupersededLines("EDED 2026] A\nB")).toBe("EDED 2026] A\nB");
  });
  it("码点边界：星形字符（代理对）所在失效行整行过滤不劈", () => {
    const content = `A\n${MARK} 🌟事实🌟\nB`;
    const out = filterSupersededLines(content);
    expect(out).toBe("A\nB");
    for (const ch of out) expect(/\uD800-\uDFFF/.test(ch) === false || ch.codePointAt(0)! > 0xffff).toBe(true);
  });
  it("星形字符在保留行中原样不劈", () => {
    const content = `A 🌟 B\n${MARK} C`;
    const out = filterSupersededLines(content);
    expect(out).toBe("A 🌟 B");
    expect([...out].some((c) => c.codePointAt(0) === 0x1f31f)).toBe(true);
  });
});

describe("countSupersededLines / countSupersededChars：帽排除口径计量", () => {
  it("行数计数", () => {
    expect(countSupersededLines(`A\n${MARK} B\n[SUPERSEDED] C`)).toBe(2);
    expect(countSupersededLines("A\nB")).toBe(0);
    expect(countSupersededLines("")).toBe(0);
  });
  it("字符计量含行尾换行、末行无换行不加", () => {
    // 行1=A(1)+\n(1)，行2=MARK B（标记12+空格1+B=14）无尾换行
    const content = `A\n${MARK} B`;
    expect(countSupersededChars(content)).toBe(`${MARK} B`.length);
    expect(countSupersededChars(`${content}\n`)).toBe(`${MARK} B\n`.length);
  });
  it("CRLF：\r 计入失效行字符", () => {
    const content = `A\n${MARK} B\r\nC`;
    expect(countSupersededChars(content)).toBe(`${MARK} B\r\n`.length);
  });
  it("无标记 → 0", () => {
    expect(countSupersededChars("A\nB\n")).toBe(0);
  });
});

describe("extractAnchorIds：锚点多重集（与 l2-score ANCHOR_RE 同口径）", () => {
  it("多重集（重复 id 各计一次）", () => {
    const ids = extractAnchorIds("a m_1787881381525_2eee472e b m_1787881381525_2eee472e c");
    expect(ids).toEqual(["m_1787881381525_2eee472e", "m_1787881381525_2eee472e"]);
  });
  it("畸形锚点不匹配（位数不足/非 hex/无下划线段）", () => {
    expect(extractAnchorIds("m_1787881381525_2eee47 m_1787881381525_2eee472g m_123_2eee472e m_17878813815252eee472e")).toEqual([]);
  });
  it("与 scripts/l2-score.mjs 的 ANCHOR_RE 逐字同款", () => {
    expect(ANCHOR_RE.source).toBe("m_\\d{13}_[0-9a-f]{8}");
    expect(ANCHOR_RE.flags).toBe("g");
  });
  it("真实格式样本（毫秒时间戳 + 8hex）", () => {
    expect(extractAnchorIds("（记忆ID: m_1787883629890_3975354b / m_1787881381525_f889424f）")).toEqual([
      "m_1787883629890_3975354b",
      "m_1787881381525_f889424f",
    ]);
  });
});

describe("checkAnchorPreservation：行级保锚守卫（锚点行永不物理删除）", () => {
  const pre = "## 叙事\n- 旧事实 m_1787881381525_2eee472e\n- 另一行 m_1788449899823_245dfba6\n尾行无锚";

  it("新建文件（pre=null）→ 放行", () => {
    expect(checkAnchorPreservation(null, "任何内容")).toBeNull();
  });
  it("加 [SUPERSEDED] 前缀不算丢锚（id 保留）→ 放行", () => {
    const post = `## 叙事\n${MARK} - 旧事实 m_1787881381525_2eee472e\n- 另一行 m_1788449899823_245dfba6\n新内容`;
    expect(checkAnchorPreservation(pre, post)).toBeNull();
  });
  it("删锚点行 → anchor_loss_forbidden 结构化拒绝且不落盘", () => {
    const post = "## 叙事\n- 另一行 m_1788449899823_245dfba6\n新内容";
    const r = checkAnchorPreservation(pre, post);
    expect(r).not.toBeNull();
    expect(r!.error).toBe("anchor_loss_forbidden");
    expect(r!.lostCount).toBe(1);
    expect(r!.lost).toEqual(["m_1787881381525_2eee472e"]);
    expect(r!.hint).toContain("SUPERSEDED");
  });
  it("多重集丢失（pre 2 份 → post 1 份）→ 拒绝", () => {
    const p = "m_1787881381525_2eee472e\nm_1787881381525_2eee472e";
    const q = "x m_1787881381525_2eee472e x";
    const r = checkAnchorPreservation(p, q);
    expect(r?.lostCount).toBe(1);
  });
  it("pre 无锚 → 放行（无锚可失）", () => {
    expect(checkAnchorPreservation("纯叙事无锚点", "任意")).toBeNull();
  });
  it("pre 有锚 → post 全空（write 整体清空）→ 全部丢失样例封顶 5", () => {
    const p = ["m_1787881381525_2eee472e", "m_1787881381525_00000001", "m_1787881381525_00000002", "m_1787881381525_00000003", "m_1787881381525_00000004", "m_1787881381525_00000005", "m_1787881381525_00000006"].join("\n");
    const r = checkAnchorPreservation(p, "");
    expect(r?.lostCount).toBe(7);
    expect(r?.lost.length).toBe(5);
  });
  it("post 新增锚点不抵消 pre 丢失（多重集逐 id 比对）", () => {
    const p = "m_1787881381525_2eee472e";
    const q = "m_1788449899823_245dfba6";
    expect(checkAnchorPreservation(p, q)?.lostCount).toBe(1);
  });
});

describe("checkSceneCharCapWithSupersede：C 帽交互（失效段不计入后像帽）", () => {
  it("cap off（undefined/0/负）→ 放行", () => {
    expect(checkSceneCharCapWithSupersede(`${MARK} x`.repeat(1000), undefined)).toBeNull();
    expect(checkSceneCharCapWithSupersede(`${MARK} x`.repeat(1000), 0)).toBeNull();
    expect(checkSceneCharCapWithSupersede(`${MARK} x`.repeat(1000), -1)).toBeNull();
  });
  it("失效行多、活内容小 → 排除后放行（同内容原口径必超帽）", () => {
    const dead = Array.from({ length: 100 }, (_, i) => `${MARK} 旧事实行${i} m_1787881381525_2eee472e`).join("\n");
    const live = "live";
    const content = `${dead}\n${live}`;
    expect(checkSceneCharCapWithSupersede(content, 100)).toBeNull();
  });
  it("活内容超帽 → 拒绝体带排除口径 chars/supersededChars/supersededLines", () => {
    const dead = `${MARK} ${"x".repeat(500)}`;
    const live = "y".repeat(120);
    const content = `${dead}\n${live}`;
    const r = checkSceneCharCapWithSupersede(content, 100);
    expect(r).not.toBeNull();
    expect(r!.error).toBe("over_scene_char_cap");
    expect(r!.chars).toBe(120);
    expect(r!.cap).toBe(100);
    expect(r!.overflow).toBe(20);
    expect(r!.hint).toContain("compress");
    expect(r!.supersededLines).toBe(1);
    expect(r!.supersededChars).toBe(dead.length + 1);
  });
  it("恰好等于帽 → 放行", () => {
    const content = `${MARK} ${"x".repeat(50)}\n${"y".repeat(100)}`;
    expect(checkSceneCharCapWithSupersede(content, 100)).toBeNull();
  });
  it("无标记内容与原口径一致（等价性）", () => {
    const content = "z".repeat(150);
    const r = checkSceneCharCapWithSupersede(content, 100);
    expect(r?.chars).toBe(150);
    expect(r?.supersededChars).toBe(0);
    expect(r?.supersededLines).toBe(0);
  });
});

describe("supersedeDelta：metric=l2_supersede 的 value 口径", () => {
  it("pre=null（新建）+ post 2 失效行 → 2", () => {
    expect(supersedeDelta(null, `A\n${MARK} B\n[SUPERSEDED] C`)).toBe(2);
  });
  it("pre 1 → post 3 → +2", () => {
    expect(supersedeDelta(`A\n[SUPERSEDED] B`, `${MARK} X\n${MARK} Y\n[SUPERSEDED] Z\nA`)).toBe(2);
  });
  it("失效行被恢复（畸形）→ 负数照实返回", () => {
    expect(supersedeDelta(`${MARK} A\nB`, "B")).toBe(-1);
  });
  it("无变化 → 0", () => {
    expect(supersedeDelta("A\nB", "A\nB\nC")).toBe(0);
  });
});

describe("findUnrelocatedAnchors：[DELETED] 文件级重定位守卫", () => {
  it("全部重定位 → 空数组（放行删除）", () => {
    const dying = "- 事实A m_1787881381525_2eee472e\n- 事实B m_1788449899823_245dfba6";
    const others = [`合并目标\n${MARK} - 事实A m_1787881381525_2eee472e`, "其它场景 m_1788449899823_245dfba6"];
    expect(findUnrelocatedAnchors(dying, others)).toEqual([]);
  });
  it("部分未重定位 → 差集", () => {
    const dying = "m_1787881381525_2eee472e\nm_1788449899823_245dfba6";
    const others = ["m_1787881381525_2eee472e"];
    expect(findUnrelocatedAnchors(dying, others)).toEqual(["m_1788449899823_245dfba6"]);
  });
  it("多重集差（dying 2 份、他处 1 份）→ 缺 1 份", () => {
    const dying = "m_1787881381525_2eee472e m_1787881381525_2eee472e";
    const others = ["m_1787881381525_2eee472e"];
    expect(findUnrelocatedAnchors(dying, others)).toEqual(["m_1787881381525_2eee472e"]);
  });
  it("dying 无锚（纯叙事/[DELETED] 空文件）→ 空数组", () => {
    expect(findUnrelocatedAnchors("[DELETED]", [])).toEqual([]);
    expect(findUnrelocatedAnchors("纯叙事", [])).toEqual([]);
  });
  it("others 为空且 dying 有锚 → 全部未重定位", () => {
    expect(findUnrelocatedAnchors("m_1787881381525_2eee472e", [])).toEqual(["m_1787881381525_2eee472e"]);
  });
});
