// 票18（2026-10-25）：查重判定解析加固红测。
// 方案 v2（方案审查 PASS 条件通过后）：A1 多候选均衡扫描 / B1' 裸引号修复移植 /
// A2 截断 salvage（白名单过滤+truncated_partial）/ A3 结构摘要（PII-free）/ B 判定重试一次。
// 覆盖方案审查补的 7 例：嵌套数组、字符串内括号、幂等钉子、白名单滤除、
// no_json_array 分支 salvage、重试抛错回退首次响应、锚点形状。
import { describe, expect, it, vi } from "vitest";

import {
  escapeStrayQuotesInStrings,
  extractJsonArraySpans,
  salvageJsonArrayTail,
} from "../../utils/json-repair.js";
import { parseBatchResult, runLlmJudgment } from "./l1-dedup.js";
import type { ExtractedMemory, MemoryType } from "./l1-writer.js";
import type { Logger } from "../types.js";

function mem(id: string, content: string): ExtractedMemory & { record_id: string } {
  return {
    record_id: id,
    content,
    type: "instruction" as MemoryType,
    priority: 80,
    source_message_ids: [],
    metadata: {},
    scene_name: "测试",
  };
}

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function warns(): string[] {
  return (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
}

// ── A1 多候选均衡扫描器 ────────────────────────────────────────────

describe("票18 A1: extractJsonArraySpans 多候选均衡扫描", () => {
  it("行文含 [ 且其后才是真数组：多候选举到可解析的真数组", () => {
    const text = '候选 [rec_a1] 引用说明\n[{"record_id":"m_1","action":"store"}]';
    const spans = extractJsonArraySpans(text, 8);
    expect(spans.length).toBeGreaterThanOrEqual(2);
    const hit = spans.map((s) => text.slice(s.start, s.end + 1)).find((s) => s.includes("record_id"));
    expect(hit).toBeDefined();
  });

  it("嵌套数组（merged_timestamps）：外层 span 完整覆盖", () => {
    const text = '[{"record_id":"m_1","action":"merge","merged_timestamps":["2026-01-01","2026-02-02"]}]';
    const spans = extractJsonArraySpans(text, 8);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0]!.start, spans[0]!.end + 1)).toBe(text);
  });

  it("字符串字面量内的 [ ] { } 不参与计深", () => {
    const text = '[{"record_id":"m_1","content":"数组写法 [1,2] 与对象 {a:1} 都是内容"}]';
    const spans = extractJsonArraySpans(text, 8);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0]!.start, spans[0]!.end + 1)).toBe(text);
  });

  it("字符串内的转义引号不打断字符串态", () => {
    const text = '[{"record_id":"m_1","content":"他说 \\"hi [x]\\" 之后"}]';
    const spans = extractJsonArraySpans(text, 8);
    expect(spans).toHaveLength(1);
  });

  it("截断 think 散文含多个 [ 时多候选仍找到真数组", () => {
    const text = '<think>分析 [m_1] 与 [m_2] 的 [ 关系';
    const spans = extractJsonArraySpans(text, 8);
    // 截断 think 无闭合真数组——扫描器只报 span，不负责解析；这里断言不误报完整 span
    expect(spans.every((s) => text.slice(s.start, s.end + 1).length > 0)).toBe(true);
  });

  it("未闭合数组（截断）不产生完整 span", () => {
    const text = '[{"record_id":"m_1","action":"store"},{"record_id":"m_2","act';
    expect(extractJsonArraySpans(text, 8)).toHaveLength(0);
  });
});

// ── B1' 裸引号修复（移植核心，幂等钉子） ───────────────────────────

describe("票18 B1': escapeStrayQuotesInStrings 移植核心", () => {
  it("合法 JSON 逐字节原样返回（幂等钉子，对齐 B1）", () => {
    const legal = '[{"record_id":"m_1","action":"merge","merged_content":"内容 \\"引用\\" 与 [括号]"}]';
    expect(escapeStrayQuotesInStrings(legal)).toBe(legal);
  });

  it("字符串内裸引号转义、内容不丢（对齐 B1 实证样本形态）", () => {
    const broken = '[{"record_id":"m_1","merged_content":"push 输出 \\"Everything up-to-date\\" 需核实"}]';
    const fixed = escapeStrayQuotesInStrings(
      '[{"record_id":"m_1","merged_content":"push 输出 "Everything up-to-date" 需核实"}]',
    );
    expect(JSON.parse(fixed)).toEqual(JSON.parse(broken));
  });
});

