// 票 origin#31（R4·v2 事实段治理两段式）：纯决策件+config 解析+extractor 接线测试。
// 段一=事实段内 superseded 行归档（帽已排除它们【checkSceneCharCapWithSupersede】·
//      但 read 视图【buildV2ReadView 只剥活动段】不过滤——归档后 LLM 上下文去污染·纯收益）
// 段二=冷活跃行归档（行时间戳 age>ageDays·帽 86% 压力主体=活跃行堆积·治帽正解）
// 均行级（C 案是批次段级）；锚点守恒断言内建；shadow 只计量不写盘。
import { describe, expect, it } from "vitest";
import {
  parseSceneFactArchiveConfig,
  selectFactArchiveLines,
  planFactSpill,
} from "./scene-fact-archive.js";
import { SceneExtractor } from "./scene-extractor.js";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// now 锚定 2026-11-17T00:00:00Z：冷行（09-01）=77 天 >60；新鲜行（11-16）=1 天。
const NOW = Date.parse("2026-11-17T00:00:00.000Z");

function v2File(): string {
  return [
    "-----META-START-----",
    "created: 2026-11-01T00:00:00.000Z",
    "updated: 2026-11-16T00:00:00.000Z",
    "summary: 事实段治理测试",
    "heat: 5",
    "-----META-END-----",
    "",
    "## 要点",
    "摘要行",
    "",
    "## 事实",
    "- 冷事实（m_1794000000000_aaaa0001）北京 09-01 12:00Z 某部署完成",
    "[SUPERSEDED 2026-11-14T08:00:00.000Z] - 旧事实（m_1794000000001_bbbb0002）北京 09-02 12:00Z 旧口径",
    "- 新鲜事实（m_1794000000002_cccc0003）北京 11-16 09:00Z 某发布",
    "- 无时间戳事实（m_1794000000003_dddd0004）",
    "",
    "## 活动",
    "### ★09-01 12:00Z 旧批",
    "- 旧批次叙事（m_1794000000004_eeee0005）",
  ].join("\n");
}

describe("parseSceneFactArchiveConfig：拒绝式解析", () => {
  it("undefined/null/false → undefined（off=零接线）", () => {
    expect(parseSceneFactArchiveConfig(undefined)).toBeUndefined();
    expect(parseSceneFactArchiveConfig(null)).toBeUndefined();
    expect(parseSceneFactArchiveConfig(false)).toBeUndefined();
  });

  it("true → shadow 安全默认（ageDays 60）", () => {
    expect(parseSceneFactArchiveConfig(true)).toEqual({
      enabled: true,
      mode: "shadow",
      ageDays: 60,
      protectScenes: [],
    });
  });

  it("对象透传；mode=off → undefined", () => {
    expect(parseSceneFactArchiveConfig({ mode: "on", ageDays: 30 })).toEqual({
      enabled: true,
      mode: "on",
      ageDays: 30,
      protectScenes: [],
    });
    expect(parseSceneFactArchiveConfig({ mode: "off" })).toBeUndefined();
  });

  it("畸形 throw（不静默回落）", () => {
    expect(() => parseSceneFactArchiveConfig(42)).toThrow();
    expect(() => parseSceneFactArchiveConfig("on")).toThrow();
    expect(() => parseSceneFactArchiveConfig({ mode: "nope" })).toThrow();
    expect(() => parseSceneFactArchiveConfig({ ageDays: 0 })).toThrow();
    expect(() => parseSceneFactArchiveConfig({ protectScenes: "x" })).toThrow();
  });
});

