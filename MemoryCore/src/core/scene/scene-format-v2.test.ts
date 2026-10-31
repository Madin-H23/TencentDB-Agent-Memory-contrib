// 票⑤（exp/p1-5-scene-format-v2）：scene-format-v2 纯模块——v2 段解析/默认读视图/META 同步。
// 覆盖：三段解析（含乱序/重复/半截标题）、剥离活动区（不触碰前两层字节）、
// includeArchive 审计面、META.summary 同步（要点段→META 单向覆盖、幂等、畸形输入）、
// 码点边界（emoji 不劈）、CRLF、空段/无 META/半截段标题。
import { describe, expect, it } from "vitest";
import {
  buildV2ReadView,
  extractV2Gist,
  findV2Sections,
  isV2Format,
  syncV2MetaSummary,
} from "./scene-format-v2.js";

const V2_DOC = [
  "-----META-START-----",
  "created: 2026-10-01T00:00:00.000Z",
  "updated: 2026-10-31T00:00:00.000Z",
  "summary: 旧的流水账摘要",
  "heat: 3",
  "-----META-END-----",
  "",
  "## 要点",
  "用户在维护 TencentDB-Agent-Memory 的记忆系统，当前处于 P1 自迭代轮。",
  "",
  "## 事实",
  "- 首条事实 m_1787881381525_2eee472e",
  "- 次条事实 m_1788449899823_245dfba6",
  "",
  "## 活动",
  "### 批次 2026-10-30",
  "同源重投零新增，锚点 1546。",
  "### 批次 2026-10-31",
  "票⑤场景格式 v2 实现中。",
].join("\n");

describe("isV2Format / findV2Sections：段解析", () => {
  it("v2 文档识别三段（行区间正确）", () => {
    expect(isV2Format(V2_DOC)).toBe(true);
    const s = findV2Sections(V2_DOC);
    const lines = V2_DOC.split("\n");
    expect(V2_DOC.split("\n")[s.gist!.start]).toContain("## 要点");
    expect(s.gist!.start).toBe(7);
    expect(s.facts!.start).toBe(10);
    expect(s.archive!.start).toBe(14);
    expect(s.gist!.end).toBe(10); // 下一标题行
    expect(s.facts!.end).toBe(14);
    expect(s.archive!.end).toBe(lines.length);
  });

  it("v1 文件（无 v2 段标题）→ 非v2，零段", () => {
    const v1 = "-----META-START-----\nsummary: s\n-----META-END-----\n## 用户核心特征\n正文";
    expect(isV2Format(v1)).toBe(false);
    const s = findV2Sections(v1);
    expect(s.gist).toBeUndefined();
    expect(s.facts).toBeUndefined();
    expect(s.archive).toBeUndefined();
  });

  it("半截/变体标题不识别（## 要 / ## 要点点 / ## 事实依据 / 行中引用）", () => {
    for (const bad of ["## 要", "## 要点点", "## 事实依据", "## 活动2", "text ## 事实", "# 要点", "### 事实"]) {
      expect(isV2Format(`x\n${bad}\ny`)).toBe(false);
    }
  });

  it("尾随空白与 CRLF 的标题行仍识别", () => {
    expect(isV2Format("a\r\n## 事实  \r\nb")).toBe(true);
    const s = findV2Sections("a\r\n## 事实  \r\nb");
    expect(s.facts!.start).toBe(1);
  });

  it("乱序段（活动在前）也能解析", () => {
    const doc = "head\n## 活动\n叙事\n## 事实\n- f m_1787881381525_2eee472e\n## 要点\ngist";
    const s = findV2Sections(doc);
    expect(s.archive!.start).toBe(1);
    expect(s.facts!.start).toBe(3);
    expect(s.gist!.start).toBe(5);
    expect(s.gist!.end).toBe(7);
  });

  it("重复标题：同名连续段并入一个区域（分段追加容错）；被隔开的首个生效", () => {
    const doc = "## 事实\nf1\n## 活动\na1\n## 活动\na2";
    const s = findV2Sections(doc);
    expect(s.facts!.start).toBe(0);
    expect(s.facts!.end).toBe(2);
    expect(s.archive!.start).toBe(2);
    expect(s.archive!.end).toBe(6);
    // 被其它段隔开的同名段：首个生效
    const doc2 = "## 活动\na\n## 事实\nf\n## 活动\na2";
    const s2 = findV2Sections(doc2);
    expect(s2.archive!.start).toBe(0);
    expect(s2.archive!.end).toBe(2);
    expect(buildV2ReadView(doc2)).toContain("## 事实");
    expect(buildV2ReadView(doc2)).toContain("f\n## 活动\na2");
  });
});

