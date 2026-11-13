// 票 P2-A3 C 案：sceneArchive config 解析 + extractor Phase 5 接线测试。
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../config.js";
import { SceneExtractor } from "./scene-extractor.js";
import { planSceneSpill } from "./scene-archive.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OLD_HEAD = "### ★10-20 10:00Z 旧批";
const NEW_HEAD = "### ★11-11 10:00Z 新批";

function v2File(): string {
  return [
    "-----META-START-----",
    "created: 2026-11-01T00:00:00.000Z",
    "updated: 2026-11-11T00:00:00.000Z",
    "summary: 接线测试",
    "heat: 5",
    "-----META-END-----",
    "",
    "## 要点",
    "摘要",
    "",
    "## 事实",
    "- 事实行（m_1794000000000_aaaa0001）",
    "",
    "## 活动",
    OLD_HEAD,
    "- 旧批次叙事（m_1794000000001_bbbb0002）",
    "",
    NEW_HEAD,
    "- 新批次叙事（m_1794000000002_cccc0003）",
  ].join("\n");
}

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

async function runExtract(dataDir: string, opts: { sceneArchive?: unknown }) {
  const logger = makeLogger();
  const extractor = new SceneExtractor({
    dataDir,
    config: {} as never,
    maxScenes: 24,
    llmRunner: makeFakeRunner() as never,
    logger: logger as never,
    ...(opts.sceneArchive !== undefined ? { sceneArchive: opts.sceneArchive as never } : {}),
  });
  const result = await extractor.extract([
    { content: "一条测试记忆", created_at: "2026-11-11T00:00:00.000Z", id: "m_1787881381525_2eee472e" },
  ]);
  return { result, logger, dataDir };
}

describe("parseConfig：persona.sceneArchive", () => {
  it("缺省 → undefined（off·Phase 5 零 I/O）", () => {
    expect(parseConfig({}).persona.sceneArchive).toBeUndefined();
  });

  it("true → shadow + 10 天", () => {
    expect(parseConfig({ persona: { sceneArchive: true } }).persona.sceneArchive).toEqual({
      enabled: true,
      mode: "shadow",
      ageDays: 10,
      protectScenes: [],
    });
  });

  it("对象透传 + 非法 throw", () => {
    expect(parseConfig({ persona: { sceneArchive: { mode: "on", ageDays: 7 } } }).persona.sceneArchive).toEqual({
      enabled: true,
      mode: "on",
      ageDays: 7,
      protectScenes: [],
    });
    expect(() => parseConfig({ persona: { sceneArchive: { ageDays: -1 } } })).toThrow();
  });
});