describe("selectFactArchiveLines：事实段行级候选（段一 superseded+段二 cold）", () => {
  const cfg = { enabled: true, mode: "on" as const, ageDays: 60, protectScenes: [] };

  it("superseded 行（段一）+冷行（段二）选中·新鲜/无时间戳行不选", () => {
    const lines = selectFactArchiveLines(v2File(), cfg, NOW);
    const kinds = lines.map((l) => l.kind);
    expect(kinds).toContain("superseded");
    expect(kinds).toContain("cold");
    expect(lines.filter((l) => l.kind === "cold").every((l) => l.ageDays !== null && l.ageDays > 60)).toBe(true);
    // 新鲜行与无时间戳行不进候选
    const texts = lines.map((l) => l.text);
    expect(texts.some((t) => t.includes("cccc0003"))).toBe(false);
    expect(texts.some((t) => t.includes("dddd0004"))).toBe(false);
  });

  it("边界隔离：要点段/META/活动段行一律不选", () => {
    const lines = selectFactArchiveLines(v2File(), cfg, NOW);
    for (const l of lines) {
      expect(l.text).not.toContain("摘要行");
      expect(l.text).not.toContain("created:");
      expect(l.text).not.toContain("旧批次叙事"); // 活动段（整段属 C 案管辖）
    }
  });

  it("未来行 fail-closed 跳过；边界 59/60 天不选（严格大于·对齐 C 案先例）61 天选", () => {
    const raw = [
      "## 事实",
      "- 未来事实（m_1794000000005_ffff0006）2027-01-01T00:00:00Z 未来日期",
      "- 边界59天（m_1794000000006_aaaa0007）2026-09-19T00:00:00Z 59天",
      "- 边界60天（m_1794000000007_bbbb0008）2026-09-18T00:00:00Z 60天整",
      "- 边界61天（m_1794000000008_aaaa0009）2026-09-17T00:00:00Z 61天",
    ].join("\n");
    const lines = selectFactArchiveLines(raw, cfg, NOW);
    const texts = lines.map((l) => l.text);
    expect(texts.some((t) => t.includes("ffff0006"))).toBe(false); // 未来 fail-closed
    expect(texts.some((t) => t.includes("aaaa0007"))).toBe(false); // 59 天不选
    expect(texts.some((t) => t.includes("bbbb0008"))).toBe(false); // 60 天整不选（严格大于）
    expect(texts.some((t) => t.includes("aaaa0009"))).toBe(true); // 61 天选
  });

  it("protectScenes 命中返空；非 v2（无 ## 事实 头）返空", () => {
    const pCfg = { ...cfg, protectScenes: ["研究场景"] };
    expect(selectFactArchiveLines(v2File(), pCfg, NOW, "研究场景")).toEqual([]);
    expect(selectFactArchiveLines("# 纯 v1 文件\n- 行（m_1794000000008_cccc0009）", cfg, NOW)).toEqual([]);
  });
});

describe("planFactSpill：摘行计划（锚点守恒断言内建）", () => {
  const cfg = { enabled: true, mode: "on" as const, ageDays: 60, protectScenes: [] };

  it("mainAfter 摘净候选行·新鲜/无时间戳行保留·archiveAppend 保序含原文", () => {
    const plan = planFactSpill("研究场景", v2File(), cfg, NOW);
    expect(plan.anchorsConserved).toBe(true);
    expect(plan.mainAfter).not.toContain("aaaa0001"); // 冷行摘除
    expect(plan.mainAfter).not.toContain("bbbb0002"); // superseded 摘除
    expect(plan.mainAfter).toContain("cccc0003"); // 新鲜保留
    expect(plan.mainAfter).toContain("dddd0004"); // 无时间戳保留
    expect(plan.mainAfter).toContain("eeee0005"); // 活动段保留
    expect(plan.archiveAppend).toContain("aaaa0001");
    expect(plan.archiveAppend).toContain("bbbb0002");
    // 保序：冷行在 superseded 行前（原文件序）
    expect(plan.archiveAppend.indexOf("aaaa0001")).toBeLessThan(plan.archiveAppend.indexOf("bbbb0002"));
  });

  it("面包屑放活动段头后（不进默认读视图=要点+事实）", () => {
    const plan = planFactSpill("研究场景", v2File(), cfg, NOW);
    const actIdx = plan.mainAfter.indexOf("## 活动");
    const factIdx = plan.mainAfter.indexOf("## 事实");
    const bcIdx = plan.mainAfter.indexOf("[archived→研究场景-archive.md]");
    expect(bcIdx).toBeGreaterThan(actIdx);
    expect(bcIdx).toBeLessThan(factIdx === -1 ? Number.MAX_SAFE_INTEGER : actIdx + 200);
    expect(plan.mainAfter.slice(factIdx, actIdx)).not.toContain("[archived→");
  });

  it("空候选 → 空计划（mainAfter 逐字节等于原文）", () => {
    const fresh = [
      "## 事实",
      "- 新鲜事实（m_1794000000009_dddd000a）北京 11-16 09:00Z 某发布",
    ].join("\n");
    const plan = planFactSpill("研究场景", fresh, cfg, NOW);
    expect(plan.lines).toHaveLength(0);
    expect(plan.mainAfter).toBe(fresh);
    expect(plan.archiveAppend).toBe("");
  });

  it("幂等：对 mainAfter 再跑 select 零候选", () => {
    const plan = planFactSpill("研究场景", v2File(), cfg, NOW);
    const again = selectFactArchiveLines(plan.mainAfter, cfg, NOW);
    expect(again).toHaveLength(0);
  });

  it("锚点全局守恒：摘行锚点全部迁入 archiveAppend", () => {
    const plan = planFactSpill("研究场景", v2File(), cfg, NOW);
    const before = new Set(v2File().match(/m_\d+_[0-9a-f]{8}/g) ?? []);
    const after = new Set([
      ...((plan.mainAfter.match(/m_\d+_[0-9a-f]{8}/g) ?? [])),
      ...((plan.archiveAppend.match(/m_\d+_[0-9a-f]{8}/g) ?? [])),
    ]);
    for (const a of before) expect(after.has(a)).toBe(true);
  });
});

