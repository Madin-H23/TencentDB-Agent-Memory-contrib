// 票⑧（exp/p1-8-scene-compaction）：SceneExtractor Phase 5 确定性压实接线。
// 口径：sceneCompaction.enabled=true 且 file > sceneCharCap×triggerRatio 时调用
// compactSceneBlock 并写回（storage/本地 fs 两路），在 syncSceneIndex **之前**；
// 先做 soft-delete 判定再压实；异常只 warn 不中断 L2；off 分支零调用。
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SceneExtractor } from "./scene-extractor.js";
import { compactSceneBlock } from "./scene-compact.js";
import type { LLMRunParams } from "../../core/types.js";

let actualCompact: typeof import("./scene-compact.js").compactSceneBlock;
// vi.mock 工厂在模块链接期执行（早于顶层 let 初始化），真实实现经 hoisted 容器中转。
const hoisted = vi.hoisted(() => ({ actualCompact: undefined as unknown as (raw: string, opts: { triggerChars: number; targetChars: number }) => unknown }));
vi.mock("./scene-compact.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scene-compact.js")>();
  hoisted.actualCompact = actual.compactSceneBlock;
  return { ...actual, compactSceneBlock: vi.fn(actual.compactSceneBlock) };
});

const mockedCompact = vi.mocked(compactSceneBlock);

beforeEach(() => {
  mockedCompact.mockClear();
  actualCompact = hoisted.actualCompact as typeof compactSceneBlock;
  mockedCompact.mockImplementation(actualCompact);
});

function makeFakeRunner() {
  return {
    captured: [] as LLMRunParams[],
    run: async (params: LLMRunParams) => {
      return "done";
    },
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

const ANCHOR_PREFIX = "m_1793500000000_";
const anchorFor = (i: number) => `${ANCHOR_PREFIX}${(i + 1).toString(16).padStart(8, "0")}`;

/** v1 批次追加式文件（最新批在上、最旧批在下），每批含 1 条长叙述 + 1 条锚点事实。 */
function batchFile(batches: number, tag = "批"): string {
  const lines: string[] = [
    "-----META-START-----",
    "created: 2026-10-01T00:00:00.000Z",
    "updated: 2026-10-31T00:00:00.000Z",
    "summary: 压实测试场景",
    "heat: 5",
    "-----META-END-----",
    "",
  ];
  for (let i = 0; i < batches; i++) {
    lines.push(`## ★10-${String(30 - i).padStart(2, "0")} 10:00Z 本批·${tag}${i}`);
    lines.push("");
    lines.push(`- 第 ${i} 批叙述行：${"用于填充分量的长叙述内容。".repeat(4)}`);
    lines.push(`- 第 ${i} 批事实（${anchorFor(i)}）`);
    lines.push("");
  }
  return lines.join("\n");
}

const CAP = 1000;

async function seed(files: Record<string, string>): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-compaction-"));
  await fs.mkdir(path.join(dataDir, "scene_blocks"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dataDir, "scene_blocks", name), content, "utf-8");
  }
  await fs.writeFile(path.join(dataDir, "persona.md"), "用户画像正文。\n", "utf-8");
  return dataDir;
}

async function runExtract(
  dataDir: string,
  opts: { sceneCompaction?: { enabled: boolean; triggerRatio: number; targetRatio: number }; sceneCharCap?: number },
) {
  const logger = makeLogger();
  const extractor = new SceneExtractor({
    dataDir,
    config: {} as never,
    maxScenes: 24,
    sceneCharCap: opts.sceneCharCap ?? CAP,
    llmRunner: makeFakeRunner() as never,
    logger: logger as never,
    ...(opts.sceneCompaction !== undefined ? { sceneCompaction: opts.sceneCompaction } : {}),
  });
  const result = await extractor.extract([
    { content: "一条测试记忆", created_at: "2026-10-31T00:00:00.000Z", id: "m_1787881381525_2eee472e" },
  ]);
  return { result, logger };
}

const ON = { enabled: true, triggerRatio: 0.7, targetRatio: 0.5 };

function anchorsOf(s: string): string[] {
  return (s.match(/m_\d{13}_[0-9a-f]{8}/g) ?? []).sort();
}

