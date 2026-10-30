// 方案C（exp/l2-plan-c-write-cap）：storage-tools 的 write/edit 写入后像尺寸帽。
// 语义：
//   1) 后像超帽 → 拒绝且**不落盘**（writeFile 不得被调用）；
//   2) 帽内（含恰好等于）→ 放行；
//   3) prefix 为空（L3 persona）→ 不受限；
//   4) write 内容为 "[DELETED]" → 不受帽限制；
//   5) sceneCharCap=0 / 未传 → off；
//   6) 拒绝响应是合法 JSON 且含 hint。
import { describe, expect, it, vi } from "vitest";
import { createStorageTools } from "./storage-tools.js";
import { SCENE_CHAR_CAP_HINT } from "../../utils/scene-char-cap.js";

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeStorage(existing?: string) {
  return {
    readFile: vi.fn(async () => existing ?? "not-read"),
    writeFile: vi.fn(async () => {}),
  } as any;
}

function parseOut(out: string): Record<string, unknown> {
  return JSON.parse(out) as Record<string, unknown>;
}

const CAP = 1000;

describe("storage-tools 写入后像尺寸帽（方案C）", () => {
  it("write 超帽 → 拒绝且不落盘", async () => {
    const storage = makeStorage();
    const tools = createStorageTools(storage, "scene_blocks/", makeLogger(), undefined, CAP);
    const out = await (tools.write as any).execute({ path: "s1.md", content: "x".repeat(CAP + 1) });
    expect(parseOut(out).error).toBe("over_scene_char_cap");
    expect(storage.writeFile).not.toHaveBeenCalled();
  });

  it("edit 超帽（后像 1001）→ 拒绝且不落盘", async () => {
    const storage = makeStorage("A".repeat(990));
    const tools = createStorageTools(storage, "scene_blocks/", makeLogger(), undefined, CAP);
    const out = await (tools.edit as any).execute({
      path: "s1.md",
      edits: [{ oldText: "A", newText: "B".repeat(12) }], // 990-1+12=1001
    });
    expect(parseOut(out).error).toBe("over_scene_char_cap");
    expect(storage.writeFile).not.toHaveBeenCalled();
  });

  it("edit 后像恰好等于帽（1000）→ 放行", async () => {
    const storage = makeStorage("A".repeat(990));
    const tools = createStorageTools(storage, "scene_blocks/", makeLogger(), undefined, CAP);
    const out = await (tools.edit as any).execute({
      path: "s1.md",
      edits: [{ oldText: "A", newText: "B".repeat(11) }], // 990-1+11=1000
    });
    expect(parseOut(out).success).toBe(true);
    expect(storage.writeFile).toHaveBeenCalledTimes(1);
  });

  it("write 帽内（恰好等于帽）→ 放行", async () => {
    const storage = makeStorage();
    const tools = createStorageTools(storage, "scene_blocks/", makeLogger(), undefined, CAP);
    const out = await (tools.write as any).execute({ path: "s1.md", content: "x".repeat(CAP) });
    expect(parseOut(out).success).toBe(true);
    expect(storage.writeFile).toHaveBeenCalledWith("scene_blocks/s1.md", "x".repeat(CAP));
  });

  it("prefix 为空（L3 persona）→ 不受限", async () => {
    const storage = makeStorage();
    const tools = createStorageTools(storage, "", makeLogger(), undefined, CAP);
    const out = await (tools.write as any).execute({ path: "persona.md", content: "x".repeat(50_000) });
    expect(parseOut(out).success).toBe(true);
    expect(storage.writeFile).toHaveBeenCalledTimes(1);
  });

  it("write 内容为 '[DELETED]' → 不受帽限制", async () => {
    const storage = makeStorage();
    const tools = createStorageTools(storage, "scene_blocks/", makeLogger(), undefined, 5);
    const out = await (tools.write as any).execute({ path: "s1.md", content: "[DELETED]" });
    expect(parseOut(out).success).toBe(true);
    expect(storage.writeFile).toHaveBeenCalledWith("scene_blocks/s1.md", "[DELETED]");
  });

  it("sceneCharCap=0 → 关闭（超长放行）", async () => {
    const storage = makeStorage();
    const tools = createStorageTools(storage, "scene_blocks/", makeLogger(), undefined, 0);
    const out = await (tools.write as any).execute({ path: "s1.md", content: "x".repeat(50_000) });
    expect(parseOut(out).success).toBe(true);
  });

  it("sceneCharCap 未传 → 关闭（既有调用方行为不变）", async () => {
    const storage = makeStorage();
    const tools = createStorageTools(storage, "scene_blocks/", makeLogger());
    const out = await (tools.write as any).execute({ path: "s1.md", content: "x".repeat(50_000) });
    expect(parseOut(out).success).toBe(true);
  });

  it("拒绝响应是合法 JSON 且字段完整（含 hint）", async () => {
    const storage = makeStorage();
    const tools = createStorageTools(storage, "scene_blocks/", makeLogger(), undefined, CAP);
    const out = await (tools.write as any).execute({ path: "s1.md", content: "x".repeat(CAP + 7) });
    const parsed = parseOut(out); // 不抛 = 合法 JSON
    expect(parsed).toMatchObject({
      error: "over_scene_char_cap",
      chars: CAP + 7,
      cap: CAP,
      overflow: 7,
      hint: SCENE_CHAR_CAP_HINT,
    });
  });

  it("edit 拒绝响应同样是结构化 JSON（含 hint）", async () => {
    const storage = makeStorage("A".repeat(990));
    const tools = createStorageTools(storage, "scene_blocks/", makeLogger(), undefined, CAP);
    const out = await (tools.edit as any).execute({
      path: "s1.md",
      edits: [{ oldText: "A", newText: "B".repeat(12) }],
    });
    expect(parseOut(out).hint).toBe(SCENE_CHAR_CAP_HINT);
  });
});
