// 票⑨（exp/p1-9-scene-v2-migration）：toV2Format 惰性迁移纯函数。
// 覆盖：v1/批次格式 → 三层结构、锚点多重集逐字节不变（lost=0）、幂等、
// META 缺失/畸形原样返回、已有 `## 活动` 不重复建段、v2 输入原样、
// 中文/emoji、空文件/仅 META、标题降级、CRLF、PII/300 字预算。
import { describe, expect, it } from "vitest";
import { isV2Format, toV2Format } from "./scene-format-v2.js";
import { ANCHOR_RE, checkAnchorPreservation, extractAnchorIds } from "../../utils/supersede.js";

const META = [
  "-----META-START-----",
  "created: 2026-08-28T01:44:31.671Z",
  "updated: 2026-10-29T09:18:10.943Z",
  "summary: 用户在维护记忆系统，当前聚焦 v2 迁移与帽压力治理。",
  "heat: 244",
  "-----META-END-----",
].join("\n");

const V1_BATCH = [
  META,
  "",
  "## ★10-29 09:18Z 本批 —— 运行更新",
  "",
  "- **★实跑闭环（记忆ID: m_1793265391167_4a35e058）**：完成日报生成。",
  "- **★同源重投复验（零新增）**：15 条旧记忆同源复验。",
  "- 过程叙事：先检查然后执行。",
  "",
  "## ★10-28 02:36Z 本批 —— 另一批",
  "",
  "### 子段落",
  "- 旧事实 m_1793153662241_0c722b76 仍在。",
].join("\n");

/** 锚点多重集（逐 id 计数，顺序保留）——与保锚守卫同口径。 */
function anchorMultiset(s: string): string[] {
  return s.match(ANCHOR_RE) ?? [];
}