describe("Phase 5 压实接线：开关与阈值", () => {
  it("off（缺省）：不调用 compactSceneBlock，文件字节不变，零锚点", async () => {
    const big = batchFile(8);
    const dataDir = await seed({ "大文件.md": big });
    try {
      const { logger } = await runExtract(dataDir, {});
      expect(mockedCompact).not.toHaveBeenCalled();
      const after = await fs.readFile(path.join(dataDir, "scene_blocks", "大文件.md"), "utf-8");
      expect(after).toBe(big);
      expect(logger.lines.some((l) => l.includes("l2_scene_compact"))).toBe(false);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("显式 enabled=false：与缺省同形（零调用）", async () => {
    const dataDir = await seed({ "大文件.md": batchFile(8) });
    try {
      await runExtract(dataDir, { sceneCompaction: { ...ON, enabled: false } });
      expect(mockedCompact).not.toHaveBeenCalled();
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("on 但未超 trigger：不调用、不写回", async () => {
    const small = "-----META-START-----\ncreated: 2026-10-01T00:00:00.000Z\nupdated: 2026-10-31T00:00:00.000Z\nsummary: 小场景\nheat: 1\n-----META-END-----\n\n## ★10-31 本批\n\n- 一条短叙述。\n";
    const dataDir = await seed({ "small.md": small });
    try {
      await runExtract(dataDir, { sceneCompaction: ON });
      expect(mockedCompact).not.toHaveBeenCalled();
      const after = await fs.readFile(path.join(dataDir, "scene_blocks", "small.md"), "utf-8");
      expect(after).toBe(small);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("Phase 5 压实接线：写回与锚点", () => {
  it("on 且超 trigger：写回压实结果（锚点 lost=0、体积 <= target），锚点行格式正确", async () => {
    const big = batchFile(8);
    expect(big.length).toBeGreaterThan(CAP * 0.7);
    const dataDir = await seed({ "大文件.md": big });
    try {
      const { logger, result } = await runExtract(dataDir, { sceneCompaction: ON });
      expect(result.success).toBe(true);
      expect(mockedCompact).toHaveBeenCalledTimes(1);
      const after = await fs.readFile(path.join(dataDir, "scene_blocks", "大文件.md"), "utf-8");
      expect(after).not.toBe(big);
      expect(after).toContain("## 活动");
      expect(after).toContain("[compacted]");
      expect(anchorsOf(after)).toEqual(anchorsOf(big)); // lost=0
      expect(after.length).toBeLessThanOrEqual(CAP * 0.5);

      const metrics = logger.lines.filter((l) => l.includes("metric=l2_scene_compact"));
      expect(metrics).toHaveLength(1);
      expect(metrics[0]).toMatch(
        new RegExp(
          `metric=l2_scene_compact enabled=1 file=大文件\\.md before=${big.length} after=\\d+ folded=\\d+ anchors=\\d+ reason=(ok|insufficient_archive)$`,
        ),
      );
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("on：折完仍不足 target 时写回折叠结果并标注 reason=insufficient_archive，锚点不丢", async () => {
    // 大块不可折叠的事实内容（非批次段 → 迁移后进 `## 事实`），可折叠叙事只占小头
    const big = `${batchFile(3)}\n## 用户偏好\n\n${"- 不可折叠的事实行：事实内容事实内容事实内容事实内容。\n".repeat(40)}`;
    const dataDir = await seed({ "大文件.md": big });
    try {
      const { logger } = await runExtract(dataDir, { sceneCompaction: ON });
      const after = await fs.readFile(path.join(dataDir, "scene_blocks", "大文件.md"), "utf-8");
      expect(after).toContain("[compacted]");
      expect(after.length).toBeGreaterThan(CAP * 0.5);
      expect(anchorsOf(after)).toEqual(anchorsOf(big));
      expect(logger.lines.some((l) => l.includes("reason=insufficient_archive"))).toBe(true);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("Phase 5 压实接线：顺序与容错", () => {
  it("[DELETED] 软删文件不压实（先 soft-delete 判定再压实）", async () => {
    const dataDir = await seed({ "已删除.md": "[DELETED]", "小场景.md": batchFile(1) });
    try {
      await runExtract(dataDir, { sceneCompaction: ON });
      expect(mockedCompact).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(dataDir, "scene_blocks", "已删除.md"), "utf-8")).rejects.toThrow();
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("大体积 META-only 文件（无正文）直接清理，不进入压实", async () => {
    const metaOnly = [
      "-----META-START-----",
      "created: 2026-10-01T00:00:00.000Z",
      "updated: 2026-10-31T00:00:00.000Z",
      `summary: ${"超长摘要".repeat(400)}`, // > CAP，但正文为空
      "heat: 0",
      "-----META-END-----",
    ].join("\n");
    expect(metaOnly.length).toBeGreaterThan(CAP * 0.7);
    const dataDir = await seed({ "空壳.md": metaOnly });
    try {
      await runExtract(dataDir, { sceneCompaction: ON });
      expect(mockedCompact).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(dataDir, "scene_blocks", "空壳.md"), "utf-8")).rejects.toThrow();
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("单文件压实异常只 warn，后续文件继续处理且 L2 不中断", async () => {
    const bigA = batchFile(8, "甲");
    const bigB = batchFile(8, "乙");
    const dataDir = await seed({ "a大文件.md": bigA, "b大文件.md": bigB });
    try {
      // 第一次调用抛错（按 readdir 字典序先命中 a大文件.md），第二次恢复真实实现
      mockedCompact.mockImplementationOnce(() => {
        throw new Error("模拟压实失败");
      });
      const { result, logger } = await runExtract(dataDir, { sceneCompaction: ON });
      expect(result.success).toBe(true);
      expect(logger.lines.some((l) => l.startsWith("WARN") && l.includes("scene compaction error"))).toBe(true);
      const a = await fs.readFile(path.join(dataDir, "scene_blocks", "a大文件.md"), "utf-8");
      const b = await fs.readFile(path.join(dataDir, "scene_blocks", "b大文件.md"), "utf-8");
      expect(a).toBe(bigA); // 失败文件保持原样
      expect(b).not.toBe(bigB); // 后续文件仍被压实
      expect(b).toContain("[compacted]");
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
