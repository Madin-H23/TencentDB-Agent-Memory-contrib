// 票 P1-6b 接线：SceneExtractor Phase 5 确定性同锚替代折叠（factSupersede）。
// 口径：shadow=只打 metric 不落盘；on=写回且锚点多重集零变化（防御性守卫兜底）；
// off（缺省）=零调用零 I/O；异常只 warn 不中断 L2；读取的是压实后的当前文件态。
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SceneExtractor } from "./scene-extractor.js";
import { judgePairKey } from "./fact-ops.js";
import type { LLMRunParams } from "../../core/types.js";

const A = "m_1793500000000_aaaa0001";

function makeFakeRunner() {
  return {
    captured: [] as LLMRunParams[],
    run: async () => "done",
  };
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

/** 文件：两条同锚重投行（时间序，旧行在前）+ 一条独立锚点行。 */
function dupFile(): string {
  return [
    "-----META-START-----",
    "created: 2026-11-01T00:00:00.000Z",
    "updated: 2026-11-08T00:00:00.000Z",
    "summary: 同锚重投测试",
    "heat: 5",
    "-----META-END-----",
    "",
    "## 事实",
    "",
    `【2026-11-01T02:00:00Z 批】写侧帽 sceneCharCap 从 32K 提升到 300K，全量落 yaml（${A}）`,
    `【2026-11-08T03:00:00Z 批】写侧帽 sceneCharCap 从 32K 提升到 300K，全量落 yaml 复核在案（${A}）`,
    "",
  ].join("\n");
}

async function seed(files: Record<string, string>): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-factsup-"));
  await fs.mkdir(path.join(dataDir, "scene_blocks"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dataDir, "scene_blocks", name), content, "utf-8");
  }
  await fs.writeFile(path.join(dataDir, "persona.md"), "用户画像正文。\n", "utf-8");
  return dataDir;
}

async function runExtract(
  dataDir: string,
  opts: { factSupersede?: { mode: "shadow" | "on"; minSimilarity: number; judgeStatePath?: string } },
) {
  const logger = makeLogger();
  const extractor = new SceneExtractor({
    dataDir,
    config: {} as never,
    maxScenes: 24,
    llmRunner: makeFakeRunner() as never,
    logger: logger as never,
    ...(opts.factSupersede !== undefined ? { factSupersede: opts.factSupersede } : {}),
  });
  const result = await extractor.extract([
    { content: "一条测试记忆", created_at: "2026-10-31T00:00:00.000Z", id: "m_1787881381525_2eee472e" },
  ]);
  return { result, logger };
}

function anchorsOf(s: string): string[] {
  return (s.match(/m_\d{13}_[0-9a-f]{8}/g) ?? []).sort();
}

