/**
 * 方案D：l2-index-sim 模拟评测脚本的确定性测试。
 *
 * 用小型人造目录钉死计算结果（确定性、无网络），并与 TS 侧
 * buildSceneIndexSection 的行格式做防漂移交叉校验。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildIndexSectionText,
  parseSceneMeta,
  simulate,
  truncateSummary,
} from "../scripts/l2-index-sim.mjs";
import { buildSceneIndexSection, SCENE_INDEX_HEADER } from "../src/core/prompts/scene-extraction.js";

const tmpRoots: string[] = [];
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "l2-index-sim-test-"));
  tmpRoots.push(dir);
  return dir;
}

function meta(summary: string, heat: number): string {
  return [
    "-----META-START-----",
    "created: 2026-01-01T00:00:00.000Z",
    "updated: 2026-10-29T00:00:00.000Z",
    `summary: ${summary}`,
    `heat: ${heat}`,
    "-----META-END-----",
    "",
    "正文内容。",
  ].join("\n");
}

describe("truncateSummary（镜像 normalizeSceneSummary 长度语义）", () => {
  it("≤300 原样返回", () => {
    expect(truncateSummary("短摘要", 300)).toBe("短摘要");
  });

  it(">300 截断为 299 字符 + …（合计 300）", () => {
    const out = truncateSummary("长".repeat(500), 300);
    expect(out.length).toBe(300);
    expect(out.endsWith("…")).toBe(true);
  });

  it("maxChars<=0 返回空串", () => {
    expect(truncateSummary("abc", 0)).toBe("");
    expect(truncateSummary("abc", -1)).toBe("");
  });

  it("空输入返回空串", () => {
    expect(truncateSummary("", 300)).toBe("");
  });
});

describe("parseSceneMeta", () => {
  it("解析 summary 与 heat", () => {
    const m = parseSceneMeta(meta("场景摘要", 5));
    expect(m.summary).toBe("场景摘要");
    expect(m.heat).toBe(5);
  });

  it("无 META 时 summary 空、heat 0", () => {
    const m = parseSceneMeta("纯正文，无 META");
    expect(m.summary).toBe("");
    expect(m.heat).toBe(0);
  });

  it("非法 heat 回落 0", () => {
    const raw = meta("摘要", 5).replace("heat: 5", "heat: abc");
    expect(parseSceneMeta(raw).heat).toBe(0);
  });
});

describe("buildIndexSectionText（与 TS buildSceneIndexSection 行格式防漂移）", () => {
  const entries = [
    { filename: "a.md", summary: "场景A", heat: 3 },
    { filename: "b.md", summary: "场景B".repeat(120), heat: 1 }, // 360 字符 → 截断
  ];

  it("头部与 TS 常量一致", () => {
    expect(buildIndexSectionText(entries).startsWith(SCENE_INDEX_HEADER)).toBe(true);
  });

  it("对无 PII 的相同输入，与 TS buildSceneIndexSection 输出逐字节一致", () => {
    const mjsOut = buildIndexSectionText(entries);
    const tsOut = buildSceneIndexSection([
      { filename: "a.md", summary: "场景A", heat: 3, created: "", updated: "" },
      { filename: "b.md", summary: "场景B".repeat(120), heat: 1, created: "", updated: "" },
    ]);
    expect(mjsOut).toBe(tsOut);
  });

  it("空数组返回空串", () => {
    expect(buildIndexSectionText([])).toBe("");
  });
});

describe("simulate（确定性计算）", () => {
  // 人造目录：3 个场景，正文字符 100 / 200 / 300，索引行长度可手算
  const files = [
    { filename: "a.md", raw: meta("甲".repeat(20), 3) },
    { filename: "b.md", raw: meta("乙".repeat(20), 2) },
    { filename: "c.md", raw: meta("丙".repeat(20), 1) },
  ];

  it("对固定输入输出固定数值", () => {
    const r = simulate(files);
    expect(r.sceneCount).toBe(3);
    // whole_cost = 三文件 raw.length 之和（三者同构等长）
    const charA = files[0].raw.length;
    expect(r.wholeCost).toBe(charA * 3);
    // 索引段 = 头部两行 + 3 个条目行（join "\n"）
    const section = buildIndexSectionText([
      { filename: "a.md", summary: "甲".repeat(20), heat: 3 },
      { filename: "b.md", summary: "乙".repeat(20), heat: 2 },
      { filename: "c.md", summary: "丙".repeat(20), heat: 1 },
    ]);
    expect(r.indexChars).toBe(section.length);
    // 单场景平均 = wholeCost / 3
    expect(r.avgSceneChars).toBe(charA);
    // indexed_cost(合计) = indexChars + avgSceneChars
    expect(r.indexedCost).toBe(section.length + charA);
    // saving% = (1 - indexed/whole) * 100，保留两位
    const expectedSaving = Math.round((1 - (section.length + charA) / (charA * 3)) * 10000) / 100;
    expect(r.savingPct).toBe(expectedSaving);
    // 每文件行：indexedCost_i = indexChars + chars_i
    expect(r.rows).toHaveLength(3);
    for (const row of r.rows) {
      expect(row.indexedCost).toBe(r.indexChars + row.chars);
      expect(row.savingPct).toBe(
        Math.round((1 - (r.indexChars + row.chars) / r.wholeCost) * 10000) / 100,
      );
    }
  });

  it("确定性：同一输入两次结果相同", () => {
    expect(JSON.stringify(simulate(files))).toBe(JSON.stringify(simulate([...files].reverse())));
  });
});

describe("CLI 主流程（对小型人造目录）", () => {
  it("从目录读取并产出与纯函数一致的结果", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "a.md"), meta("场景A摘要", 3), "utf-8");
    writeFileSync(join(dir, "b.md"), meta("场景B摘要", 2), "utf-8");
    writeFileSync(join(dir, "notes.txt"), "非 md 文件应被忽略", "utf-8");

    const { runCli } = await import("../scripts/l2-index-sim.mjs");
    const report = runCli(dir);
    expect(report.sceneCount).toBe(2);
    expect(report.rows.map((r: { filename: string }) => r.filename)).toEqual(["a.md", "b.md"]);
    expect(report.savingPct).toBeGreaterThan(0);
  });
});
