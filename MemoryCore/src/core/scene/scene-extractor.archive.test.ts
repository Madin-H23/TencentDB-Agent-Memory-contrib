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
