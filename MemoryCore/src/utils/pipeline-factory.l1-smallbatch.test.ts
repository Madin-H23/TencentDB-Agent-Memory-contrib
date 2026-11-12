// 票 P2-A2（exp/p2-a2-l1-smallbatch-defer）：L1 runner 的小批延后攒批接线测试。
// 复用 pipeline-factory.multisid.test.ts 的 JSONL harness（真实回退读取路径）。
//
// 红线机械化证明（零内容丢失）：deferred 轮不调 markL1ExtractionComplete ⇒ 游标
// 不动 ⇒ 下轮 DB/JSONL 查询 >cursor 必含旧+新消息 ⇒ 攒批成立。本文件以「跨轮累积
// 闭合」钉死：3 条 defer → 新增 2 条 qualified=5 → 提取且游标进到全片 max。
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createL1Runner, L1_BATCH_QUERY } from "./pipeline-factory.js";
import { CheckpointManager } from "./checkpoint.js";
import type { LLMRunner, Logger } from "../core/types.js";
import type { L1SmallBatchDeferConfig } from "./l1-smallbatch-defer.js";

const T0 = 1_700_000_000_000;
// defer 用例的 recordedAt 基准：age 判据起算=切片最旧行（P1-3），必须落在
// maxDeferAgeMs（30min）内才能 defer——用「现在-60s」而不是远古 T0。
const NOW = Date.now();
const RECENT = NOW - 60_000;
const SESSION_KEY = "zcode-default";
const CP_PATH = ".metadata/recall_checkpoint.json";

interface CapturedCall {
  prompt: string;
}

function msg(id: string, role: "user" | "assistant", content: string, ts: number) {
  return { id, role, content, timestamp: ts };
}

/** 写 L0 平铺行（conversations/YYYY-MM-DD.jsonl，与 l0-recorder 生产格式逐字一致） */
function appendL0(baseDir: string, sessionId: string, messages: ReturnType<typeof msg>[], recordedAtMs: number) {
  const convDir = join(baseDir, "conversations");
  mkdirSync(convDir, { recursive: true });
  const lines = messages.map((m) =>
    JSON.stringify({
      sessionKey: SESSION_KEY,
      sessionId,
      userId: "default",
      agentId: "default",
      recordedAt: new Date(recordedAtMs).toISOString(),
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    }),
  );
  const date = new Date(recordedAtMs).toISOString().slice(0, 10);
  writeFileSync(join(convDir, `${date}.jsonl`), lines.join("\n") + "\n", { flag: "a", encoding: "utf-8" });
}

/** 单行单毫秒写入（边界对齐/残余行场景需要每行 distinct recordedAtMs） */
function appendL0One(baseDir: string, sessionId: string, m: ReturnType<typeof msg>, recordedAtMs: number) {
  appendL0(baseDir, sessionId, [m], recordedAtMs);
}

/** llmRunner 桩：恒返回一条 scene（message_ids=m1），并捕获 prompt 供断言 */
function makeFakeLlm(calls: CapturedCall[]): LLMRunner {
  return {
    run: async (p: { prompt: string }) => {
      calls.push({ prompt: p.prompt });
      return JSON.stringify([
        { scene_name: "攒批场景", message_ids: ["m1"], memories: [{ type: "episodic", content: "甲线事实：项目甲在推进", priority: 50 }] },
      ]);
    },
  } as unknown as LLMRunner;
}

function makeRunner(
  baseDir: string,
  calls: CapturedCall[],
  infoLines: string[],
  deferCfg?: L1SmallBatchDeferConfig | Record<string, unknown>,
) {
  return createL1Runner({
    pluginDataDir: baseDir,
    cfg: {
      extraction: { enableDedup: false, maxMemoriesPerSession: 10 },
      embedding: {},
      ...(deferCfg ? { persona: { l1SmallBatchDefer: deferCfg } } : {}),
    } as never,
    openclawConfig: undefined,
    vectorStore: undefined, // 走 JSONL 回退读取路径（真实生产回退路径）
    embeddingService: undefined,
    logger: {
      debug: () => {},
      info: (m: string) => infoLines.push(m),
      warn: () => {},
      error: () => {},
    } as unknown as Logger,
    llmRunner: makeFakeLlm(calls),
  });
}

