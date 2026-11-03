// 票⑨（exp/p1-9-scene-v2-migration）：本地沙箱（createSandboxedTools，经
// StandaloneLLMRunner）的惰性迁移——与 storage-tools.v2-migration.test.ts 同构
// （枚举面 = 本地 fs）。顺序钉：edits → 锚点守卫 → toV2Format → 帽 → 落盘。
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const calls: Array<Record<string, unknown>> = [];

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(async (params: Record<string, unknown>) => {
      calls.push(params);
      return { text: "ok", usage: {}, steps: [] };
    }),
    streamText: vi.fn((params: Record<string, unknown>) => {
      calls.push(params);
      const result = {
        text: Promise.resolve("ok"),
        totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
        steps: Promise.resolve([]),
      };
      return Object.assign(Promise.resolve(result), result);
    }),
  };
});

const { StandaloneLLMRunner } = await import("./llm-runner.js");
const { ANCHOR_RE } = await import("../../utils/supersede.js");
const { toV2Format } = await import("../../core/scene/scene-format-v2.js");

const CONFIG = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "test-model",
  maxTokens: 1024,
  timeoutMs: 30_000,
};

async function makeRunnerTools(opts: {
  sceneFormatV2?: boolean;
  explicitInvalidation?: boolean;
  sceneCharCap?: number;
}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-v2-migrate-"));
  const runner = new StandaloneLLMRunner({
    config: CONFIG,
    model: "test-model",
    enableTools: true,
  });
  await runner.run({
    systemPrompt: "s",
    prompt: "p",
    taskId: "v2-migrate-test",
    workspaceDir: dir,
    ...(opts.sceneFormatV2 !== undefined ? { sceneFormatV2: opts.sceneFormatV2 } : {}),
    ...(opts.explicitInvalidation !== undefined ? { explicitInvalidation: opts.explicitInvalidation } : {}),
    ...(opts.sceneCharCap !== undefined ? { sceneCharCap: opts.sceneCharCap } : {}),
  });
  const tools = (calls[calls.length - 1] as any)?.tools;
  return { dir, tools };
}

type Exec = (a: unknown) => Promise<string>;

const V1_BATCH = [
  "-----META-START-----",
  "created: 2026-08-28T01:44:31.671Z",
  "updated: 2026-10-29T09:18:10.943Z",
  "summary: 用户在维护记忆系统，当前聚焦 v2 迁移与帽压力治理。",
  "heat: 244",
  "-----META-END-----",
  "",
  "## ★10-29 09:18Z 本批 —— 运行更新",
  "",
  "- **★实跑闭环（记忆ID: m_1793265391167_4a35e058）**：完成日报生成。",
  "- **★同源重投复验（零新增）**：15 条旧记忆同源复验。",
  "",
  "## ★10-28 02:36Z 本批 —— 另一批",
  "",
  "- 旧事实 m_1793153662241_0c722b76 仍在。",
].join("\n");

function anchors(s: string): string[] {
  return s.match(ANCHOR_RE) ?? [];
}

