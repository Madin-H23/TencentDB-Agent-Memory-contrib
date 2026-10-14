// P0-Fix2/Fix3（2026-10-14，v2 ed42826 多线程治理移植，串行版）：L1 runner 的
// 多 sid continuity 隔离 + 失败延后。同一 sessionKey 下多个 sessionId 分组蒸馏时，
// previousSceneName 必须取自各自 sid 的上次场景，不得跨线程互串；任一组失败
// → 整片 reject（游标不动、数据不丢）；游标仍取全组 max recorded_at。
// 走真实 JSONL 读取路径（vectorStore 缺省回退），llmRunner 桩按消息标记返回
// 不同场景并捕获 prompt 断言【上一个情境】。（v3 为组间串行，无并发断言。）
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createL1Runner } from "./pipeline-factory.js";
import type { LLMRunner, Logger } from "../core/types.js";

const T0 = 1_700_000_000_000;
const SESSION_KEY = "zcode-default";

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

/** llmRunner 桩：按 prompt 内的消息标记返回不同场景，并捕获 prompt 供断言 */
function makeFakeLlm(calls: CapturedCall[]): LLMRunner {
  return {
    run: async (p: { prompt: string }) => {
      calls.push({ prompt: p.prompt });
      if (p.prompt.includes("标记甲内容")) {
        return JSON.stringify([
          { scene_name: "场景甲", message_ids: ["a1"], memories: [{ type: "episodic", content: "甲线事实：项目甲在推进", priority: 50 }] },
        ]);
      }
      return JSON.stringify([
        { scene_name: "场景乙", message_ids: ["b1"], memories: [{ type: "episodic", content: "乙线事实：项目乙在推进", priority: 50 }] },
      ]);
    },
  } as unknown as LLMRunner;
}

function makeRunner(baseDir: string, calls: CapturedCall[], cfgExtra: Record<string, unknown> = {}) {
  return createL1Runner({
    pluginDataDir: baseDir,
    cfg: {
      extraction: { enableDedup: false, maxMemoriesPerSession: 10, ...cfgExtra },
      embedding: {},
    } as never,
    openclawConfig: undefined,
    vectorStore: undefined, // 走 JSONL 回退读取路径（真实生产回退路径）
    embeddingService: undefined,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger,
    llmRunner: makeFakeLlm(calls),
  });
}

const prevOf = (prompt: string): string => {
  const m = prompt.match(/【上一个情境】：(.*)/);
  return m ? (m[1] as string).trim() : "(未找到)";
};