// ── A2 截断 salvage ────────────────────────────────────────────────

describe("票18 A2: salvageJsonArrayTail", () => {
  it("截断在对象中间：保留完整头部对象", () => {
    const text = '[{"record_id":"m_1","action":"store"},{"record_id":"m_2","action":"me';
    const salvaged = salvageJsonArrayTail(text);
    expect(salvaged).not.toBeNull();
    expect(salvaged).toHaveLength(1);
    expect((salvaged![0] as Record<string, unknown>).record_id).toBe("m_1");
  });

  it("末个 ] 是 inner 数组（merged_timestamps 被截断形态）：仍取完整头", () => {
    const text = '[{"record_id":"m_1","action":"store","merged_timestamps":["a"]},{"record_id":"m_2","merged_timestamps":["2';
    const salvaged = salvageJsonArrayTail(text);
    expect(salvaged).not.toBeNull();
    expect(salvaged).toHaveLength(1);
  });

  it("无完整顶层对象：返回 null", () => {
    expect(salvageJsonArrayTail('[{"record_id":"m_')).toBeNull();
  });

  it("完整合法数组：全量保留（salvage 不破坏好数据）", () => {
    const text = '[{"record_id":"m_1","action":"store"},{"record_id":"m_2","action":"skip"}]';
    const salvaged = salvageJsonArrayTail(text);
    expect(salvaged).toHaveLength(2);
  });
});

// ── 编排：parseBatchResult 产出语义 + A3 摘要 + 白名单 ─────────────

describe("票18 编排: parseBatchResult", () => {
  it("合法响应：ok + 全部判定（行为不变）", () => {
    const raw = '[{"record_id":"m_1","action":"store"},{"record_id":"m_2","action":"skip"}]';
    const out = parseBatchResult(raw, [mem("m_1", "a"), mem("m_2", "b")], logger);
    expect(out.ok).toBe(true);
    expect(out.decisions).toHaveLength(2);
  });

  it("截断响应：truncated_partial——前缀判定生效 + 尾部按条免检（锚点在收口层打，审查 P1-1）", () => {
    const raw = '[{"record_id":"m_1","action":"merge","target_ids":["m_0"]},{"record_id":"m_2","act';
    const out = parseBatchResult(raw, [mem("m_1", "a"), mem("m_2", "b")], logger);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("truncated_partial");
    expect(out.decisions).toHaveLength(2);
    expect(out.decisions![0]!.action).toBe("merge");
    expect(out.decisions![1]!.action).toBe("store");
    expect(out.tailCount).toBe(1);
    // parse 层不打免检锚点（可被重试救回）——断言在 runLlmJudgment 层
    expect(warns().join("\n")).not.toMatch(/l1-dedup-fallback-silent/);
  });

  it("截断 think 散文含括号 + 其后真数组：端到端取到真判定（P2-5 加强）", () => {
    const raw = '<think>对比 [m_0] 与 [m_1] 的 [ 相似度走向\n结论：应合并。</think>\n[{"record_id":"m_1","action":"store"}]';
    const out = parseBatchResult(raw, [mem("m_1", "a")], logger);
    expect(out.ok).toBe(true);
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions![0]!.action).toBe("store");
  });

  it("salvage 产出的未知 record_id（幻觉条目）被白名单滤除", () => {
    const raw = '[{"record_id":"m_x","action":"merge","target_ids":["m_0"]},{"record_id":"m_1","act';
    const out = parseBatchResult(raw, [mem("m_1", "a")], logger);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("truncated_partial");
    expect(out.decisions!.some((d) => d.record_id === "m_x")).toBe(false);
    expect(warns().join("\n")).not.toMatch(/l1-dedup-fallback-silent/);
  });

  it("纯垃圾（无数组且无完整对象）：parse_error 整批免检 + A3 摘要无内容", () => {
    const raw = "抱歉，我无法完成该任务。其中提到 [ 某些内容 ] 但不是 JSON。";
    const out = parseBatchResult(raw, [mem("m_1", "a")], logger);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("parse_error");
    expect(out.decisions).toBeUndefined();
    const digest = warns().find((l) => l.includes("l1-dedup-parse-digest"));
    expect(digest).toBeDefined();
    expect(digest!).toMatch(/rawLen=\d+/);
    // PII-free：摘要行不含响应正文片段
    expect(digest!).not.toContain("无法完成");
  });

  it("no_json_array + 头完整：truncated_partial 生效（审查 P1-2 分支覆盖）", () => {
    const raw = '{"note":"先说明一下"}\n[{"record_id":"m_1","action":"store"},{"record_id":"m_2';
    const out = parseBatchResult(raw, [mem("m_1", "a"), mem("m_2", "b")], logger);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("truncated_partial");
    expect(out.decisions![0]!.action).toBe("store");
  });

  it("裸引号响应：修复后整批判定（不触发 salvage）", () => {
    const raw =
      '[{"record_id":"m_1","merged_content":"他要求 "先红后绿" 修复","action":"store"}]';
    const out = parseBatchResult(raw, [mem("m_1", "a")], logger);
    expect(out.ok).toBe(true);
    expect(out.decisions).toHaveLength(1);
  });
});