// ── extractor 接线集成（shadow 不写盘 / on 双写+幂等） ─────────────
function makeLogger() {
  const lines: string[] = [];
  return {
    lines,
    debug: (m: string) => lines.push(`DEBUG ${m}`),
    info: (m: string) => lines.push(`INFO ${m}`),
    warn: (m: string) => lines.push(`WARN ${m}`),
    error: (m: string) => lines.push(`ERROR ${m}`),
  };
}

function makeFakeRunner() {
  return { captured: [] as unknown[], run: async () => "done" };
}

async function runExtract(dataDir: string, opts: { sceneFactArchive?: unknown }) {
  const logger = makeLogger();
  const extractor = new SceneExtractor({
    dataDir,
    config: {} as never,
    maxScenes: 24,
    llmRunner: makeFakeRunner() as never,
    logger: logger as never,
    ...(opts.sceneFactArchive !== undefined ? { sceneFactArchive: opts.sceneFactArchive as never } : {}),
  });
  await extractor.extract([
    { content: "一条测试记忆", created_at: "2026-11-16T00:00:00.000Z", id: "m_1794000000000_aaaa0001" },
  ]);
  return logger;
}

function setupTmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fact-arch-"));
  const scenes = join(dir, "scene_blocks");
  mkdirSync(scenes, { recursive: true });
  writeFileSync(join(scenes, "研究场景.md"), v2File(), "utf-8");
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响断言 */
      }
    },
  };
}

describe("extractor 接线：factArchiveFile（origin#31）", () => {
  it("shadow：只打 metric 不写盘（主文件/archive 均不动）", async () => {
    const { dir, cleanup } = setupTmp();
    try {
      const logger = await runExtract(dir, { sceneFactArchive: { enabled: true, mode: "shadow", ageDays: 60, protectScenes: [] } });
      const main = readFileSync(join(dir, "scene_blocks", "研究场景.md"), "utf-8");
      expect(main).toContain("aaaa0001"); // 冷行仍在
      expect(main).toContain("bbbb0002"); // superseded 仍在
      expect(existsSync(join(dir, "scene_blocks", "研究场景-archive.md"))).toBe(false);
      expect(logger.lines.some((l) => l.includes("metric=l2_fact_archive"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("on：archive 先行建（META archive:true）+main 后行瘦·净读视图去污染", async () => {
    const { dir, cleanup } = setupTmp();
    try {
      await runExtract(dir, { sceneFactArchive: { enabled: true, mode: "on", ageDays: 60, protectScenes: [] } });
      const archPath = join(dir, "scene_blocks", "研究场景-archive.md");
      expect(existsSync(archPath)).toBe(true);
      const arch = readFileSync(archPath, "utf-8");
      expect(arch).toContain("archive: true");
      expect(arch).toContain("aaaa0001");
      expect(arch).toContain("bbbb0002");
      const main = readFileSync(join(dir, "scene_blocks", "研究场景.md"), "utf-8");
      expect(main).not.toContain("aaaa0001");
      expect(main).not.toContain("bbbb0002");
      expect(main).toContain("cccc0003"); // 新鲜行保留
      // 帽活字符口径（content.length−supersededChars）真瘦：原 4 事实行→2
      expect((main.match(/m_\d+_[0-9a-f]{8}/g) ?? []).length).toBeLessThan((v2File().match(/m_\d+_[0-9a-f]{8}/g) ?? []).length);
    } finally {
      cleanup();
    }
  });

  it("on 幂等：二跑零候选零追加", async () => {
    const { dir, cleanup } = setupTmp();
    try {
      await runExtract(dir, { sceneFactArchive: { enabled: true, mode: "on", ageDays: 60, protectScenes: [] } });
      const arch1 = readFileSync(join(dir, "scene_blocks", "研究场景-archive.md"), "utf-8");
      await runExtract(dir, { sceneFactArchive: { enabled: true, mode: "on", ageDays: 60, protectScenes: [] } });
      const arch2 = readFileSync(join(dir, "scene_blocks", "研究场景-archive.md"), "utf-8");
      expect(arch2).toBe(arch1); // 二跑零追加
    } finally {
      cleanup();
    }
  });

  it("off（缺省不传）：零调用零 I/O 零 metric（回归钉）", async () => {
    const { dir, cleanup } = setupTmp();
    try {
      const logger = await runExtract(dir, {});
      const main = readFileSync(join(dir, "scene_blocks", "研究场景.md"), "utf-8");
      expect(main).toContain("aaaa0001");
      expect(existsSync(join(dir, "scene_blocks", "研究场景-archive.md"))).toBe(false);
      expect(logger.lines.some((l) => l.includes("l2_fact_archive"))).toBe(false);
    } finally {
      cleanup();
    }
  });
});