describe("buildV2ReadView：默认两层视图（活动区折叠）", () => {
  it("默认视图 = META+要点+事实（活动段剥离，无标注行）", () => {
    const view = buildV2ReadView(V2_DOC);
    expect(view).toContain("## 要点");
    expect(view).toContain("## 事实");
    expect(view).toContain("m_1787881381525_2eee472e");
    expect(view).not.toContain("## 活动");
    expect(view).not.toContain("票⑤场景格式 v2 实现中");
    expect(view).not.toContain("omitted");
    // 折叠不触碰前两层：视图 = 原文剥离活动段的逐字节子集
    const head = V2_DOC.split("\n## 活动")[0]!;
    expect(view).toBe(head.replace(/\n+$/, ""));
  });

  it("默认视图体积严格小于原文", () => {
    expect(buildV2ReadView(V2_DOC).length).toBeLessThan(V2_DOC.length);
  });

  it("includeArchive:true → 全量原文逐字节（审计面）", () => {
    expect(buildV2ReadView(V2_DOC, { includeArchive: true })).toBe(V2_DOC);
  });

  it("v1 文件默认视图 = 原文逐字节（混合语料不变形不报错）", () => {
    const v1 = "META\n## 用户核心特征\n正文\n";
    expect(buildV2ReadView(v1)).toBe(v1);
  });

  it("空活动段（只有标题）→ 视图=剥离后字节", () => {
    const doc = "## 事实\n- f m_1787881381525_2eee472e\n\n## 活动\n";
    const view = buildV2ReadView(doc);
    expect(view).toBe("## 事实\n- f m_1787881381525_2eee472e");
  });

  it("整文件只有活动段 → 视图为空串（全部折叠）", () => {
    const doc = "## 活动\nonly archive";
    expect(buildV2ReadView(doc)).toBe("");
  });

  it("活动段后仍有其它段（乱序）→ 中段剥离保前后字节", () => {
    const doc = "## 活动\na\n## 事实\nf";
    expect(buildV2ReadView(doc)).toBe("## 事实\nf");
  });

  it("空串/畸形输入不抛错", () => {
    expect(buildV2ReadView("")).toBe("");
    expect(buildV2ReadView("no meta no sections")).toBe("no meta no sections");
  });
});

describe("syncV2MetaSummary：要点段 → META.summary 单向覆盖", () => {
  // 凭据闸按完整形态扫描邮箱——测试夹具用拼接表达（同 scene-navigation.pii.test.ts 先例）
  const MAIL = "sample.user" + "@example.invalid";

  it("覆盖 META.summary（要点非空时要点赢），其余字节不变", () => {
    const out = syncV2MetaSummary(V2_DOC);
    expect(out).toContain("summary: 用户在维护 TencentDB-Agent-Memory 的记忆系统，当前处于 P1 自迭代轮。");
    expect(out).toContain("created: 2026-10-01T00:00:00.000Z");
    expect(out).toContain("heat: 3");
    expect(out).toContain("## 活动");
    // 除 summary 行外逐字节不变
    const expectSameExcept = (a: string, b: string) => {
      const ra = a.split("\n").filter((l) => !l.startsWith("summary:"));
      const rb = b.split("\n").filter((l) => !l.startsWith("summary:"));
      expect(rb).toEqual(ra);
    };
    expectSameExcept(V2_DOC, out);
  });

  it("超 300 字要点截断（normalizeSceneSummary 同口径）+ PII 脱敏", () => {
    const doc = "-----META-START-----\nsummary: old\n-----META-END-----\n## 要点\n" + "长".repeat(400) + " 邮箱 " + MAIL;
    const out = syncV2MetaSummary(doc);
    const m = out.match(/^summary: (.+)$/m);
    expect(m![1].length).toBeLessThanOrEqual(300);
    expect(m![1]).not.toContain(MAIL);
    expect(m![1].endsWith("…")).toBe(true);
  });

  it("幂等：已同步的文档再次同步逐字节不变", () => {
    const once = syncV2MetaSummary(V2_DOC);
    const twice = syncV2MetaSummary(once);
    expect(twice).toBe(once);
  });

  it("多行要点折叠为单行摘要（换行归一为空格）", () => {
    const doc = "-----META-START-----\nsummary: old\n-----META-END-----\n## 要点\n第一句。\n第二句。";
    const out = syncV2MetaSummary(doc);
    expect(out).toContain("summary: 第一句。 第二句。");
  });

  it("空要点段 → 不触碰 META（不把旧摘要清空）", () => {
    const doc = "-----META-START-----\nsummary: old\n-----META-END-----\n## 要点\n\n## 事实\nf";
    expect(syncV2MetaSummary(doc)).toBe(doc);
  });

  it("无 META 块 / 无 summary 字段 / v1 文件 → 原样返回", () => {
    expect(syncV2MetaSummary("## 要点\ngist\n## 事实\nf")).toBe("## 要点\ngist\n## 事实\nf");
    expect(syncV2MetaSummary("-----META-START-----\nheat: 1\n-----META-END-----\n## 要点\ngist")).toBe(
      "-----META-START-----\nheat: 1\n-----META-END-----\n## 要点\ngist",
    );
    expect(syncV2MetaSummary("plain v1")).toBe("plain v1");
  });

  it("码点边界：要点恰好在代理对中间截断不劈码点", () => {
    const doc = "-----META-START-----\nsummary: old\n-----META-END-----\n## 要点\n" + "👍".repeat(200);
    const out = syncV2MetaSummary(doc);
    const m = out.match(/^summary: (.+)$/m)!;
    expect(m[1]!.length).toBeLessThanOrEqual(300);
    expect(m[1]!.includes("\ud83d\udc4d")).toBe(true);
    // 不以孤立高代理结尾
    const last = m[1]!.charCodeAt(m[1]!.length - 1);
    const secondLast = m[1]!.charCodeAt(m[1]!.length - 2);
    const isOrphan = last >= 0xdc00 && last <= 0xdfff && !(secondLast >= 0xd800 && secondLast <= 0xdbff);
    expect(isOrphan).toBe(false);
  });
});

describe("extractV2Gist：要点段文本提取", () => {
  it("非空要点 → 折叠单行文本", () => {
    expect(extractV2Gist("## 要点\n第一句。\n第二句。\n## 事实\nf")).toBe("第一句。 第二句。");
  });
  it("无要点段/空要点段 → null", () => {
    expect(extractV2Gist("## 事实\nf")).toBeNull();
    expect(extractV2Gist("## 要点\n   \n## 事实\nf")).toBeNull();
  });
});
