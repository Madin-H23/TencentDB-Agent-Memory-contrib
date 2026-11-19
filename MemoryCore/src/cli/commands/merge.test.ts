// SPEC-E T05：影子 CLI（plan/execute/recover）行为测试。
// 只验证隔离 dataDir 的命令面：plan 零写、execute 收敛、mode=off 拒绝、
// 生产目录/缺参拒绝、recover 空 journal。不触达生产数据。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SeedCliContext } from "../index.js";
import { assertIsolatedDataDir, runMergeCli, type MergeCliIo } from "./merge.js";

const NOW = "2026-11-19T10:00:00.000Z";
const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDataDir(prefix = "merge-cli-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  mkdirSync(join(dir, "scene_blocks"), { recursive: true });
  return dir;
}

function sceneRaw(anchor: string, label: string, created: string, heat = 1): string {
  return [
    "-----META-START-----",
    "created: " + created,
    "updated: " + created,
    "summary: 旧摘要",
    "heat: " + heat,
    "-----META-END-----",
    "",
    "## 要点",
    "- " + label + " 要点一",
    "",
    "## 事实",
    "- " + label + " 事实（记忆ID: " + anchor + "）",
    "",
    "## 活动",
    "- " + label + " 活动一",
  ].join("\n");
}

function writeScene(dataDir: string, name: string, raw: string): void {
  writeFileSync(join(dataDir, "scene_blocks", name), raw, "utf8");
}

