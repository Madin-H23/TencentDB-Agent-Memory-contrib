// LLM 超时改为可配置，默认保持 180s（2026-09-25）
//
// 起因：上游 issue #1403 收到第三方生产数据——L1 去重（冲突检测）14 天 464 次调用
// 失败 143 次（31%），其中 66 次是 `defaulting all to store: The operation was
// aborted due to timeout`，根因指向 l1-dedup.ts 硬编码的 `timeoutMs: 180_000`。
//
// 本次改动的边界（刻意保守）：
//   - 只把「写死的 180_000」换成「可配置、默认仍是 180_000」，**默认行为逐字不变**；
//   - **不**改接 llm.timeoutMs：生产配置里它是 120_000，直接接上会让去重超时更严，
//     与修复意图相反。三个调用点各给独立旋钮。
//   - 上限提醒：Node 内置 fetch（undici）的 headersTimeout 默认 300s，且非流式
//     chat completions 只在生成完成后才发响应头——配到 600s 会被静默截到 ~300s。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** 从源码读取共享默认常量，避免测试与实现各写一份数字而漂移。 */
const DEDUP_SRC = readFileSync(resolve(import.meta.dirname, "l1-dedup.ts"), "utf8");
const EXTRACTOR_SRC = readFileSync(resolve(import.meta.dirname, "l1-extractor.ts"), "utf8");

describe("LLM 超时旋钮（默认 180s，行为不变）", () => {
  it("batchDedup 接受 timeoutMs 且默认 180_000", () => {
    expect(DEDUP_SRC).toMatch(/timeoutMs\?: number/);
    expect(DEDUP_SRC).toMatch(/const timeoutMs = params\.timeoutMs \?\? 180_000/);
    // 两处 runner 调用都必须用这个变量，不能再有裸 180_000
    const bareHardcodes = DEDUP_SRC.match(/timeoutMs: 180_000/g) ?? [];
    expect(bareHardcodes, "l1-dedup 不应再有裸写的 timeoutMs: 180_000").toHaveLength(0);
  });

  it("L1 抽取同样接受 timeoutMs 且默认 180_000", () => {
    // 断言行为而非具体表达式：默认值来自可配置参数、且不再有裸写的 180_000
    expect(EXTRACTOR_SRC).toMatch(/const llmTimeoutMs = params\.timeoutMs \?\? 180_000;/);
    expect(EXTRACTOR_SRC).toMatch(/timeoutMs: llmTimeoutMs,/);
    expect(EXTRACTOR_SRC, "l1-extractor 不应再有裸写的 timeoutMs: 180_000").not.toMatch(/timeoutMs: 180_000,/);
  });

  it("默认值 180_000 与改动前一致（回归护栏：默认行为不得变）", () => {
    const defaults = [...DEDUP_SRC.matchAll(/\?\? (180_000)/g), ...EXTRACTOR_SRC.matchAll(/\?\? (180_000)/g)];
    expect(defaults.length).toBeGreaterThanOrEqual(2);
    expect(defaults.every((m) => m[1] === "180_000")).toBe(true);
  });
});