/** 读游标（无 checkpoint 文件 = 从未推进 = 「未处理」的证明，同 multisid 先例） */
function readCursor(baseDir: string): number {
  const cpPath = join(baseDir, CP_PATH);
  if (!existsSync(cpPath)) return 0;
  const cp = JSON.parse(readFileSync(cpPath, "utf-8")) as {
    runner_states?: Record<string, { last_l1_cursor?: number }>;
  };
  return cp.runner_states?.[SESSION_KEY]?.last_l1_cursor ?? 0;
}

const metricLines = (infoLines: string[]) => infoLines.filter((l) => l.includes("metric=l1_smallbatch_shadow"));

const ON_CFG: L1SmallBatchDeferConfig = {
  enabled: true,
  mode: "on",
  minMessages: 5,
  minChars: 200,
  maxDeferAgeMs: 1_800_000,
};

describe("L1 runner：小批延后攒批接线（票 P2-A2）", () => {
  it("on·低于门槛 → deferred 专用形状：extractL1Memories 零调用 + markL1ExtractionComplete 零调用 + 两 flag false", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l1sb-a-"));
    const markSpy = vi.spyOn(CheckpointManager.prototype, "markL1ExtractionComplete");
    try {
      const calls: CapturedCall[] = [];
      const infoLines: string[] = [];
      // 3 条 qualified（<K5）·chars 30（<200）·age 60s（<30min）·无残余
      appendL0(baseDir, "sess-A", [msg("m1", "user", "消息一：今天讨论了排期", RECENT)], RECENT + 100);
      appendL0(baseDir, "sess-A", [msg("m2", "user", "消息二：明天继续对齐", RECENT + 1)], RECENT + 200);
      appendL0(baseDir, "sess-A", [msg("m3", "user", "消息三：周末再Review", RECENT + 2)], RECENT + 300);
      const r = await makeRunner(baseDir, calls, infoLines, ON_CFG)({ sessionKey: SESSION_KEY });
      // 零 LLM 调用（不调 extractL1Memories ⇒ 每组一次 LLM 的池根本不启动）
      expect(calls.length).toBe(0);
      // 零游标落盘（markL1ExtractionComplete 未被调用）
      expect(markSpy).not.toHaveBeenCalled();
      expect(readCursor(baseDir)).toBe(0);
      // 专用返回形状（P0-3：避开 hasFullBacklog 热循环）
      expect(r.deferred).toBe(true);
      expect(r.hasMore).toBe(false);
      expect(r.hasFullBacklog).toBe(false);
      expect(r.storedCount).toBe(0);
      // on 模式不打 shadow 计量行
      expect(metricLines(infoLines).length).toBe(0);
    } finally {
      markSpy.mockRestore();
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("deferred 轮游标不动 ⇒ 攒批闭合：3 条 defer 后新增 2 条（qualified=5）→ 提取且游标进到全片 max", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l1sb-b-"));
    try {
      const calls: CapturedCall[] = [];
      const infoLines: string[] = [];
      const runner = () => makeRunner(baseDir, calls, infoLines, ON_CFG)({ sessionKey: SESSION_KEY });
      // 第一轮：3 条 qualified < K → defer、游标不动
      appendL0(baseDir, "sess-A", [msg("m1", "user", "消息一：今天讨论了排期", RECENT)], RECENT + 100);
      appendL0(baseDir, "sess-A", [msg("m2", "user", "消息二：明天继续对齐", RECENT + 1)], RECENT + 200);
      appendL0(baseDir, "sess-A", [msg("m3", "user", "消息三：周末再Review", RECENT + 2)], RECENT + 300);
      const r1 = await runner();
      expect(r1.deferred).toBe(true);
      expect(calls.length).toBe(0);
      expect(readCursor(baseDir)).toBe(0);
      // 第二轮：新增 2 条——游标未动 ⇒ 查询窗口含旧 3 条 + 新 2 条 = qualified 5 ≥ K
      appendL0(baseDir, "sess-A", [msg("m4", "user", "消息四：确认了里程碑", RECENT + 3)], RECENT + 400);
      appendL0(baseDir, "sess-A", [msg("m5", "user", "消息五：同步给干系人", RECENT + 4)], RECENT + 500);
      const r2 = await runner();
      expect(r2.deferred).toBeFalsy();
      expect(calls.length).toBe(1); // 单 sid 单组一次 LLM 调用
      // LLM 见到的是全片 5 条（旧+新）= 攒批成立的直接证据
      expect(calls[0]!.prompt).toContain("消息一");
      expect(calls[0]!.prompt).toContain("消息五");
      // 游标推进到全片 max（RECENT+500），旧消息不会被二次处理
      expect(readCursor(baseDir)).toBe(RECENT + 500);
      expect(r2.storedCount).toBeGreaterThan(0);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("defer 期间继续追加的噪声消息同样进攒批窗口（游标不动 ⇒ 下轮查询含旧+新）", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l1sb-c-"));
    try {
      const calls: CapturedCall[] = [];
      const infoLines: string[] = [];
      const runner = () => makeRunner(baseDir, calls, infoLines, ON_CFG)({ sessionKey: SESSION_KEY });
      appendL0(baseDir, "sess-A", [msg("m1", "user", "消息一：先记一个待办", RECENT)], RECENT + 100);
      const r1 = await runner();
      expect(r1.deferred).toBe(true);
      // 追加 2 条纯符号噪声（shouldExtractL1 拒绝）——仍落在查询窗口内但不计 qualified
      appendL0(baseDir, "sess-A", [msg("n1", "user", "?", RECENT + 1)], RECENT + 200);
      appendL0(baseDir, "sess-A", [msg("n2", "user", "。。。", RECENT + 2)], RECENT + 300);
      // 再补 4 条 qualified ⇒ 累计 5 ≥ K（噪声不计）
      for (let i = 2; i <= 5; i++) {
        appendL0(baseDir, "sess-A", [msg(`m${i}`, "user", `消息${i}：补充一条有效内容`, RECENT + i)], RECENT + 100 * i);
      }
      const r2 = await runner();
      expect(r2.deferred).toBeFalsy();
      expect(calls.length).toBe(1);
      expect(calls[0]!.prompt).toContain("消息一");
      expect(calls[0]!.prompt).toContain("消息5");
      // 游标进到全片 max（含噪声行的 recordedAtMs——噪声也随片处理，不丢不错位）
      expect(readCursor(baseDir)).toBe(RECENT + 500);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("多 sid：A 组达标 B 组低 → 整片提取（P0-1 all-or-nothing，禁按组 defer）", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l1sb-d-"));
    try {
      const calls: CapturedCall[] = [];
      const infoLines: string[] = [];
      appendL0(baseDir, "sess-A", [
        msg("a1", "user", "甲一：项目甲排期已确认", T0),
        msg("a2", "user", "甲二：项目甲上线步骤明确", T0 + 1),
        msg("a3", "user", "甲三：项目甲风险已识别", T0 + 2),
        msg("a4", "user", "甲四：项目甲资源已到位", T0 + 3),
        msg("a5", "user", "甲五：项目甲里程碑不变", T0 + 4),
      ], T0 + 100);
      appendL0(baseDir, "sess-B", [msg("b1", "user", "乙一：乙线只有一条", T0 + 5)], T0 + 200);
      const r = await makeRunner(baseDir, calls, infoLines, ON_CFG)({ sessionKey: SESSION_KEY });
      expect(r.deferred).toBeFalsy();
      expect(calls.length).toBe(2); // 两组各一次 LLM 调用（B 组不被跳过⇒零丢失）
      expect(r.storedCount).toBeGreaterThan(0);
      expect(readCursor(baseDir)).toBe(T0 + 200); // 整片 max（含 B 组）
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("多 sid 全片低于门槛 → 整片 defer（两组都不提取）", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l1sb-e-"));
    try {
      const calls: CapturedCall[] = [];
      const infoLines: string[] = [];
      appendL0(baseDir, "sess-A", [msg("a1", "user", "甲一：一条短消息", RECENT), msg("a2", "user", "甲二：又一条短消息", RECENT + 1)], RECENT + 100);
      appendL0(baseDir, "sess-B", [msg("b1", "user", "乙一：也只是一条", RECENT + 2), msg("b2", "user", "乙二：同样很短", RECENT + 3)], RECENT + 200);
      const r = await makeRunner(baseDir, calls, infoLines, ON_CFG)({ sessionKey: SESSION_KEY });
      expect(r.deferred).toBe(true);
      expect(calls.length).toBe(0);
      expect(readCursor(baseDir)).toBe(0);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("有残余行（queriedCount>sliceEnd）→ 不 defer 照常提取（补齐 2：保 backlog drain）", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l1sb-f-"));
    try {
      const calls: CapturedCall[] = [];
      const infoLines: string[] = [];
      // 11 行单 sid、每行 distinct recordedAtMs ⇒ sliceEnd=10、queriedCount=11>10。
      // 其中仅 3 行 qualified（<K5）、8 行噪声；chars 远低于 200。
      // 若无「残余行不 defer」规则，本片会被 defer ⇒ 排空停摆——此用例钉死规则。
      for (let i = 1; i <= 11; i++) {
        const noise = i > 3;
        appendL0One(
          baseDir,
          "sess-A",
          msg(`x${i}`, "user", noise ? "?" : `有效消息${i}：含有信息的内容`),
          T0 + i,
        );
      }
      const r = await makeRunner(baseDir, calls, infoLines, ON_CFG)({ sessionKey: SESSION_KEY });
      expect(r.deferred).toBeFalsy();
      expect(calls.length).toBe(1);
      expect(r.hasMore).toBe(true); // 残余 1 行 → 小尾巴走标准 idle 路径
      expect(readCursor(baseDir)).toBe(T0 + 10); // 推进到切片末尾（第 11 行留下轮）
      void L1_BATCH_QUERY;
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("chars ≥ minChars（qualified=2<K 但单条长消息含事实）→ 立即提取（S2 价值）", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l1sb-g-"));
    try {
      const calls: CapturedCall[] = [];
      const infoLines: string[] = [];
      // 两条各 116 字符 ⇒ qualified 总 chars=232 ≥ 200（单条长消息含事实）
      appendL0(baseDir, "sess-A", [
        msg("m1", "user", "甲".repeat(100) + "：长消息甲包含关键事实与完整上下文", T0),
        msg("m2", "user", "乙".repeat(100) + "：长消息乙同样信息量充足", T0 + 1),
      ], T0 + 100);
      const r = await makeRunner(baseDir, calls, infoLines, ON_CFG)({ sessionKey: SESSION_KEY });
      expect(r.deferred).toBeFalsy();
      expect(calls.length).toBe(1);
      expect(readCursor(baseDir)).toBe(T0 + 100);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("maxDeferAge 超阈 → 强制提取（小批关键事实不无限延迟；age 起算=切片最旧行）", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l1sb-h-"));
    try {
      const calls: CapturedCall[] = [];
      const infoLines: string[] = [];
      appendL0(baseDir, "sess-A", [msg("m1", "user", "旧消息一：含关键事实", T0), msg("m2", "user", "旧消息二：同样关键", T0 + 1)], T0 + 100);
      // maxDeferAgeMs=1000，而 recordedAt 是 2023 年（age 远大于 1s）⇒ 强制提取
      const r = await makeRunner(baseDir, calls, infoLines, { ...ON_CFG, maxDeferAgeMs: 1000 })({ sessionKey: SESSION_KEY });
      expect(r.deferred).toBeFalsy();
      expect(calls.length).toBe(1);
      expect(readCursor(baseDir)).toBe(T0 + 100);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("shadow：同输入照常提取且 metric 恰一行（would_defer=1，格式 greppable）", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l1sb-i-"));
    try {
      const calls: CapturedCall[] = [];
      const infoLines: string[] = [];
      appendL0(baseDir, "sess-A", [msg("m1", "user", "消息一：今天讨论了排期", RECENT), msg("m2", "user", "消息二：明天继续对齐", RECENT + 1)], RECENT + 100);
      const r = await makeRunner(baseDir, calls, infoLines, { ...ON_CFG, mode: "shadow" })({ sessionKey: SESSION_KEY });
      // shadow = 同输入照常提取（不 defer）
      expect(r.deferred).toBeFalsy();
      expect(calls.length).toBe(1);
      expect(readCursor(baseDir)).toBe(RECENT + 100);
      // 恰一行 greppable 计量
      const lines = metricLines(infoLines);
      expect(lines.length).toBe(1);
      expect(lines[0]).toMatch(
        /\[pipeline-factory\] metric=l1_smallbatch_shadow sids=1 qualified=2 chars=\d+ ageMs=\d+ would_defer=1$/,
      );
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("shadow：达门槛时 would_defer=0（同样恰一行）", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l1sb-j-"));
    try {
      const calls: CapturedCall[] = [];
      const infoLines: string[] = [];
      appendL0(baseDir, "sess-A", [
        msg("m1", "user", "消息一：今天讨论了排期", T0),
        msg("m2", "user", "消息二：明天继续对齐", T0 + 1),
        msg("m3", "user", "消息三：周末再Review", T0 + 2),
        msg("m4", "user", "消息四：确认了里程碑", T0 + 3),
        msg("m5", "user", "消息五：同步给干系人", T0 + 4),
      ], T0 + 100);
      const r = await makeRunner(baseDir, calls, infoLines, { ...ON_CFG, mode: "shadow" })({ sessionKey: SESSION_KEY });
      expect(r.deferred).toBeFalsy();
      expect(calls.length).toBe(1);
      const lines = metricLines(infoLines);
      expect(lines.length).toBe(1);
      expect(lines[0]).toMatch(/metric=l1_smallbatch_shadow sids=1 qualified=5 chars=\d+ ageMs=\d+ would_defer=0$/);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("缺省 off（persona 无 l1SmallBatchDefer）→ 小批照常提取、零 metric、行为与基线一致", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l1sb-k-"));
    try {
      const calls: CapturedCall[] = [];
      const infoLines: string[] = [];
      appendL0(baseDir, "sess-A", [msg("m1", "user", "消息一：今天讨论了排期", T0)], T0 + 100);
      const r = await makeRunner(baseDir, calls, infoLines)({ sessionKey: SESSION_KEY });
      expect(r.deferred).toBeFalsy();
      expect(calls.length).toBe(1);
      expect(metricLines(infoLines).length).toBe(0);
      expect(readCursor(baseDir)).toBe(T0 + 100);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("shadow 模式下 deferred 判定不影响游标（与 on 的差异只在返回值/计量）", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l1sb-l-"));
    try {
      const calls: CapturedCall[] = [];
      const infoLines: string[] = [];
      // 与 on 完全同款的小批输入（3 条 qualified）——shadow 必须照常提取并推进游标
      appendL0(baseDir, "sess-A", [msg("m1", "user", "消息一：今天讨论了排期", RECENT)], RECENT + 100);
      appendL0(baseDir, "sess-A", [msg("m2", "user", "消息二：明天继续对齐", RECENT + 1)], RECENT + 200);
      appendL0(baseDir, "sess-A", [msg("m3", "user", "消息三：周末再Review", RECENT + 2)], RECENT + 300);
      const r = await makeRunner(baseDir, calls, infoLines, { ...ON_CFG, mode: "shadow" })({ sessionKey: SESSION_KEY });
      expect(r.deferred).toBeFalsy();
      expect(r.storedCount).toBeGreaterThan(0);
      expect(readCursor(baseDir)).toBe(RECENT + 300);
      const lines = metricLines(infoLines);
      expect(lines.length).toBe(1);
      expect(lines[0]).toMatch(/would_defer=1$/);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
