// C2（2026-10-16，继续中断的 A/B/C）：空响应按可重试族单独分类。
// 实证（10-15 16:37:31 rawLen=0）：模型返回空 content——现被归进 no_json、
// 打「structural garbage」延后。数据没丢（批次延后游标不动）但标签误导：
// 空响应是上游瞬态（厂商抽 tard/思考烧预算/截断），与「返回了但结构坏了」
// 是两种事。修法：parseExtractionResult 对 think 剥离/code fence 剥离后的
// 空内容返回 empty_response（L1EmptyReason 新成员），extractL1Memories 将其
// 纳入延后集并以 reason=empty_response 打标（不再是 parse_error 冒充）。
// 合法空判定（[]/0 memories）保持 empty_scenes 不延后——边界有专测。
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractL1Memories, L1ExtractionFailure } from "./l1-extractor.js";
import type { LLMRunner } from "../types.js";

const T = 1_700_000_000_000;

function runWithRaw(raw: string) {
  const llm = { run: async () => raw } as unknown as LLMRunner;
  const warns: string[] = [];
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (m: string) => warns.push(m),
    error: () => {},
  } as never;
  const baseDir = mkdtempSync(join(tmpdir(), "c2-empty-"));
  return extractL1Memories({
    messages: [{ id: "m1", role: "user" as const, content: "触发", timestamp: T }],
    sessionKey: "zcode-default",
    sessionId: "sess-c2",
    baseDir,
    config: {},
    logger,
    options: { enableDedup: false, promptMode: "chat", llmRunner: llm },
  })
    .then(
      (r) => ({ r, warns, err: undefined as unknown }),
      (err) => ({ r: undefined, warns, err }),
    )
    .finally(() => rmSync(baseDir, { recursive: true, force: true }));
}

const VALID_EMPTY_JUDGMENT = JSON.stringify([
  { scene_name: "s", message_ids: ["m1"], memories: [] },
]);

describe("C2：空响应分类为 empty_response（可重试族，不再是结构垃圾）", () => {
  it("空字符串响应 → empty_response 标签 + L1ExtractionFailure(reason=empty_response) 延后", async () => {
    const { warns, err } = await runWithRaw("");
    expect(warns.some((w) => w.includes("l1-empty reason=empty_response"))).toBe(true);
    expect(warns.some((w) => w.includes("l1-deferred reason=empty_response"))).toBe(true);
    expect(err).toBeInstanceOf(L1ExtractionFailure);
    expect((err as L1ExtractionFailure).reason).toBe("empty_response");
  });

  it("纯空白响应 → 同路径", async () => {
    const { warns, err } = await runWithRaw("   \n\t  ");
    expect(warns.some((w) => w.includes("reason=empty_response"))).toBe(true);
    expect((err as L1ExtractionFailure).reason).toBe("empty_response");
  });

  it("只剩 think 标签的响应 → think 剥离后为空 → empty_response", async () => {
    // 成对 think 标签包裹、无正文——A₂ 思考模型的「思考烧完预算、content 为空」形态
    const { warns, err } = await runWithRaw("<think>该记什么好呢……再想想……</think>");
    expect(warns.some((w) => w.includes("reason=empty_response"))).toBe(true);
    expect((err as L1ExtractionFailure).reason).toBe("empty_response");
  });

  it("边界：合法空判定（memories: []）保持 empty_scenes、不抛错不延后", async () => {
    const { r, err } = await runWithRaw(VALID_EMPTY_JUDGMENT);
    expect(err).toBeUndefined();
    expect(r!.storedCount).toBe(0);
  });

  it("边界：非空但无 JSON 数组仍是 no_json（不被空响应规则误吞）", async () => {
    const { warns, err } = await runWithRaw("完全不是JSON的一串字");
    expect(warns.some((w) => w.includes("reason=no_json"))).toBe(true);
    expect((err as L1ExtractionFailure).reason).toBe("parse_error");
  });
});