describe("toV2Format：v1/批次格式 → 三层结构", () => {
  it("三段按序生成；要点取 META.summary；事实=锚点行；活动=其余叙事（H2 降为 H3）", () => {
    const out = toV2Format(V1_BATCH);
    const gistAt = out.indexOf("## 要点");
    const factsAt = out.indexOf("## 事实");
    const archiveAt = out.indexOf("## 活动");
    expect(gistAt).toBeGreaterThan(out.indexOf("-----META-END-----"));
    expect(factsAt).toBeGreaterThan(gistAt);
    expect(archiveAt).toBeGreaterThan(factsAt);

    expect(out).toContain("## 要点\n用户在维护记忆系统，当前聚焦 v2 迁移与帽压力治理。");
    // 事实段：两条锚点行逐行原样、保序
    const factsBlock = out.slice(factsAt, archiveAt);
    expect(factsBlock).toContain("- **★实跑闭环（记忆ID: m_1793265391167_4a35e058）**：完成日报生成。");
    expect(factsBlock).toContain("- 旧事实 m_1793153662241_0c722b76 仍在。");
    expect(factsBlock.indexOf("m_1793265391167_4a35e058")).toBeLessThan(
      factsBlock.indexOf("m_1793153662241_0c722b76"),
    );
    // 活动段：批次标题降级，非锚点叙事保留
    const archiveBlock = out.slice(archiveAt);
    expect(archiveBlock).toContain("### ★10-29 09:18Z 本批 —— 运行更新");
    expect(archiveBlock).toContain("### ★10-28 02:36Z 本批 —— 另一批");
    expect(archiveBlock).toContain("- **★同源重投复验（零新增）**：15 条旧记忆同源复验。");
    expect(archiveBlock).toContain("- 过程叙事：先检查然后执行。");
    expect(archiveBlock).not.toContain("实跑闭环"); // 锚点行不重复留在活动段
  });

  it("硬不变量：锚点出现次数与唯一集合与输入完全一致（lost=0）", () => {
    const out = toV2Format(V1_BATCH);
    expect(anchorMultiset(out)).toEqual(anchorMultiset(V1_BATCH));
    expect(new Set(anchorMultiset(out))).toEqual(new Set(anchorMultiset(V1_BATCH)));
    expect(checkAnchorPreservation(V1_BATCH, out)).toBeNull();
    expect(extractAnchorIds(out)).toHaveLength(2);
  });

  it("摘要内锚点：重投影进要点允许计数盈余，但零丢失且唯一集合一致", () => {
    const raw = [
      "-----META-START-----",
      "summary: 本轮完成 A（记忆ID: m_1787881381525_2eee472e）",
      "-----META-END-----",
      "## 批次",
      "- 事实二 m_1788449899823_245dfba6",
    ].join("\n");
    const out = toV2Format(raw);
    const before = anchorMultiset(raw);
    const after = anchorMultiset(out);
    expect(before).toHaveLength(2);
    expect(after).toHaveLength(3); // 摘要锚点在要点再投影一次
    expect(new Set(after)).toEqual(new Set(before));
    // 零丢失：逐 id 输出出现次数 ≥ 输入（checkAnchorPreservation 同口径）
    for (const id of new Set(before)) {
      expect(after.filter((x) => x === id).length).toBeGreaterThanOrEqual(
        before.filter((x) => x === id).length,
      );
    }
    expect(checkAnchorPreservation(raw, out)).toBeNull();
  });

  it("幂等：二次迁移逐字节不变", () => {
    const once = toV2Format(V1_BATCH);
    expect(toV2Format(once)).toBe(once);
    expect(isV2Format(once)).toBe(true);
  });

  it("META 块逐字节原样（含 created/updated/summary/heat 与前后缀）", () => {
    const out = toV2Format(V1_BATCH);
    expect(out.slice(0, META.length)).toBe(META);
  });

  it("已有 v2 文件：原样返回（幂等，不重排）", () => {
    const v2 = [
      META,
      "",
      "## 活动",
      "先放活动段。",
      "## 事实",
      "- f m_1787881381525_2eee472e",
      "## 要点",
      "gist",
    ].join("\n");
    expect(toV2Format(v2)).toBe(v2);
  });

  it("已有 `## 活动`（无其它 v2 段）→ 原样返回，不重复建段", () => {
    const onlyArchive = [META, "", "## 活动", "只有归档段。"].join("\n");
    const out = toV2Format(onlyArchive);
    expect(out).toBe(onlyArchive);
    expect(out.match(/^## 活动[ \t]*$/gm)).toHaveLength(1);
  });

  it("仅 META（无正文）→ 生成三段骨架，要点有值，事实/活动为空", () => {
    const out = toV2Format(META);
    expect(out).toContain("## 要点\n用户在维护记忆系统，当前聚焦 v2 迁移与帽压力治理。");
    expect(out).toContain("## 事实");
    expect(out).toContain("## 活动");
    expect(isV2Format(out)).toBe(true);
    expect(toV2Format(out)).toBe(out);
  });

  it("标题降级只作用于 `##`：`###`/`#`/行中 `##` 不动", () => {
    const raw = [META, "", "## 二级", "### 三级", "# 一级", "正文里 ## 不是标题"].join("\n");
    const out = toV2Format(raw);
    const archiveBlock = out.slice(out.indexOf("## 活动"));
    expect(archiveBlock).toContain("### 二级");
    expect(archiveBlock).toContain("### 三级");
    expect(archiveBlock).toContain("# 一级");
    expect(archiveBlock).toContain("正文里 ## 不是标题");
    // `### 三级` 不会被再降级成 `####`
    expect(archiveBlock).not.toContain("####");
  });

  it("CRLF 标题降级保留 \\r；正文行逐字节保留", () => {
    const raw = [META, "", "## 批次 A\r", "- 事实 m_1787881381525_2eee472e  \r"].join("\n");
    const out = toV2Format(raw);
    expect(out).toContain("### 批次 A\r");
    expect(out).toContain("- 事实 m_1787881381525_2eee472e  \r");
    expect(anchorMultiset(out)).toEqual(anchorMultiset(raw));
  });
});

describe("toV2Format：保守返回（不破坏）", () => {
  it("空串 / 纯空白 → 原样", () => {
    expect(toV2Format("")).toBe("");
    expect(toV2Format("   \n\n")).toBe("   \n\n");
  });

  it("META 缺失 / 只有 START / END 在 START 前 → 原样", () => {
    const noMeta = "## 用户核心特征\n正文 m_1787881381525_2eee472e";
    expect(toV2Format(noMeta)).toBe(noMeta);
    expect(toV2Format("-----META-START-----\nsummary: s")).toBe("-----META-START-----\nsummary: s");
    const reversed = "-----META-END-----\nsummary: s\n-----META-START-----";
    expect(toV2Format(reversed)).toBe(reversed);
  });

  it("META 畸形（无 summary 字段）→ 原样", () => {
    const malformed = "-----META-START-----\ncreated: x\nheat: 1\n-----META-END-----\n## 批次\n正文";
    expect(toV2Format(malformed)).toBe(malformed);
  });

  it("内容在 META 之前 → 前缀原样保留", () => {
    const raw = ["前置说明", META, "## 批次", "- f m_1787881381525_2eee472e"].join("\n");
    const out = toV2Format(raw);
    expect(out.startsWith("前置说明\n-----META-START-----")).toBe(true);
    expect(anchorMultiset(out)).toEqual(anchorMultiset(raw));
  });
});

describe("toV2Format：要点预算与脱敏", () => {
  // 凭据闸按完整形态扫描邮箱——测试夹具用拼接表达（同 scene-navigation.pii.test.ts 先例）
  const MAIL = "sample.user" + "@example.invalid";

  it("超 300 字 summary 截断（normalizeSceneSummary 同口径）+ PII 脱敏", () => {
    const raw = [
      "-----META-START-----",
      `summary: ${"长".repeat(400)} 邮箱 ${MAIL}`,
      "-----META-END-----",
      "## 批次",
      "叙事",
    ].join("\n");
    const out = toV2Format(raw);
    const gist = out.slice(out.indexOf("## 要点") + "## 要点\n".length, out.indexOf("\n\n## 事实"));
    expect(gist.length).toBeLessThanOrEqual(300);
    expect(gist).not.toContain(MAIL);
    expect(gist.endsWith("…")).toBe(true);
    // META 原样（摘要字段不被迁移修改）
    expect(out).toContain(`summary: ${"长".repeat(400)} 邮箱 ${MAIL}`);
  });

  it("多行 summary（META 内重复 summary 键）取首个 summary 行（与 parseSceneBlock 同口径）", () => {
    const raw = [
      "-----META-START-----",
      "summary: 首个摘要",
      "summary: 第二个摘要",
      "heat: 2",
      "-----META-END-----",
      "## 批次",
      "叙事",
    ].join("\n");
    const out = toV2Format(raw);
    expect(out).toContain("## 要点\n首个摘要");
  });
});

describe("toV2Format：特殊内容", () => {
  it("中文/emoji 行在事实段逐字节保留", () => {
    const line = "- 用户偏好：咖啡☕ + 🚀 部署（记忆ID: m_1787881381525_2eee472e）  ";
    const raw = [META, "", "## 批次", line, "- 其它叙事 🎯"].join("\n");
    const out = toV2Format(raw);
    const factsBlock = out.slice(out.indexOf("## 事实"), out.indexOf("## 活动"));
    expect(factsBlock).toContain(line);
    expect(out).toContain("- 其它叙事 🎯");
    expect(anchorMultiset(out)).toEqual(anchorMultiset(raw));
  });

  it("[SUPERSEDED] 失效事实行仍归事实段且逐字节不变", () => {
    const dead = "[SUPERSEDED 2026-10-31T10:00:00.000Z] - 旧事实 m_1787881381525_2eee472e";
    const raw = [META, "", "## 批次", dead, "- 新事实 m_1788449899823_245dfba6"].join("\n");
    const out = toV2Format(raw);
    const factsBlock = out.slice(out.indexOf("## 事实"), out.indexOf("## 活动"));
    expect(factsBlock).toContain(dead);
    expect(factsBlock).toContain("- 新事实 m_1788449899823_245dfba6");
    expect(anchorMultiset(out)).toEqual(anchorMultiset(raw));
  });

  it("活动段内空行在中部保留、首尾空行去除（结构边界）", () => {
    const raw = [META, "", "## 批次", "", "- 叙事一", "", "- 叙事二", "", "",].join("\n");
    const out = toV2Format(raw);
    const archiveBlock = out.slice(out.indexOf("## 活动") + "## 活动".length);
    expect(archiveBlock.startsWith("\n### 批次")).toBe(true);
    expect(archiveBlock).toContain("- 叙事一\n\n- 叙事二");
    expect(archiveBlock.endsWith("- 叙事二\n")).toBe(true); // 原文件以换行结尾
  });

  it("事实段为空（无锚点）时仍建段，活动段承接全部叙事", () => {
    const raw = [META, "", "## 批次", "- 纯叙事无锚点"].join("\n");
    const out = toV2Format(raw);
    expect(out).toContain("## 事实\n\n## 活动");
    expect(out).toContain("- 纯叙事无锚点");
  });
});