function baseCtx(mergeScene: unknown = { mode: "shadow" }): SeedCliContext {
  return {
    config: {},
    pluginConfig: { persona: { sceneCharCap: 500_000, mergeScene } },
    stateDir: join(tmpdir(), "merge-cli-state"),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

function capture(): { io: MergeCliIo; lines: string[]; errLines: string[] } {
  const lines: string[] = [];
  const errLines: string[] = [];
  return { io: { out: (l) => lines.push(l), err: (l) => errLines.push(l) }, lines, errLines };
}

function jsonPayloads(lines: string[]): Array<Record<string, unknown>> {
  return lines
    .join("\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function singleJson(lines: string[]): Record<string, unknown> {
  const payloads = jsonPayloads(lines);
  expect(payloads).toHaveLength(1);
  return payloads[0];
}

function seedPair(): string {
  const dataDir = tempDataDir();
  writeScene(dataDir, "alpha.md", sceneRaw("m_1795000000000_aaaaaaaa", "alpha", "2026-11-01T00:00:00.000Z", 1));
  writeScene(dataDir, "beta.md", sceneRaw("m_1795000000001_bbbbbbbb", "beta", "2026-11-02T00:00:00.000Z", 5));
  return dataDir;
}

function planArgs(dataDir: string): string[] {
  return [
    "plan",
    "--data-dir", dataDir,
    "--a", "alpha.md",
    "--b", "beta.md",
    "--target", "merged-scene.md",
    "--now", NOW,
  ];
}

describe("assertIsolatedDataDir", () => {
  it("缺 --data-dir → DATA_DIR_REQUIRED", () => {
    expect(() => assertIsolatedDataDir(undefined)).toThrow(/必须显式传 --data-dir/);
    expect(() => assertIsolatedDataDir("   ")).toThrow(/必须显式传 --data-dir/);
  });

  it("不存在的目录 → DATA_DIR_NOT_FOUND", () => {
    const missing = join(tmpdir(), "merge-cli-missing-" + Date.now());
    expect(existsSync(missing)).toBe(false);
    expect(() => assertIsolatedDataDir(missing)).toThrow(/不存在或不是目录/);
  });

  it("生产数据目录（homedir/.memory-tencentdb 之下）→ PROD_DATA_DIR_FORBIDDEN", () => {
    const prod = join(homedir(), ".memory-tencentdb");
    expect(() => assertIsolatedDataDir(prod)).toThrow(/拒绝生产数据目录/);
    expect(() => assertIsolatedDataDir(join(prod, "memory-tdai", "profiles"))).toThrow(/拒绝生产数据目录/);
  });

  it("普通隔离目录 → 规范化绝对路径", () => {
    const dataDir = tempDataDir();
    expect(assertIsolatedDataDir(dataDir)).toBe(dataDir);
  });
});

describe("merge CLI plan", () => {
  it("输出单行 JSON 且零写盘", async () => {
    const dataDir = seedPair();
    const beforeNames = readdirSync(join(dataDir, "scene_blocks")).sort();
    const beforeA = readFileSync(join(dataDir, "scene_blocks", "alpha.md"), "utf8");
    const { io, lines } = capture();

    const code = await runMergeCli(planArgs(dataDir), baseCtx(), io);

    expect(code).toBe(0);
    const payload = singleJson(lines);
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe("plan");
    expect(payload.target).toBe("merged-scene.md");
    expect(typeof payload.key).toBe("string");
    const metrics = payload.metrics as Record<string, unknown>;
    expect(metrics.anchorsIn).toBe(2);
    expect(metrics.anchorLost).toBe(0);
    expect(metrics.bodyLinesLost).toBe(0);

    expect(readdirSync(join(dataDir, "scene_blocks")).sort()).toEqual(beforeNames);
    expect(readFileSync(join(dataDir, "scene_blocks", "alpha.md"), "utf8")).toBe(beforeA);
    expect(existsSync(join(dataDir, ".metadata"))).toBe(false);
  });

  it("缺必填参数 → 退出码 2 且 JSON 报错", async () => {
    const dataDir = seedPair();
    const { io, lines } = capture();
    const code = await runMergeCli(["plan", "--data-dir", dataDir], baseCtx(), io);
    expect(code).toBe(2);
    const payload = singleJson(lines);
    expect(payload.ok).toBe(false);
    expect((payload.error as Record<string, unknown>).code).toBe("CLI_USAGE");
  });

  it("生产目录 → PROD_DATA_DIR_FORBIDDEN 且退出码 2", async () => {
    const prod = join(homedir(), ".memory-tencentdb");
    const { io, lines } = capture();
    const code = await runMergeCli(
      ["plan", "--data-dir", prod, "--a", "a.md", "--b", "b.md", "--target", "m.md"],
      baseCtx(),
      io,
    );
    expect(code).toBe(2);
    const payload = singleJson(lines);
    expect((payload.error as Record<string, unknown>).code).toBe("PROD_DATA_DIR_FORBIDDEN");
  });
});

describe("merge CLI execute", () => {
  it("shadow 配置下合并两个场景并收敛为 1 个活动文件", async () => {
    const dataDir = seedPair();
    const { io, lines } = capture();
    const code = await runMergeCli(
      [
        "execute",
        "--data-dir", dataDir,
        "--a", "alpha.md",
        "--b", "beta.md",
        "--target", "merged-scene.md",
        "--now", NOW,
      ],
      baseCtx(),
      io,
    );

    expect(code).toBe(0);
    const payload = singleJson(lines);
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe("execute");
    expect(payload.status).toBe("merged");
    expect(payload.indexCount).toBe(1);
    const journalPath = payload.journalPath as string;
    expect(typeof journalPath).toBe("string");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { stage: string };
    expect(journal.stage).toBe("done");

    expect(readdirSync(join(dataDir, "scene_blocks")).sort()).toEqual(["merged-scene.md"]);
    expect(existsSync(join(dataDir, ".metadata", "merge.lock"))).toBe(false);
    const cRaw = readFileSync(join(dataDir, "scene_blocks", "merged-scene.md"), "utf8");
    expect(cRaw).toContain("alpha 事实");
    expect(cRaw).toContain("beta 事实");
  });

  it("mode=off 时拒绝执行且零写盘", async () => {
    const dataDir = seedPair();
    const before = readdirSync(join(dataDir, "scene_blocks")).sort();
    const { io, lines } = capture();
    const code = await runMergeCli(
      [
        "execute",
        "--data-dir", dataDir,
        "--a", "alpha.md",
        "--b", "beta.md",
        "--target", "merged-scene.md",
      ],
      baseCtx({ mode: "off" }),
      io,
    );

    expect(code).toBe(2);
    const payload = singleJson(lines);
    expect((payload.error as Record<string, unknown>).code).toBe("MERGE_MODE_OFF");
    expect(readdirSync(join(dataDir, "scene_blocks")).sort()).toEqual(before);
    expect(existsSync(join(dataDir, ".metadata"))).toBe(false);
  });
});

describe("merge CLI recover", () => {
  it("无 journal 时输出 scanned=0 且退出码 0", async () => {
    const dataDir = seedPair();
    const { io, lines } = capture();
    const code = await runMergeCli(["recover", "--data-dir", dataDir], baseCtx(), io);

    expect(code).toBe(0);
    const payload = singleJson(lines);
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe("recover");
    expect(payload.scanned).toBe(0);
    expect(payload.outcomes).toEqual([]);
  });
});

describe("merge CLI help", () => {
  it("--help 退出码 0 且列出三个子命令", async () => {
    const { io, lines } = capture();
    const code = await runMergeCli(["--help"], baseCtx(), io);
    expect(code).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("plan");
    expect(text).toContain("execute");
    expect(text).toContain("recover");
  });
});
