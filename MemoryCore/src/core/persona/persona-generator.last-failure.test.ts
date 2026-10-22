// PersonaGenerator 失败原因捕获契约（2026-10-22）：
//   generateLocalPersona 以**状态串**（"failed"）报失败、真实原因只落在内部日志
//   ⇒ pipeline-factory 抛出的任务级消息只剩包装文案（"Persona generation failed
//   (scope=…)"），面板无法归因（实测 10-22 五连败全是 opencode.ai 不可达，面板
//   却看不到原因）。现在 generator 把简短原因记在 lastFailureReason（≤300 字、
//   成功即清零），factory 抛出点通过 getLastFailureReason() 取用。
// 本仓此前没有 persona-generator 的测试文件（只有 sanitize 的纯函数测试），
// 这是第一个：用临时 dataDir + 桩 runner 走通两条真实失败路径（LLM 抛错 / LLM
// 完成但没写文件），不 mock 模块、不碰网络。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonaGenerator } from "./persona-generator.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "persona-last-failure-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeGenerator(runner: { run: (p: unknown) => Promise<string> }): PersonaGenerator {
  return new PersonaGenerator({
    dataDir: dir,
    config: undefined,
    model: "test-model",
    promptMode: "chat",
    memoryPrompt: undefined,
    backupCount: 1,
    logger: undefined,
    instanceId: undefined,
    llmRunner: runner as never,
    storage: undefined,
    traceContext: undefined,
  });
}

describe("PersonaGenerator getLastFailureReason", () => {
  it("初始为 undefined（未跑/成功后不留旧原因）", () => {
    const gen = makeGenerator({ run: async () => "ok" });
    expect(gen.getLastFailureReason()).toBeUndefined();
  });

  it("LLM runner 抛错 → 原因 = 错误消息（连接超时家族可归因）", async () => {
    const gen = makeGenerator({
      run: async () => {
        throw new Error("Cannot connect to API: Connect Timeout Error");
      },
    });
    const result = await gen.generateLocalPersona("timer");
    expect(result).toBe("failed");
    expect(gen.getLastFailureReason()).toBe("Cannot connect to API: Connect Timeout Error");
  });

  it("LLM 完成但没写 persona.md → 原因 = 文件缺失说明", async () => {
    const gen = makeGenerator({ run: async () => "runner done (wrote nothing)" });
    const result = await gen.generateLocalPersona("timer");
    expect(result).toBe("failed");
    expect(gen.getLastFailureReason()).toContain("did not write persona.md");
  });

  it("超长原因截 300 字（上游 APICallError 富化会拼 body 预览，不能整段进任务消息）", async () => {
    const long = "x".repeat(2000);
    const gen = makeGenerator({
      run: async () => {
        throw new Error(`Cannot connect to API: ${long}`);
      },
    });
    await gen.generateLocalPersona("timer");
    const reason = gen.getLastFailureReason() ?? "";
    expect(reason.length).toBeLessThanOrEqual(300);
    expect(reason.startsWith("Cannot connect to API:")).toBe(true);
  });

  it("失败后再次失败：旧原因被新原因覆盖（不串味）", async () => {
    let throwMsg = "first failure";
    const gen = makeGenerator({
      run: async () => {
        throw new Error(throwMsg);
      },
    });
    await gen.generateLocalPersona("timer");
    expect(gen.getLastFailureReason()).toBe("first failure");
    throwMsg = "second failure";
    await gen.generateLocalPersona("timer");
    expect(gen.getLastFailureReason()).toBe("second failure");
  });
});
