/**
 * 方案D（exp/l2-plan-d-summary-index）：场景索引注入测试。
 *
 * 覆盖：
 * 1. 兼容钉（off）：不传 sceneIndexSection 时，userPrompt/systemPrompt 与基线逐字节一致
 *    —— 基线 hash 取自改动前代码（commit efbdd14），对 chat/code 两个 prompt 家族
 *       与 warning/无文件变体的联合 sha256。
 * 2. 开关 on：传入 sceneIndexSection 时追加索引段，systemPrompt 不变。
 * 3. buildSceneIndexSection：每行含 path + heat；summary 超 300 字符截断加 …；
 *    空索引返回 undefined（不产生空段）。
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildSceneExtractionPrompt,
  buildSceneIndexSection,
  SCENE_INDEX_HEADER,
} from "./scene-extraction.js";
import type { SceneIndexEntry } from "../scene/scene-index.js";

// ── 兼容钉基线参数（与改动前 dump 脚本完全一致）──
const base = {
  memoriesJson:
    '[\n  {\n    "content": "测试记忆内容",\n    "created_at": "2026-10-30T00:00:00.000Z",\n    "id": "m_1730000000000_abcd1234"\n  }\n]',
  sceneSummaries:
    "**当前场景总数：2 / 15**\n\n### a.md\n**热度**: 3 | **更新**: 2026-10-29\n**summary**: 场景A摘要\n",
  currentTimestamp: "2026-10-30T08:00:00.000Z",
  sceneCountWarning: undefined as string | undefined,
  existingSceneFiles: ["a.md", "b.md"],
  maxScenes: 15,
};

/** 复现改动前基线 dump 的拼接方式（chat/code × system/user + warning 变体）。 */
function baselineJoined(): string {
  const parts: string[] = [];
  for (const mode of ["chat", "code"] as const) {
    const { systemPrompt, userPrompt } = buildSceneExtractionPrompt({ ...base, promptMode: mode });
    parts.push(`${mode}:system`, systemPrompt, `${mode}:user`, userPrompt);
  }
  const { userPrompt: u2 } = buildSceneExtractionPrompt({
    ...base,
    promptMode: "chat",
    sceneCountWarning: "当前场景数量为 **15 个**",
    existingSceneFiles: [],
    sceneSummaries: "",
  });
  parts.push("warn:user", u2);
  return parts.join("\n\x00\n");
}

describe("buildSceneExtractionPrompt 兼容钉（off 逐字节一致）", () => {
  it("不传 sceneIndexSection 时输出与基线逐字节一致", () => {
    const joined = baselineJoined();
    // 改动前实测：len=14476, sha256 如下
    expect(joined.length).toBe(14476);
    expect(createHash("sha256").update(joined, "utf-8").digest("hex")).toBe(
      "0b06ae16073a0b91787d836747bb926b9803c654a2df2a54f2881dd44ba5bcb9",
    );
  });

  it("显式传 undefined 等价于不传（off）", () => {
    const { systemPrompt: s1, userPrompt: u1 } = buildSceneExtractionPrompt({
      ...base,
      promptMode: "chat",
    });
    const { systemPrompt: s2, userPrompt: u2 } = buildSceneExtractionPrompt({
      ...base,
      promptMode: "chat",
      sceneIndexSection: undefined,
    });
    expect(u2).toBe(u1);
    expect(s2).toBe(s1);
  });
});

describe("buildSceneExtractionPrompt 索引注入（on）", () => {
  const section = [
    "### 🗂️ 场景索引（path | heat | summary）",
    "配合场景索引按需读取所需场景，无需读取全部场景全文。",
    "- a.md | heat=3 | 场景A摘要",
    "",
  ].join("\n");

  it("on 时 userPrompt 包含索引段，systemPrompt 不变", () => {
    const off = buildSceneExtractionPrompt({ ...base, promptMode: "chat" });
    const on = buildSceneExtractionPrompt({ ...base, promptMode: "chat", sceneIndexSection: section });

    expect(on.userPrompt).toContain("### 🗂️ 场景索引");
    expect(on.userPrompt).toContain("- a.md | heat=3 | 场景A摘要");
    expect(on.systemPrompt).toBe(off.systemPrompt);
    // 追加而非替换：off 的各内容块仍完整出现在 on 中（插入点空白变化不算替换）
    expect(on.userPrompt).toContain(base.memoriesJson);
    expect(on.userPrompt).toContain(base.currentTimestamp);
    expect(on.userPrompt).toContain("已有场景文件清单");
  });

  it("索引段位于场景摘要之后、文件清单之前", () => {
    const on = buildSceneExtractionPrompt({
      ...base,
      promptMode: "chat",
      sceneIndexSection: section,
    });
    const idxIndex = on.userPrompt.indexOf("场景索引");
    const idxSummaries = on.userPrompt.indexOf("Existing Scene Blocks Summary");
    const idxFiles = on.userPrompt.indexOf("已有场景文件清单");
    expect(idxSummaries).toBeGreaterThanOrEqual(0);
    expect(idxIndex).toBeGreaterThan(idxSummaries);
    expect(idxFiles).toBeGreaterThan(idxIndex);
  });
});

describe("buildSceneIndexSection", () => {
  const entries: SceneIndexEntry[] = [
    {
      filename: "技术研究-Rust学习.md",
      summary: "Rust 所有权与异步框架学习路径",
      heat: 7,
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-10-29T00:00:00.000Z",
    },
    {
      filename: "日常生活-健康管理.md",
      summary: "作息与运动记录",
      heat: 2,
      created: "2026-01-02T00:00:00.000Z",
      updated: "2026-10-28T00:00:00.000Z",
    },
  ];

  it("每行包含 path 与 heat，头部含引导语", () => {
    const section = buildSceneIndexSection(entries)!;
    expect(section).toContain(SCENE_INDEX_HEADER);
    expect(section).toContain("配合场景索引按需读取所需场景");
    const lines = section.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("技术研究-Rust学习.md");
    expect(lines[0]).toContain("heat=7");
    expect(lines[1]).toContain("日常生活-健康管理.md");
    expect(lines[1]).toContain("heat=2");
  });

  it("summary 超 300 字符时截断加省略号（复用 SCENE_SUMMARY_CHAR_BUDGET 预算）", () => {
    const longSummary = "长".repeat(500);
    const section = buildSceneIndexSection([{ ...entries[0], summary: longSummary }])!;
    const line = section.split("\n").find((l) => l.startsWith("- "))!;
    // 行 = "- filename | heat=N | " + 规范化摘要
    const summaryPart = line.slice(line.indexOf("| ", line.indexOf("| ") + 1) + 2);
    expect(summaryPart.length).toBe(300); // 299 字符 + …
    expect(summaryPart.endsWith("…")).toBe(true);
    expect(summaryPart.startsWith("长".repeat(50))).toBe(true);
  });

  it("空索引返回 undefined（不产生空段）", () => {
    expect(buildSceneIndexSection([])).toBeUndefined();
  });

  it("空摘要的条目仍占一行（含 path 与 heat）", () => {
    const section = buildSceneIndexSection([{ ...entries[0], summary: "" }])!;
    const lines = section.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("技术研究-Rust学习.md");
    expect(lines[0]).toContain("heat=7");
  });
});