describe("Phase 5 sceneArchive 接线", () => {
  const cfgOn = { enabled: true, mode: "on" as const, ageDays: 10, protectScenes: [] as string[] };
  const cfgShadow = { enabled: true, mode: "shadow" as const, ageDays: 10, protectScenes: [] as string[] };

  it("off（缺省）：文件字节不变、零 metric", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sa-off-"));
    mkdirSync(join(dir, "scene_blocks"), { recursive: true });
    writeFileSync(join(dir, "scene_blocks", "测试.md"), v2File());
    writeFileSync(join(dir, "persona.md"), "画像\n");
    try {
      const { logger } = await runExtract(dir, {});
      const after = require("node:fs").readFileSync(join(dir, "scene_blocks", "测试.md"), "utf-8");
      expect(after).toBe(v2File());
      expect(logger.lines.some((l) => l.includes("l2_scene_archive"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shadow：打 metric=l2_scene_archive 但不写盘（无 archive 文件）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sa-shadow-"));
    mkdirSync(join(dir, "scene_blocks"), { recursive: true });
    writeFileSync(join(dir, "scene_blocks", "测试.md"), v2File());
    writeFileSync(join(dir, "persona.md"), "画像\n");
    try {
      const { logger } = await runExtract(dir, { sceneArchive: cfgShadow });
      const metric = logger.lines.find((l) => l.includes("metric=l2_scene_archive"));
      expect(metric).toBeTruthy();
      expect(metric).toContain("mode=shadow");
      expect(metric).toContain("segments=1");
      // 零写盘：主文件不变、无 archive 文件
      const after = require("node:fs").readFileSync(join(dir, "scene_blocks", "测试.md"), "utf-8");
      expect(after).toBe(v2File());
      expect(require("node:fs").existsSync(join(dir, "scene_blocks", "测试-archive.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("on：旧段 spill 到 archive、主文件留面包屑、锚点守恒、默认读视图不变", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sa-on-"));
    mkdirSync(join(dir, "scene_blocks"), { recursive: true });
    writeFileSync(join(dir, "scene_blocks", "测试.md"), v2File());
    writeFileSync(join(dir, "persona.md"), "画像\n");
    try {
      await runExtract(dir, { sceneArchive: cfgOn });
      const fs = require("node:fs");
      const after = fs.readFileSync(join(dir, "scene_blocks", "测试.md"), "utf-8");
      const arch = fs.readFileSync(join(dir, "scene_blocks", "测试-archive.md"), "utf-8");
      expect(after).not.toContain(OLD_HEAD);
      expect(after).toContain(NEW_HEAD);
      expect(after).toContain("[archived→测试-archive.md]");
      expect(arch).toContain(OLD_HEAD);
      expect(arch).toContain("archive: true");
      // 锚点守恒
      const ids = (t) => new Set(t.match(/m_\d{13}_[0-9a-f]{8}/g) ?? []);
      const before = ids(v2File());
      const union = new Set([...ids(after), ...ids(arch)]);
      expect([...before].filter((x) => !union.has(x))).toEqual([]);
      // 默认读视图（要点+事实）不变
      const view = (t) => t.split("\n").slice(0, t.split("\n").findIndex((l) => l.trim() === "## 活动")).join("\n");
      expect(view(after)).toBe(view(v2File()));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("幂等：二次 extract 不重复 spill（archive 已有该段 date）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sa-idem-"));
    mkdirSync(join(dir, "scene_blocks"), { recursive: true });
    writeFileSync(join(dir, "scene_blocks", "测试.md"), v2File());
    writeFileSync(join(dir, "persona.md"), "画像\n");
    try {
      await runExtract(dir, { sceneArchive: cfgOn });
      const fs = require("node:fs");
      const arch1 = fs.readFileSync(join(dir, "scene_blocks", "测试-archive.md"), "utf-8");
      const main1 = fs.readFileSync(join(dir, "scene_blocks", "测试.md"), "utf-8");
      await runExtract(dir, { sceneArchive: cfgOn });
      const arch2 = fs.readFileSync(join(dir, "scene_blocks", "测试-archive.md"), "utf-8");
      const main2 = fs.readFileSync(join(dir, "scene_blocks", "测试.md"), "utf-8");
      expect(main2).toBe(main1); // 二次无段可选·主文件不变
      expect(arch2).toBe(arch1); // 不重复追加
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("archive 文件自身不被 spill/⑧/⑥b 处理（isArchiveFile 守卫·审核 P1-3）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sa-guard-"));
    mkdirSync(join(dir, "scene_blocks"), { recursive: true });
    const seed = v2File();
    writeFileSync(join(dir, "scene_blocks", "测试.md"), seed);
    writeFileSync(join(dir, "persona.md"), "画像\n");
    try {
      await runExtract(dir, { sceneArchive: cfgOn });
      const fs = require("node:fs");
      const arch1 = fs.readFileSync(join(dir, "scene_blocks", "测试-archive.md"), "utf-8");
      // 再跑一轮：archive 文件出现在 scene_blocks·应被守卫跳过（字节不变）
      await runExtract(dir, { sceneArchive: cfgOn });
      const arch2 = fs.readFileSync(join(dir, "scene_blocks", "测试-archive.md"), "utf-8");
      expect(arch2).toBe(arch1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("planSceneSpill 无候选时零变更", () => {
    const all = v2File().replace(OLD_HEAD, "### ★11-11 09:00Z 新批");
    const plan = planSceneSpill("测试", all, cfgOn, Date.parse("2026-11-12T10:00:00Z"));
    expect(plan.segments).toEqual([]);
    expect(plan.mainAfter).toBe(all);
  });
});

// ── 审查 R2 P1-1：同日期不同内容段不丢失（date+hash 签名去重）──
describe("P2-A3 spill 去重：date+hash 签名（同日期不同内容不丢）", () => {
  const cfgOn = { enabled: true, mode: "on" as const, ageDays: 10, protectScenes: [] as string[] };
  it("同日期不同内容的段：第二次 spill 追加进 archive 而非丢弃（main 移走必有 archive 去处）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sa-p11-"));
    mkdirSync(join(dir, "scene_blocks"), { recursive: true });
    // 第一次：老内容段 10-20
    writeFileSync(join(dir, "scene_blocks", "测试.md"), v2File());
    writeFileSync(join(dir, "persona.md"), "画像\n");
    try {
      await runExtract(dir, { sceneArchive: cfgOn });
      const fs = require("node:fs");
      const arch1 = fs.readFileSync(join(dir, "scene_blocks", "测试-archive.md"), "utf-8");
      // 第二次：同日期 10-20 但内容不同的新段（模拟 LLM 旧日期写新段）
      const newSeg = "### ★10-20 12:00Z 另一批\n- 全然不同的新内容行（m_1794000000009_eeee0009）\n";
      const modified = v2File().replace(NEW_HEAD, newSeg + NEW_HEAD);
      fs.writeFileSync(join(dir, "scene_blocks", "测试.md"), modified, "utf-8");
      await runExtract(dir, { sceneArchive: cfgOn });
      const arch2 = fs.readFileSync(join(dir, "scene_blocks", "测试-archive.md"), "utf-8");
      // 新内容段必须进 archive（原 date 去重会整段丢弃）
      expect(arch2).toContain("全然不同的新内容行");
      expect(arch2).toContain("eeee0009");
      // 主文件该段已移走（正常 spill 语义）
      const main2 = fs.readFileSync(join(dir, "scene_blocks", "测试.md"), "utf-8");
      expect(main2).not.toContain("eeee0009");
      // 锚点全局守恒
      const ids = (t) => new Set(t.match(/m_\d{13}_[0-9a-f]{8}/g) ?? []);
      const union = new Set([...ids(modified), ...ids(arch2)]);
      void union;
      const mainAfter = fs.readFileSync(join(dir, "scene_blocks", "测试.md"), "utf-8");
      const unionAll = new Set([...ids(mainAfter), ...ids(arch2)]);
      const before = ids(modified);
      expect([...before].filter((x) => !unionAll.has(x))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("同日期同内容段（幂等重放）：不重复追加（签名命中跳过）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sa-p11-idem-"));
    mkdirSync(join(dir, "scene_blocks"), { recursive: true });
    writeFileSync(join(dir, "scene_blocks", "测试.md"), v2File());
    writeFileSync(join(dir, "persona.md"), "画像\n");
    try {
      await runExtract(dir, { sceneArchive: cfgOn });
      const fs = require("node:fs");
      const arch1 = fs.readFileSync(join(dir, "scene_blocks", "测试-archive.md"), "utf-8");
      // 模拟崩溃恢复重放：主文件再次出现同日期同内容段
      const replay = v2File().replace(NEW_HEAD, "### ★10-20 10:00Z 旧批\n- 旧批次叙事（m_1794000000001_bbbb0002）\n" + NEW_HEAD);
      fs.writeFileSync(join(dir, "scene_blocks", "测试.md"), replay, "utf-8");
      await runExtract(dir, { sceneArchive: cfgOn });
      const arch2 = fs.readFileSync(join(dir, "scene_blocks", "测试-archive.md"), "utf-8");
      // 段已签名命中：不重复追加（arch2 与 arch1 同·或至少该段不出现两份）
      const dupCount = (arch2.match(/m_1794000000001_bbbb0002/g) ?? []).length;
      expect(dupCount).toBeLessThanOrEqual(1);
      void arch1;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
