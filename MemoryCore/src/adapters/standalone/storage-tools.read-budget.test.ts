// S0 影子计量：storage-tools 的 read 必须
//   1) 原样返回全文（零行为变更）；
//   2) 在超过 32K 时打 over_file=true；
//   3) 累计跨过 80K 的那一次打 crossed_run=true（且只打一次）。
import { describe, expect, it, vi } from "vitest";
import { createStorageTools } from "./storage-tools.js";

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeStorage(content: string) {
  return {
    readFile: vi.fn(async () => content),
    writeFile: vi.fn(async () => {}),
  } as any;
}

function warnLines(logger: ReturnType<typeof makeLogger>): string[] {
  return logger.warn.mock.calls.map((c) => String(c[0]));
}

describe("storage-tools 读取预算影子计量（S0）", () => {
  it("读取内容原样返回（零行为变更）", async () => {
    const content = "x".repeat(33_000);
    const tools = createStorageTools(makeStorage(content), "scene_blocks/", makeLogger());
    const out = await (tools.read as any).execute({ path: "big.md" });
    expect(out).toBe(content);
  });

  it("超过 32K 打 over_file=true 告警", async () => {
    const logger = makeLogger();
    const tools = createStorageTools(makeStorage("x".repeat(32_001)), "scene_blocks/", logger);
    await (tools.read as any).execute({ path: "big.md" });
    const lines = warnLines(logger);
    expect(lines.some((l) => l.includes("read-budget") && l.includes("over_file=true"))).toBe(true);
  });

  it("恰好 32K 不告警", async () => {
    const logger = makeLogger();
    const tools = createStorageTools(makeStorage("x".repeat(32_000)), "scene_blocks/", logger);
    await (tools.read as any).execute({ path: "exact.md" });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("累计跨过 80K 的那一次告警一次", async () => {
    const logger = makeLogger();
    const tools = createStorageTools(makeStorage("x".repeat(30_000)), "scene_blocks/", logger);
    await (tools.read as any).execute({ path: "a.md" });
    await (tools.read as any).execute({ path: "b.md" });
    expect(logger.warn).not.toHaveBeenCalled();
    await (tools.read as any).execute({ path: "c.md" });
    const lines = warnLines(logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("crossed_run=true");
  });
});