describe("Phase 5 factSupersede 接线：开关与模式", () => {
  it("off（缺省）：文件字节不变、无 metric 行", async () => {
    const before = dupFile();
    const dataDir = await seed({ "重投.md": before });
    try {
      const { logger } = await runExtract(dataDir, {});
      const after = await fs.readFile(path.join(dataDir, "scene_blocks", "重投.md"), "utf-8");
      expect(after).toBe(before);
      expect(logger.lines.some((l) => l.includes("l2_fact_supersede"))).toBe(false);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("shadow：文件字节不变但打 metric=l2_fact_supersede mode=shadow", async () => {
    const before = dupFile();
    const dataDir = await seed({ "重投.md": before });
    try {
      const { logger } = await runExtract(dataDir, { factSupersede: { mode: "shadow", minSimilarity: 0.55 } });
      const after = await fs.readFile(path.join(dataDir, "scene_blocks", "重投.md"), "utf-8");
      expect(after).toBe(before);
      const metric = logger.lines.find((l) => l.includes("l2_fact_supersede"));
      expect(metric).toBeTruthy();
      expect(metric).toContain("mode=shadow");
      expect(metric).toContain("marked=1");
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("on：旧行被加 [SUPERSEDED] 前缀写回；锚点多重集零变化；最新行与独立锚点行不动", async () => {
    const before = dupFile();
    const dataDir = await seed({ "重投.md": before });
    try {
      const { logger } = await runExtract(dataDir, { factSupersede: { mode: "on", minSimilarity: 0.55 } });
      const after = await fs.readFile(path.join(dataDir, "scene_blocks", "重投.md"), "utf-8");
      expect(after).not.toBe(before);
      const lines = after.split("\n");
      const oldIdx = lines.findIndex((l) => l.includes("【2026-11-01T02:00:00Z 批】写侧帽"));
      const newIdx = lines.findIndex((l) => l.includes("【2026-11-08T03:00:00Z 批】写侧帽"));
      expect(lines[oldIdx]!.startsWith("[SUPERSEDED ")).toBe(true);
      expect(lines[newIdx]!.startsWith("[SUPERSEDED")).toBe(false);
      expect(anchorsOf(after)).toEqual(anchorsOf(before));
      expect(logger.lines.some((l) => l.includes("l2_fact_supersede mode=on"))).toBe(true);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("无重复锚点文件：on 模式也逐字节不变、零 metric", async () => {
    const plain = [
      "-----META-START-----",
      "created: 2026-11-01T00:00:00.000Z",
      "updated: 2026-11-08T00:00:00.000Z",
      "summary: 干净场景",
      "heat: 1",
      "-----META-END-----",
      "",
      "## 事实",
      "",
      `【11-01 批】唯一事实一行（${A}）`,
      "",
    ].join("\n");
    const dataDir = await seed({ "干净.md": plain });
    try {
      const { logger } = await runExtract(dataDir, { factSupersede: { mode: "on", minSimilarity: 0.55 } });
      const after = await fs.readFile(path.join(dataDir, "scene_blocks", "干净.md"), "utf-8");
      expect(after).toBe(plain);
      expect(logger.lines.some((l) => l.includes("l2_fact_supersede"))).toBe(false);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});

// ── P1-6b 批准桶接线（T3·票 TICKETS-P1-6b-approval-gate-20261113.md）──
// on 模式 + judgeStatePath：只标记 judge 批准的对；未批准对撤销标记。
// 注意：judgePairKey 的 oldText/newText 取自**未加前缀的原文行**（与夜间脚本同口径）。

function judgeStateFor(fixture: string): string {
  // 用与 extractor 相同的口径预计算批准键：file + anchor + 脱敏 old/new 原文行
  const lines = fixture.split("\n");
  const oldIdx = lines.findIndex((l) => l.includes("2026-11-01T02:00:00Z"));
  const newIdx = lines.findIndex((l) => l.includes("2026-11-08T03:00:00Z"));
  const anchor = /m_\d{13}_[0-9a-f]{8}/.exec(lines[oldIdx]!)![0];
  return JSON.stringify({
    version: 1,
    pairs: {
      [judgePairKey("dup.md", anchor, lines[oldIdx]!, lines[newIdx]!)]: {
        verdict: "supersede",
        at: "2026-11-11T01:22:00Z",
        attempts: 0,
      },
    },
  });
}

describe("Phase 5 factSupersede on 模式：judge 批准桶过滤", () => {
  it("on + judgeStatePath 命中：该对被标记（同无批准桶行为）", async () => {
    const statePath = path.join(os.tmpdir(), `judge-approve-${Date.now()}.json`);
    await fs.writeFile(statePath, judgeStateFor(dupFile()), "utf-8");
    const dataDir = await seed({ "dup.md": dupFile() });
    try {
      const { logger } = await runExtract(dataDir, {
        factSupersede: { mode: "on", minSimilarity: 0.55, judgeStatePath: statePath },
      });
      const after = await fs.readFile(path.join(dataDir, "scene_blocks", "dup.md"), "utf-8");
      expect(after).toContain("[SUPERSEDED");
      expect(logger.lines.some((l) => l.includes("metric=l2_fact_supersede"))).toBe(true);
      expect(logger.lines.some((l) => l.includes("approved=1"))).toBe(true);
      expect(logger.lines.some((l) => l.includes("reverted=0"))).toBe(true);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
      await fs.rm(statePath, { force: true });
    }
  });

  it("on + judgeStatePath 未命中：标记被撤销、文件回到原状（锚点零变化）", async () => {
    const statePath = path.join(os.tmpdir(), `judge-empty-${Date.now()}.json`);
    await fs.writeFile(statePath, JSON.stringify({ version: 1, pairs: {} }), "utf-8");
    const dataDir = await seed({ "dup.md": dupFile() });
    try {
      await runExtract(dataDir, {
        factSupersede: { mode: "on", minSimilarity: 0.55, judgeStatePath: statePath },
      });
      const after = await fs.readFile(path.join(dataDir, "scene_blocks", "dup.md"), "utf-8");
      expect(after).toBe(dupFile()); // 逐字节回到原状
      expect(anchorsOf(after)).toEqual(anchorsOf(dupFile()));
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
      await fs.rm(statePath, { force: true });
    }
  });

  it("on + judgeStatePath 指向不存在文件：fail-closed 零标记（不 throw·不写盘）", async () => {
    const dataDir = await seed({ "dup.md": dupFile() });
    try {
      const { logger } = await runExtract(dataDir, {
        factSupersede: { mode: "on", minSimilarity: 0.55, judgeStatePath: path.join(os.tmpdir(), "no-such-state.json") },
      });
      const after = await fs.readFile(path.join(dataDir, "scene_blocks", "dup.md"), "utf-8");
      expect(after).toBe(dupFile()); // 拿不到批准集 ⇒ 一个都不标（堵「静默绕过闸门」）
      expect(logger.lines.some((l) => l.includes("judge state unavailable"))).toBe(true);
      expect(logger.lines.some((l) => l.includes("fail-closed"))).toBe(true);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("on + judgeStatePath 内容畸形：解析得空集 ⇒ 零标记（不 throw）", async () => {
    const statePath = path.join(os.tmpdir(), `judge-bad-${Date.now()}.json`);
    await fs.writeFile(statePath, "not a json at all {{{", "utf-8");
    const dataDir = await seed({ "dup.md": dupFile() });
    try {
      const { logger } = await runExtract(dataDir, {
        factSupersede: { mode: "on", minSimilarity: 0.55, judgeStatePath: statePath },
      });
      const after = await fs.readFile(path.join(dataDir, "scene_blocks", "dup.md"), "utf-8");
      expect(after).toBe(dupFile()); // 空批准集 ⇒ 全撤销 ⇒ 零写盘
      expect(logger.lines.some((l) => l.includes("approved=0"))).toBe(true);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
      await fs.rm(statePath, { force: true });
    }
  });

  it("shadow + judgeStatePath：仍全量打 metric 不过滤（shadow 语义不变）", async () => {
    const statePath = path.join(os.tmpdir(), `judge-shadow-${Date.now()}.json`);
    await fs.writeFile(statePath, JSON.stringify({ version: 1, pairs: {} }), "utf-8");
    const dataDir = await seed({ "dup.md": dupFile() });
    try {
      await runExtract(dataDir, {
        factSupersede: { mode: "shadow", minSimilarity: 0.55, judgeStatePath: statePath },
      });
      const after = await fs.readFile(path.join(dataDir, "scene_blocks", "dup.md"), "utf-8");
      expect(after).toBe(dupFile()); // shadow 永不落盘
      expect(after).not.toContain("[SUPERSEDED");
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
      await fs.rm(statePath, { force: true });
    }
  });

  it("on + 无 judgeStatePath：全量标记（接线前行为·AC3 退化保证）", async () => {
    const dataDir = await seed({ "dup.md": dupFile() });
    try {
      await runExtract(dataDir, { factSupersede: { mode: "on", minSimilarity: 0.55 } });
      const after = await fs.readFile(path.join(dataDir, "scene_blocks", "dup.md"), "utf-8");
      expect(after).toContain("[SUPERSEDED");
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("幂等：on + 批准桶命中后二次 extract 不重复标记", async () => {
    const statePath = path.join(os.tmpdir(), `judge-idem-${Date.now()}.json`);
    await fs.writeFile(statePath, judgeStateFor(dupFile()), "utf-8");
    const dataDir = await seed({ "dup.md": dupFile() });
    try {
      await runExtract(dataDir, {
        factSupersede: { mode: "on", minSimilarity: 0.55, judgeStatePath: statePath },
      });
      const once = await fs.readFile(path.join(dataDir, "scene_blocks", "dup.md"), "utf-8");
      await runExtract(dataDir, {
        factSupersede: { mode: "on", minSimilarity: 0.55, judgeStatePath: statePath },
      });
      const twice = await fs.readFile(path.join(dataDir, "scene_blocks", "dup.md"), "utf-8");
      expect(twice).toBe(once);
      expect((twice.match(/\[SUPERSEDED/g) ?? []).length).toBe(1);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
      await fs.rm(statePath, { force: true });
    }
  });
});