describe("L1 runner：多 sid 分组的 continuity 隔离（per-sid map）", () => {
  it("同轮两 sid 分组：乙组的【上一个情境】不得拿到甲组刚产出的场景", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l1runner-a-"));
    try {
      const calls: CapturedCall[] = [];
      appendL0(baseDir, "sess-A", [msg("a1", "user", "标记甲内容：讨论项目甲的排期安排", T0)], T0 + 100);
      appendL0(baseDir, "sess-B", [msg("b1", "user", "标记乙内容：讨论项目乙的上线步骤", T0)], T0 + 200);
      const r = await makeRunner(baseDir, calls)({ sessionKey: SESSION_KEY });
      expect(calls.length).toBe(2);
      expect(r.storedCount).toBe(2);
      // 组按最早时间戳排序：甲先乙后。乙组的 previous 必须是「无」（各自起点），
      // 而不是甲组同轮刚产出的「场景甲」。
      const promptA = calls.find((c) => c.prompt.includes("标记甲内容"))!;
      const promptB = calls.find((c) => c.prompt.includes("标记乙内容"))!;
      expect(prevOf(promptA.prompt)).toBe("无");
      expect(prevOf(promptB.prompt)).toBe("无");
      expect(promptB.prompt).not.toContain("场景甲");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("跨轮：各 sid 延续自己的场景（乙不拿到甲上一轮的场景）", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l1runner-b-"));
    try {
      const calls: CapturedCall[] = [];
      // 第一轮：两 sid 各蒸一次，产出 场景甲/场景乙
      appendL0(baseDir, "sess-A", [msg("a1", "user", "标记甲内容：第一轮甲", T0)], T0 + 100);
      appendL0(baseDir, "sess-B", [msg("b1", "user", "标记乙内容：第一轮乙", T0)], T0 + 200);
      await makeRunner(baseDir, calls)({ sessionKey: SESSION_KEY });
      // 第二轮：只有甲有新消息，产出仍是「场景甲」（桩按标记返回）
      appendL0(baseDir, "sess-A", [msg("a2", "user", "标记甲内容：第二轮甲", T0 + 1000)], T0 + 1100);
      await makeRunner(baseDir, calls)({ sessionKey: SESSION_KEY });
      // 第三轮：只有乙有新消息——乙的【上一个情境】必须是乙自己的「场景乙」，
      // 而不是甲第二轮写入共享单键的「场景甲」。
      appendL0(baseDir, "sess-B", [msg("b2", "user", "标记乙内容：第二轮乙", T0 + 2000)], T0 + 2100);
      const callsBefore = calls.length;
      await makeRunner(baseDir, calls)({ sessionKey: SESSION_KEY });
      const promptB = calls[callsBefore]!.prompt;
      expect(prevOf(promptB)).toBe("场景乙");
      expect(promptB).not.toContain("场景甲");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("游标推进取全组 max recorded_at；profileScopes 每组一键；last_scene_names 落盘", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l1runner-c-"));
    try {
      const calls: CapturedCall[] = [];
      appendL0(baseDir, "sess-A", [msg("a1", "user", "标记甲内容：游标验证甲", T0)], T0 + 111);
      appendL0(baseDir, "sess-B", [msg("b1", "user", "标记乙内容：游标验证乙", T0)], T0 + 333);
      const r = await makeRunner(baseDir, calls)({ sessionKey: SESSION_KEY });
      const cp = JSON.parse(readFileSync(join(baseDir, ".metadata", "recall_checkpoint.json"), "utf-8")) as {
        runner_states: Record<string, { last_l1_cursor: number; last_scene_names?: Record<string, string> }>;
      };
      expect(cp.runner_states![SESSION_KEY]!.last_l1_cursor).toBe(T0 + 333);
      expect(r.profileScopes.length).toBe(2); // 每 sid 一个 L2 任务键（L2×M 的来源）
      expect(cp.runner_states![SESSION_KEY]!.last_scene_names).toEqual({
        "sess-A": "场景甲",
        "sess-B": "场景乙",
      });
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("dedup 失败（failFast 开）：整片延后——runner reject、游标不动", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l1runner-e-"));
    try {
      // 各组：抽取成功，但 dedup 判定阶段（taskId=l1-conflict-detection）抛错。
      // 注意 dedup 判定要真实执行必须有候选——vectorStore 桩提供 FTS 召回行
      // （vectorStore: undefined 时 Phase 1 无候选直接 storeAll，判定不跑）。
      let sawConflictTask = false;
      const fake: LLMRunner = {
        run: async (p: { prompt: string; taskId?: string }) => {
          if (p.taskId === "l1-conflict-detection") {
            sawConflictTask = true;
            throw new Error("The operation was aborted due to timeout");
          }
          if (p.prompt.includes("标记甲内容")) {
            return JSON.stringify([
              { scene_name: "场景甲", message_ids: ["a1"], memories: [{ type: "episodic", content: "甲线事实", priority: 50 }] },
            ]);
          }
          return JSON.stringify([
            { scene_name: "场景乙", message_ids: ["b1"], memories: [{ type: "episodic", content: "乙线事实", priority: 50 }] },
          ]);
        },
      } as unknown as LLMRunner;
      const ftsRow = { record_id: "old-1", content: "旧记忆：标记甲内容相关历史", type: "episodic", priority: 50, scene_name: "s", metadata_json: "", timestamp_str: "2026-09-01T00:00:00Z", session_key: SESSION_KEY, session_id: "sess-old" };
      const ftsStore = {
        countL1: async () => 5,
        isDegraded: () => false,
        isFtsAvailable: () => true,
        searchL1Vector: async () => [],
        searchL1Fts: async () => [ftsRow],
        // runner 读 L0 走 DB 路径（isDegraded=false）：直接返回两个 sid 组
        queryL0GroupedBySessionId: async () => [
          { sessionId: "sess-A", userId: "", agentId: "", messages: [{ id: "a1", role: "user", content: "标记甲内容：dedup 失败甲", timestamp: T0 + 111, recordedAtMs: T0 + 111 }] },
          { sessionId: "sess-B", userId: "", agentId: "", messages: [{ id: "b1", role: "user", content: "标记乙内容：dedup 失败乙", timestamp: T0 + 333, recordedAtMs: T0 + 333 }] },
        ],
      } as never;
      const runner = createL1Runner({
        pluginDataDir: baseDir,
        cfg: {
          extraction: { enableDedup: true, dedupFailFast: true, maxMemoriesPerSession: 10 },
          embedding: {},
        } as never,
        openclawConfig: undefined,
        vectorStore: ftsStore,
        embeddingService: undefined,
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger,
        llmRunner: fake,
      });
      // 甲组 dedup 抛错 → 整片 reject（L1ExtractionFailure 从 extractor 传播）
      let caught: unknown = null;
      await runner({ sessionKey: SESSION_KEY }).catch((e) => { caught = e; });
      expect(String(caught)).toContain("L1 dedup failed"); // 失败原因=dedup 链而非其他
      // 游标未推进（延后语义：数据不丢，下轮整片重试）；整批失败时 checkpoint
      // 可能从未落盘（无任何成功 mark）——缺文件本身就是「未处理」的证明
      const cpPath = join(baseDir, ".metadata", "recall_checkpoint.json");
      const cursor = existsSync(cpPath)
        ? (JSON.parse(readFileSync(cpPath, "utf-8")) as { runner_states?: Record<string, { last_l1_cursor?: number }> }).runner_states?.[SESSION_KEY]?.last_l1_cursor ?? 0
        : 0;
      expect(cursor).toBeLessThan(T0 + 111);
      expect(caught).toBeInstanceOf(Error);
      expect(sawConflictTask).toBe(true);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("组间并行：两组的抽取调用必须同时在途（屏障桩；串行实现屏障超时即红）", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l1runner-d-"));
    try {
      let inFlight = 0;
      let peak = 0;
      // 门闩式屏障（边沿触发）：第二个调用到达时开门，双方等同一扇门——
      // 电平轮询版有「先到者错过后来者已离开」的竞态
      let openGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => { openGate = resolve; });
      const fake: LLMRunner = {
        run: async (p: { prompt: string }) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          if (inFlight >= 2) openGate();
          await gate;
          inFlight -= 1;
          if (p.prompt.includes("标记甲内容")) {
            return JSON.stringify([
              { scene_name: "场景甲", message_ids: ["a1"], memories: [{ type: "episodic", content: "甲线事实", priority: 50 }] },
            ]);
          }
          return JSON.stringify([
            { scene_name: "场景乙", message_ids: ["b1"], memories: [{ type: "episodic", content: "乙线事实", priority: 50 }] },
          ]);
        },
      } as unknown as LLMRunner;
      appendL0(baseDir, "sess-A", [msg("a1", "user", "标记甲内容：并发验证甲", T0)], T0 + 111);
      appendL0(baseDir, "sess-B", [msg("b1", "user", "标记乙内容：并发验证乙", T0)], T0 + 333);
      const r = await createL1Runner({
        pluginDataDir: baseDir,
        cfg: { extraction: { enableDedup: false, maxMemoriesPerSession: 10 }, embedding: {} } as never,
        openclawConfig: undefined,
        vectorStore: undefined,
        embeddingService: undefined,
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger,
        llmRunner: fake,
      })({ sessionKey: SESSION_KEY });
      expect(peak).toBe(2); // 并发峰值=组数（串行实现此测试超时/红）
      expect(r.storedCount).toBe(2); // 聚合语义不变
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("组间并发封顶：4 组时峰值并发=3（L1_GROUP_PARALLELISM），全部处理完", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l1runner-f-"));
    try {
      let inFlight = 0;
      let peak = 0;
      const markers = ["零", "一", "二", "三"] as const;
      const fake: LLMRunner = {
        run: async (p: { prompt: string }) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 40)); // 拉长在途窗口让并发可观测
          inFlight -= 1;
          const idx = markers.findIndex((m) => p.prompt.includes(`标记${m}内容`));
          return JSON.stringify([
            { scene_name: `场景${markers[idx]}`, message_ids: [`g${idx}`], memories: [{ type: "episodic", content: `${markers[idx]}线事实`, priority: 50 }] },
          ]);
        },
      } as unknown as LLMRunner;
      for (const [i, sid] of (["sess-0", "sess-1", "sess-2", "sess-3"] as const).entries()) {
        appendL0(baseDir, sid, [msg(`g${i}`, "user", `标记${markers[i]}内容：并发封顶 ${i}`, T0 + i * 100)], T0 + 500 + i * 100);
      }
      const r = await createL1Runner({
        pluginDataDir: baseDir,
        cfg: { extraction: { enableDedup: false, maxMemoriesPerSession: 10 }, embedding: {} } as never,
        openclawConfig: undefined,
        vectorStore: undefined,
        embeddingService: undefined,
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger,
        llmRunner: fake,
      })({ sessionKey: SESSION_KEY });
      expect(r.storedCount).toBe(4); // 4 组全部处理
      expect(peak).toBeLessThanOrEqual(3); // 并发封顶生效（无界=4）
      expect(peak).toBeGreaterThanOrEqual(2); // 且确实并行（非串行）
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