describe("沙箱 v2 惰性迁移：write/edit", () => {
  it("on：write v1/批次内容 → 落盘即 v2 三段，锚点多重集不变", async () => {
    const { dir, tools } = await makeRunnerTools({ sceneFormatV2: true });
    const out = await (tools.write.execute as unknown as Exec)({ path: "a.md", content: V1_BATCH });
    expect(JSON.parse(out).success).toBe(true);
    const persisted = await fs.readFile(path.join(dir, "a.md"), "utf-8");
    expect(persisted).toContain("## 要点\n用户在维护记忆系统，当前聚焦 v2 迁移与帽压力治理。");
    expect(persisted).toContain("### ★10-29 09:18Z 本批 —— 运行更新");
    expect(anchors(persisted)).toEqual(anchors(V1_BATCH));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("off：write v1 内容逐字节基线", async () => {
    const { dir, tools } = await makeRunnerTools({ sceneFormatV2: false });
    await (tools.write.execute as unknown as Exec)({ path: "a.md", content: V1_BATCH });
    expect(await fs.readFile(path.join(dir, "a.md"), "utf-8")).toBe(V1_BATCH);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("on：edit 用迁移前 oldText 命中；落盘为 v2", async () => {
    const { dir, tools } = await makeRunnerTools({ sceneFormatV2: true });
    await fs.writeFile(path.join(dir, "a.md"), V1_BATCH, "utf-8");
    const out = await (tools.edit.execute as unknown as Exec)({
      path: "a.md",
      edits: [{ oldText: "- **★同源重投复验（零新增）**：15 条旧记忆同源复验。", newText: "- 复验完成（零新增）。" }],
    });
    expect(JSON.parse(out).success).toBe(true);
    const persisted = await fs.readFile(path.join(dir, "a.md"), "utf-8");
    expect(persisted).toContain("## 事实");
    expect(persisted).toContain("- 复验完成（零新增）。");
    expect(anchors(persisted)).toEqual(anchors(V1_BATCH));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("on + ⑥ on：edit 删除锚点行 → 守卫拒绝且文件保持 v1 原样", async () => {
    const { dir, tools } = await makeRunnerTools({ sceneFormatV2: true, explicitInvalidation: true });
    await fs.writeFile(path.join(dir, "a.md"), V1_BATCH, "utf-8");
    const out = await (tools.edit.execute as unknown as Exec)({
      path: "a.md",
      edits: [{ oldText: "- 旧事实 m_1793153662241_0c722b76 仍在。", newText: "" }],
    });
    expect(JSON.parse(out).error).toBe("anchor_loss_forbidden");
    expect(await fs.readFile(path.join(dir, "a.md"), "utf-8")).toBe(V1_BATCH);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("on：[DELETED] 不转换", async () => {
    const { dir, tools } = await makeRunnerTools({ sceneFormatV2: true });
    await fs.writeFile(path.join(dir, "a.md"), V1_BATCH, "utf-8");
    await (tools.write.execute as unknown as Exec)({ path: "a.md", content: "[DELETED]" });
    expect(await fs.readFile(path.join(dir, "a.md"), "utf-8")).toBe("[DELETED]");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("on：帽在迁移之后检查（原始长度放行、迁移后超帽拒绝）", async () => {
    const migrated = toV2Format(V1_BATCH);
    expect(migrated.length).toBeGreaterThan(V1_BATCH.length);
    const { dir, tools } = await makeRunnerTools({ sceneFormatV2: true, sceneCharCap: V1_BATCH.length });
    const out = await (tools.write.execute as unknown as Exec)({ path: "cap.md", content: V1_BATCH });
    expect(JSON.parse(out).error).toBe("over_scene_char_cap");
    await expect(fs.readFile(path.join(dir, "cap.md"), "utf-8")).rejects.toThrow();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("on：画像类结构化段默认可见，批次叙事默认折叠（与 storage 同构）", async () => {
    const { dir, tools } = await makeRunnerTools({ sceneFormatV2: true });
    const mixed = [
      "-----META-START-----",
      "summary: 画像与批次混合。",
      "-----META-END-----",
      "",
      "## 用户偏好",
      "- 喜欢深色模式",
      "",
      "## ★10-29 本批",
      "- 本批过程叙事。",
      "- 事实 m_1793265391167_4a35e058",
    ].join("\n");
    await (tools.write.execute as unknown as Exec)({ path: "m.md", content: mixed });
    const def = await (tools.read.execute as unknown as Exec)({ path: "m.md" });
    expect(def).toContain("- 喜欢深色模式");
    expect(def).not.toContain("本批过程叙事。");
    const full = await (tools.read.execute as unknown as Exec)({ path: "m.md", includeArchive: true });
    expect(full).toContain("本批过程叙事。");
    expect(anchors(full as string)).toEqual(anchors(mixed));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("on：迁移后默认 read 折叠活动段，includeArchive 返回全量", async () => {
    const { dir, tools } = await makeRunnerTools({ sceneFormatV2: true });
    await (tools.write.execute as unknown as Exec)({ path: "a.md", content: V1_BATCH });
    const def = await (tools.read.execute as unknown as Exec)({ path: "a.md" });
    expect(def).not.toContain("## 活动");
    expect(def).toContain("## 事实");
    const full = await (tools.read.execute as unknown as Exec)({ path: "a.md", includeArchive: true });
    expect(full).toContain("## 活动");
    expect(anchors(full as string)).toEqual(anchors(V1_BATCH));
    await fs.rm(dir, { recursive: true, force: true });
  });
});
