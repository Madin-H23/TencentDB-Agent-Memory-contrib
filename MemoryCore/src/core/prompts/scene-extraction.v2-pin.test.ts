// 票⑤（exp/p1-5-scene-format-v2）off 兼容钉：sceneFormatV2 缺省/显式 false 时，
// systemPrompt 与 develop 基线（07d9057，含票④⑥）**双版本同进程逐字节一致**。
// 基线树经 `git show 07d9057:MemoryCore/<file>` 独立再生（scene-extraction.ts 及其
// 运行时依赖链 scene-format.ts / pii-redact.ts），动态 import 后与本模块对比——
// 非固定 hash 自证；基线再生方式与本仓 P1 程序票⑥复核段（git archive 先例）同源。
import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildSceneExtractionPrompt } from "./scene-extraction.js";

const BASELINE_REV = "07d9057";
const BASELINE_FILES = [
  "src/core/prompts/scene-extraction.ts",
  "src/core/scene/scene-format.ts",
  "src/utils/pii-redact.ts",
];

async function loadBaselinePromptModule(): Promise<typeof import("./scene-extraction.js")> {
  const tmpRoot = await fs.mkdtemp(path.join(process.cwd(), ".v2-pin-baseline-"));
  for (const rel of BASELINE_FILES) {
    const content = execSync(`git show ${BASELINE_REV}:MemoryCore/${rel}`, {
      cwd: path.resolve(process.cwd(), ".."),
      maxBuffer: 16 * 1024 * 1024,
    });
    const dest = path.join(tmpRoot, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content);
  }
  const mod = await import(pathToFileURL(path.join(tmpRoot, "src/core/prompts/scene-extraction.ts")).href);
  await fs.rm(tmpRoot, { recursive: true, force: true });
  return mod as typeof import("./scene-extraction.js");
}

const CASES = [
  { mode: "chat" as const, maxScenes: 15 },
  { mode: "chat" as const, maxScenes: 24 },
  { mode: "code" as const, maxScenes: 15 },
  { mode: "code" as const, maxScenes: 24 },
];

function buildCurrent(mode: "chat" | "code", maxScenes: number, opts?: { sceneFormatV2?: boolean; explicitInvalidation?: boolean }) {
  return buildSceneExtractionPrompt({
    memoriesJson: '[]',
    sceneSummaries: "(无已有场景)",
    currentTimestamp: "2026-10-31T00:00:00.000Z",
    maxScenes,
    promptMode: mode,
    ...opts,
  });
}

function buildBaseline(mod: typeof import("./scene-extraction.js"), mode: "chat" | "code", maxScenes: number, opts?: { sceneFormatV2?: boolean; explicitInvalidation?: boolean }) {
  return mod.buildSceneExtractionPrompt({
    memoriesJson: '[]',
    sceneSummaries: "(无已有场景)",
    currentTimestamp: "2026-10-31T00:00:00.000Z",
    maxScenes,
    promptMode: mode,
    ...opts,
  });
}

describe("票⑤ off 兼容钉（双版本同进程，基线=git show 07d9057）", () => {
  it("off（缺省/显式 false）× 4 变体：systemPrompt 与基线逐字节一致", async () => {
    const baseline = await loadBaselinePromptModule();
    for (const { mode, maxScenes } of CASES) {
      expect(buildCurrent(mode, maxScenes).systemPrompt).toBe(baseline.buildSceneExtractionPrompt({
        memoriesJson: '[]', sceneSummaries: "(无已有场景)", currentTimestamp: "2026-10-31T00:00:00.000Z", maxScenes, promptMode: mode,
      }).systemPrompt);
      expect(buildCurrent(mode, maxScenes, { sceneFormatV2: false }).systemPrompt).toBe(
        buildBaseline(baseline, mode, maxScenes, { sceneFormatV2: false }).systemPrompt,
      );
    }
  });

  it("off（缺省/false）userPrompt 与基线逐字节一致（on 只改 systemPrompt）", async () => {
    const baseline = await loadBaselinePromptModule();
    for (const { mode, maxScenes } of CASES) {
      expect(buildCurrent(mode, maxScenes).userPrompt).toBe(
        baseline.buildSceneExtractionPrompt({
          memoriesJson: '[]', sceneSummaries: "(无已有场景)", currentTimestamp: "2026-10-31T00:00:00.000Z", maxScenes, promptMode: mode,
        }).userPrompt,
      );
    }
  });

  it("票⑥ on（v2 off）路径未变：与基线 ⑥-on 逐字节一致", async () => {
    const baseline = await loadBaselinePromptModule();
    for (const { mode, maxScenes } of CASES) {
      expect(buildCurrent(mode, maxScenes, { explicitInvalidation: true }).systemPrompt).toBe(
        buildBaseline(baseline, mode, maxScenes, { explicitInvalidation: true }).systemPrompt,
      );
    }
  });
});

describe("票⑤ on 变体（同进程内断言）", () => {
  it("v2 on：systemPrompt 含三层结构规则块与段标题；off 不含", () => {
    const on = buildCurrent("chat", 24, { sceneFormatV2: true }).systemPrompt;
    expect(on).toContain("## 🗂️ 场景文件格式 v2（三层结构）");
    expect(on).toContain("## 要点");
    expect(on).toContain("## 事实");
    expect(on).toContain("## 活动");
    expect(on).toContain("includeArchive: true");
    expect(on).not.toContain("SUPERSEDED"); // v2 单开时不引入失效标记字样
    const off = buildCurrent("chat", 24).systemPrompt;
    expect(off).not.toContain("场景文件格式 v2");
  });

  it("v2 on + ⑥ on：追加「失效行落事实段内原地标记」衔接行", () => {
    const both = buildCurrent("chat", 24, { sceneFormatV2: true, explicitInvalidation: true }).systemPrompt;
    expect(both).toContain("原地**加 `[SUPERSEDED <ISO时间>]` 前缀标记失效（**不移入");
    expect(both).toContain("## 🚦 失效标记规则（recency-wins，显式失效）");
  });

  it("code family v2 on 同样注入；userPrompt 恒不变", () => {
    const on = buildCurrent("code", 24, { sceneFormatV2: true }).systemPrompt;
    expect(on).toContain("## 🗂️ 场景文件格式 v2（三层结构）");
    expect(buildCurrent("code", 24).userPrompt).toBe(buildCurrent("code", 24, { sceneFormatV2: true }).userPrompt);
    expect(buildCurrent("chat", 24).userPrompt).toBe(buildCurrent("chat", 24, { sceneFormatV2: true, explicitInvalidation: true }).userPrompt);
  });
});
