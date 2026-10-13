/**
 * M1 D1 A/B 回放 harness——按预注册字据跑金标 250 对 × v1/v2 两臂。
 *
 * 预注册字据（跑测前立，赛后不得改规则）：
 *   handoffs/m1-golden/m1-ab-prereg-20261013.md（tdai-workspace）
 * 回放构造 = 预注册定义：候选池 = [older 记录]，新记忆 = newer 内容；判定走
 * **生产链路**（batchDedup 真实 prompt 构建 + parseBatchResult），mock vectorStore
 * 的 searchL1Fts 恒返回 older 行——零复刻，口径即生产。
 *
 * LLM 配置：loadGatewayConfig()（env TDAI_GATEWAY_CONFIG 指向生产 yaml；厂商 key
 * 由 run-golden-ab.bat 从 start-gateway-hidden.bat 注入进程环境，值不落地不打印）
 * → llm 折叠值 + l1 分层覆盖（与生产 resolveRuntimeLlm("l1") 同优先级）。
 *
 * 指标（预注册定义）：
 *   M1 该合未合率 = golden=merge 对中判 store 的比例
 *   M2 不该合误合率 = golden=store 对中判 merge/update 的比例
 *   M3 = M1 在「明确应合并」子集（sim>=0.85 或 exact）上
 *   M4 漏记率 = 判 skip 的比例（观测项）
 * 通过线：M1(v2)<=M1(v1)-5pct 且 M2(v2)<=M2(v1)+3pct 且 M3(v2)<=M3(v1)/2。
 *
 * 用法：run-golden-ab.bat（key 注入+运行一体）
 */
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { loadGatewayConfig } from "../src/gateway/config.js";
import { StandaloneLLMRunner } from "../src/adapters/standalone/llm-runner.js";
import { batchDedup } from "../src/core/record/l1-dedup.js";
import type { IMemoryStore } from "../src/core/store/types.js";
import type { LLMRunner } from "../src/core/types.js";
import type { GoldenPair } from "../src/core/record/golden-fixture.js";

const FIXTURE = join(import.meta.dirname, "..", "src", "core", "record", "__fixtures__", "m1-dedup-golden.json");
const OUT_DIR = join(homedir(), "..", "..", "Develop", "tdai-workspace", "handoffs", "m1-golden");
const POOL = 3; // 与 L1_GROUP_PARALLELISM 一致的生产并发

const logger = {
  info: () => {},
  warn: (m: string) => console.log("[WARN]", m.slice(0, 200)),
  error: (m: string) => console.log("[ERR ]", m.slice(0, 200)),
  debug: () => {},
};

function rowOf(p: GoldenPair, side: "older" | "newer") {
  return {
    record_id: side === "older" ? p.older_id : p.newer_id,
    content: side === "older" ? p.content_older : p.content_newer,
    type: side === "older" ? p.type_older : p.type_newer,
    priority: 80,
    scene_name: "",
    metadata_json: null,
    timestamp_str: "",
    session_key: "zcode-default",
  };
}