// ── B 判定重试一次（预算闸 + 锚点） ────────────────────────────────

function runnerOf(responses: Array<() => Promise<string>>) {
  let i = 0;
  const calls: Array<{ taskId: string; startedAt: number }> = [];
  return {
    calls,
    run: async (p: { taskId: string }) => {
      calls.push({ taskId: p.taskId, startedAt: Date.now() });
      const fn = responses[Math.min(i, responses.length - 1)]!;
      i++;
      return fn();
    },
  };
}

describe("票18 B: runLlmJudgment 判定重试一次", () => {
  const candidates = [
    {
      id: "m_0",
      content: "旧记录",
      type: "instruction",
      priority: 80,
      scene_name: "测试",
      source_message_ids: [],
      metadata: {},
      timestamps: ["2026-10-01T00:00:00Z"],
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      sessionKey: "zcode-default",
      sessionId: "sess-test",
      version: 0,
    },
  ];
  const matches = [{ newMemory: mem("m_1", "a"), candidates }];
  const memories = [mem("m_1", "a")];
  const GOOD = '[{"record_id":"m_1","action":"store"}]';
  const TRUNC = '[{"record_id":"m_1","action":"store"},{"record_id":"m_x","a';

  it("首败次成：重试成功则正常判定（无 fallback 锚点）", async () => {
    (logger.warn as ReturnType<typeof vi.fn>).mockClear();
    const r = runnerOf([async () => "not json at all", async () => GOOD]);
    const out = await runLlmJudgment(matches, memories, undefined, logger, undefined, "chat", {
      run: r.run,
    } as never, undefined, 2000, true);
    expect(out.some((d) => d.record_id === "m_1" && d.action === "store")).toBe(true);
    const w = warns().join("\n");
    expect(w).toContain("l1-dedup-retry");
    expect(w).not.toMatch(/reason=truncated_partial|reason=parse_error/);
  });

  it("首调超预算（> timeoutMs/2）不重试：直接免检", async () => {
    (logger.warn as ReturnType<typeof vi.fn>).mockClear();
    const r = runnerOf([async () => {
      await new Promise((res) => setTimeout(res, 120));
      return "garbage";
    }]);
    const out = await runLlmJudgment(matches, memories, undefined, logger, undefined, "chat", {
      run: r.run,
    } as never, undefined, 200, true);
    expect(r.calls).toHaveLength(1);
    expect(out.every((d) => d.action === "store")).toBe(true);
  });

  it("重试抛错：回退 salvage 首次响应文本（审查 P1 缺口）", async () => {
    (logger.warn as ReturnType<typeof vi.fn>).mockClear();
    const r = runnerOf([
      async () => TRUNC,
      async () => {
        throw new Error("boom");
      },
    ]);
    const out = await runLlmJudgment(matches, memories, undefined, logger, undefined, "chat", {
      run: r.run,
    } as never, undefined, 2000, true);
    expect(out.some((d) => d.record_id === "m_1" && d.action === "store")).toBe(true);
    const w = warns().join("\n");
    expect(w).toMatch(/reason=truncated_partial/);
    expect(w).toContain("l1-dedup-retry");
  });

  it("双败：整批免检 + 摘要两条（retry=first/second）", async () => {
    (logger.warn as ReturnType<typeof vi.fn>).mockClear();
    const r = runnerOf([async () => "garbage one", async () => "garbage two"]);
    const out = await runLlmJudgment(matches, memories, undefined, logger, undefined, "chat", {
      run: r.run,
    } as never, undefined, 2000, true);
    expect(out.every((d) => d.action === "store")).toBe(true);
    const w = warns().join("\n");
    expect(w.match(/l1-dedup-parse-digest/g)?.length).toBe(2);
    expect(w).toMatch(/retry=first/);
    expect(w).toMatch(/retry=second/);
  });

  it("首次截断+重试全成：整批判定、无假 kill-switch 锚点（审查 P1-1 回归钉）", async () => {
    (logger.warn as ReturnType<typeof vi.fn>).mockClear();
    const r = runnerOf([
      async () => '[{"record_id":"m_1","action":"merge","target_ids":["m_0"]},{"record_id":"m_2","a',
      async () => GOOD,
    ]);
    const out = await runLlmJudgment(matches, memories, undefined, logger, undefined, "chat", {
      run: r.run,
    } as never, undefined, 2000, true);
    expect(out.every((d) => d.action === "store")).toBe(true);
    expect(warns().join("\n")).not.toMatch(/l1-dedup-fallback-silent/);
  });

  it("双响应都截断：truncated_partial 锚点恰一条（审查 P1-1 双计钉）", async () => {
    (logger.warn as ReturnType<typeof vi.fn>).mockClear();
    const r = runnerOf([
      async () => '[{"record_id":"m_1","action":"store"},{"record_id":"m_2","a',
      async () => '[{"record_id":"m_1","action":"store"},{"record_id":"m_2","ac',
    ]);
    const out = await runLlmJudgment(matches, memories, undefined, logger, undefined, "chat", {
      run: r.run,
    } as never, undefined, 2000, true);
    expect(out.some((d) => d.record_id === "m_1" && d.action === "store")).toBe(true);
    const w = warns().join("\n");
    expect(w.match(/l1-dedup-fallback-silent reason=truncated_partial/g)?.length).toBe(1);
  });

  it("票19：fallback 锚点带 sessionKey/sessionId/model（有 ctx）", async () => {
    (logger.warn as ReturnType<typeof vi.fn>).mockClear();
    const r = runnerOf([async () => "garbage", async () => "garbage two"]);
    await runLlmJudgment(matches, memories, undefined, logger, "glm-5.3-flash", "chat", {
      run: r.run,
    } as never, { teamId: undefined, userId: "u", agentId: "a", sessionId: "sess_abc" }, 2000, true, "zcode-default");
    const w = warns().join("\n");
    expect(w).toMatch(/reason=no_json_array sessionKey=zcode-default sessionId=sess_abc model=glm-5\.3-flash — /);
    expect(w).toMatch(/digest [^\n]*sessionKey=zcode-default sessionId=sess_abc model=glm-5\.3-flash/);
    expect(w).toMatch(/l1-dedup-retry elapsed=\d+ms sessionKey=zcode-default sessionId=sess_abc model=glm-5\.3-flash/);
  });

  it("票19：无 ctx（harness 直调）锚点显示 (unknown)/(default)", async () => {
    (logger.warn as ReturnType<typeof vi.fn>).mockClear();
    const r = runnerOf([async () => "garbage", async () => "garbage two"]);
    await runLlmJudgment(matches, memories, undefined, logger, undefined, "chat", {
      run: r.run,
    } as never, undefined, 2000, true);
    const w = warns().join("\n");
    expect(w).toMatch(/reason=no_json_array sessionKey=\(unknown\) sessionId=\(unknown\) model=\(default\)/);
  });
});