async function judgeOne(
  p: GoldenPair,
  version: "v1" | "v2",
  runner: LLMRunner,
): Promise<{ action: string; error?: string }> {
  // mock vectorStore：FTS 恒返回 older 行（候选池=[older]）
  const vectorStore = {
    countL1: async () => 1,
    isFtsAvailable: () => true,
    searchL1Fts: async () => [rowOf(p, "older")],
  } as unknown as IMemoryStore;
  try {
    const decisions = await batchDedup({
      memories: [{
        record_id: `ab_${p.pid}`,
        content: p.content_newer,
        type: p.type_newer as never,
        priority: 80,
        source_message_ids: [],
        metadata: {},
        scene_name: "",
      }],
      config: {},
      logger,
      promptMode: "chat",
      llmRunner: runner,
      vectorStore,
      // fail-fast：调用/parse 失败显式抛错（judgeOne 记 error，不进指标分母）——
      // 不开会被内层 catch 静默降级 store-all，把失败洗成「判了 store」
      dedupFailFast: true,
      dedupPromptVersion: version,
      timeoutMs: 240_000, // 与生产 dedupTimeoutMs 一致
    });
    return { action: decisions[0]?.action ?? "none" };
  } catch (err) {
    return { action: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

function metrics(results: Array<{ golden: string; action: string; sim: number | null; band: string }>) {
  const mergeG = results.filter((r) => r.golden === "merge");
  const storeG = results.filter((r) => r.golden === "store");
  const clearSub = results.filter((r) => r.golden === "merge" && ((r.sim ?? 0) >= 0.85 || r.band === "exact"));
  const pct = (a: number, b: number) => (b === 0 ? null : (a / b) * 100);
  return {
    n: results.length,
    errors: results.filter((r) => r.action === "error").length,
    M1_该合未合: pct(mergeG.filter((r) => r.action === "store").length, mergeG.length),
    M2_不该合误合: pct(storeG.filter((r) => r.action === "merge" || r.action === "update").length, storeG.length),
    M3_明确应合并子集_M1: pct(clearSub.filter((r) => r.action === "store").length, clearSub.length),
    M4_漏记skip: pct(results.filter((r) => r.action === "skip").length, results.length),
    action_dist: results.reduce<Record<string, number>>((acc, r) => {
      acc[r.action] = (acc[r.action] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

async function main() {
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : 0;
  const fx = JSON.parse(readFileSync(FIXTURE, "utf-8")) as { pairs: GoldenPair[] };
  if (limit > 0) fx.pairs = fx.pairs.slice(0, limit);
  const cfg = loadGatewayConfig();
  const llm = cfg.llm;
  const l1Model = llm.layers?.l1?.model ?? llm.model;
  const runner = new StandaloneLLMRunner({
    config: {
      baseUrl: llm.baseUrl,
      apiKey: llm.apiKey,
      model: l1Model,
      maxTokens: llm.layers?.l1?.maxTokens ?? llm.maxTokens,
      timeoutMs: llm.layers?.l1?.timeoutMs ?? llm.timeoutMs,
      callDeadlineMs: llm.callDeadlineMs,
      maxConcurrency: llm.maxConcurrency,
      providerLabel: llm.providerLabel,
      // 厂商附加头必须透传（opencode-go 的 x-opencode-session 缺失即 400）
      ...(llm.headers ? { headers: llm.headers } : {}),
    },
    model: l1Model,
    enableTools: false,
    logger,
  });
  console.log(`[ab] vendor=${llm.providerLabel ?? "?"} model=${l1Model} deadline=${llm.callDeadlineMs ?? 180000}ms gate=${llm.maxConcurrency ?? 0}`);
  console.log(`[ab] fixture pairs=${fx.pairs.length}（×2 臂 = ${fx.pairs.length * 2} 次判定，pool=${POOL}）`);

  // 任务队列：每对 v1/v2 相邻入队（时间漂移在两侧间大致均衡）
  const tasks: Array<{ p: GoldenPair; version: "v1" | "v2" }> = [];
  for (const p of fx.pairs) {
    tasks.push({ p, version: "v1" });
    tasks.push({ p, version: "v2" });
  }
  const results: Array<{ pid: string; version: string; golden: string; action: string; sim: number | null; band: string; error?: string }> = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      const { p, version } = tasks[i]!;
      const r = await judgeOne(p, version, runner);
      results.push({ pid: p.pid, version, golden: p.answer_user, action: r.action, sim: p.sim, band: p.band, error: r.error });
      done++;
      if (done % 50 === 0) console.log(`[ab] progress ${done}/${tasks.length}`);
    }
  };
  await Promise.all(Array.from({ length: POOL }, worker));

  const v1 = metrics(results.filter((r) => r.version === "v1"));
  const v2 = metrics(results.filter((r) => r.version === "v2"));
  const f = (x: number | null) => (x === null ? "n/a" : `${x.toFixed(1)}%`);
  const cond1 = v1.M1_该合未合 !== null && v2.M1_该合未合 !== null && v2.M1_该合未合 <= v1.M1_该合未合 - 5;
  const cond2 = v1.M2_不该合误合 !== null && v2.M2_不该合误合 !== null && v2.M2_不该合误合 <= v1.M2_不该合误合 + 3;
  const cond3 = v1.M3_明确应合并子集_M1 !== null && v2.M3_明确应合并子集_M1 !== null && v2.M3_明确应合并子集_M1 <= v1.M3_明确应合并子集_M1 / 2;

  console.log("\n== A/B 结果（预注册指标）==");
  console.log(`指标                v1          v2`);
  console.log(`M1 该合未合        ${f(v1.M1_该合未合).padEnd(10)} ${f(v2.M1_该合未合)}`);
  console.log(`M2 不该合误合      ${f(v1.M2_不该合误合).padEnd(10)} ${f(v2.M2_不该合误合)}`);
  console.log(`M3 明确应合并子集  ${f(v1.M3_明确应合并子集_M1).padEnd(10)} ${f(v2.M3_明确应合并子集_M1)}`);
  console.log(`M4 漏记skip        ${f(v1.M4_漏记skip).padEnd(10)} ${f(v2.M4_漏记skip)}`);
  console.log(`action 分布 v1: ${JSON.stringify(v1.action_dist)}`);
  console.log(`action 分布 v2: ${JSON.stringify(v2.action_dist)}`);
  console.log(`errors: v1=${v1.errors} v2=${v2.errors}`);
  console.log(`\n预注册三条件：①M1 降≥5pct: ${cond1}  ②M2 升≤3pct: ${cond2}  ③M3 减半: ${cond3}`);
  console.log(cond1 && cond2 && cond3 ? "判定：v2 有效 → 进灰度闸" : "判定：未全中 → 按预注册分叉处置");

  mkdirSync(OUT_DIR, { recursive: true });
  const outFile = join(OUT_DIR, "m1-ab-result-20261013.json");
  writeFileSync(outFile, JSON.stringify({
    run_at: new Date().toISOString(),
    vendor: llm.providerLabel ?? null,
    model: l1Model,
    fixture_pairs: fx.pairs.length,
    prereg: "handoffs/m1-golden/m1-ab-prereg-20261013.md",
    v1, v2,
    conditions: { M1_drop_5pct: cond1, M2_rise_3pct: cond2, M3_halved: cond3 },
    verdict: cond1 && cond2 && cond3 ? "v2-effective" : "not-all-met",
    results,
  }, null, 1), "utf-8");
  console.log(`\n结果文件: ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
