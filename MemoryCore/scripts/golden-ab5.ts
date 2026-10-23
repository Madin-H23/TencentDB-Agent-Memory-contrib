/**
 * D2 金标 5 候选 A/B 回放 harness（票 02，2026-10-24「金标 5 候选复测」）。
 *
 * 与既有单候选 harness（scripts/golden-ab.ts，**原样保留**供历史对照）的差异：
 * 候选池来自票 01 数据集（每对 1..50 行生产召回形态候选池、孪生带真实名次），
 * mock store 的 searchL1Fts 按 topK 截断返回池前缀，忠实复刻生产两臂差异——
 * none 臂 fetch=topK+1=6 截断、lexical 臂 fetch=50 后经生产重排取 5。判定仍走
 * 生产 batchDedup 全链路（prompt 构建+parse+fail-fast）。
 *
 * mock 面与单测共用 build5CandMockStore（golden-ab5-metrics.ts）——harness 与
 * 防漂移保真测试用同一构造器，mock 漂移在测试层先红。
 *
 * LLM 配置：loadGatewayConfig()（同 golden-ab.ts；厂商 key 由 run-golden-ab5-v3.bat
 * 从 start-gateway-hidden.bat 注入进程环境，值不落地不打印）。
 *
 * 产出：
 *   - 逐判定追加 JSONL：<OUT_DIR>/d2-ab5-<UTC日期>.jsonl
 *     （一行一个 {pid,mode,golden,action,sim,band,twin_source,twin_rank,error}）
 *   - 聚合 json：<OUT_DIR>/d2-ab5-result-<UTC日期>.json
 *     （四指标两臂 + 孪生生存率两臂 + M1 分解 + 动作分布 + 预注册三条件判定
 *     （口径逐字沿用 golden-ab.ts）+ 分层表 + degraded 标记）
 *
 * 指标口径：四指标公式沿用 golden-ab.ts；error 行按票面约束不进指标分母
 * （error 率>10% 标 degraded）。M1 分解：golden=merge 判 store 的行按孪生是否
 * 入最终池拆成召回截断损失 vs 判定层失败。
 *
 * 用法：
 *   run-golden-ab5-v3.bat [--limit=N] [--resume] [--dataset=<路径>]
 *   node --import tsx scripts/golden-ab5.ts --selftest   # 确定性 stub，零网络回归
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadGatewayConfig } from "../src/gateway/config.js";
import { StandaloneLLMRunner } from "../src/adapters/standalone/llm-runner.js";
import { batchDedup } from "../src/core/record/l1-dedup.js";
import { loadGoldenFixture, type GoldenPair } from "../src/core/record/golden-fixture.js";
import { loadGolden5CandDataset, type Golden5CandPair } from "../src/core/record/golden-5cand.js";
import {
  abMetrics,
  build5CandMockStore,
  buildAb5Context,
  isDegraded,
  m1Decomposition,
  preregConditions,
  resumeKey,
  resumeSkip,
  stratify,
  twinSurvival,
  type Ab5Context,
  type Ab5Row,
  type Arm,
} from "../src/core/record/golden-ab5-metrics.js";
import type { LLMRunner } from "../src/core/types.js";

const FIXTURE = join(import.meta.dirname, "..", "src", "core", "record", "__fixtures__", "m1-dedup-golden.json");
// 票 01 数据集落 workspace handoffs（本仓树之外，故用绝对路径；--dataset 可覆盖）
const DEFAULT_DATASET = "D:/Develop/tdai-workspace/handoffs/m1-golden/m1-5cand-dataset-20261024.json";
const OUT_DIR = join(import.meta.dirname, "..", "..", "..", "d2-golden-results");
const POOL = 3; // 与 L1_GROUP_PARALLELISM 一致的生产并发（同 golden-ab.ts）
const TIMEOUT_MS = 240_000; // 与生产 dedupTimeoutMs 一致（同 golden-ab.ts）

// parse 降级计数：l1-dedup 的 fallbackStoreAll 触发时打 WARN 锚点
// 「l1-dedup-fallback-silent」——parse 失败被降级成 store（不进 error），须独立观测。
let parseFallbackCount = 0;

const logger = {
  info: () => {},
  warn: (m: string) => {
    if (m.includes("l1-dedup-fallback-silent")) parseFallbackCount++;
    console.log("[WARN]", m.slice(0, 200));
  },
  error: (m: string) => console.log("[ERR ]", m.slice(0, 200)),
  debug: () => {},
};

// ── 参数 ────────────────────────────────────────────────────────────────

function argValue(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
}

// ── 数据载入 ────────────────────────────────────────────────────────────

interface Loaded {
  pairs: Golden5CandPair[];
  goldenByPid: Map<string, GoldenPair>;
  ctx: Ab5Context;
  datasetPath: string;
  datasetPairsTotal: number;
}

function loadData(datasetPath: string): Loaded {
  const fixture = loadGoldenFixture(JSON.parse(readFileSync(FIXTURE, "utf-8")));
  const dataset = loadGolden5CandDataset(JSON.parse(readFileSync(datasetPath, "utf-8")), fixture);
  const goldenByPid = new Map(fixture.pairs.map((g) => [g.pid, g]));
  return {
    pairs: dataset.pairs,
    goldenByPid,
    ctx: buildAb5Context(dataset.pairs, fixture.pairs),
    datasetPath,
    datasetPairsTotal: dataset.pairs.length,
  };
}

// ── 判定（生产链路：mock store → batchDedup → parse）───────────────────

async function judgeOne(
  pair: Golden5CandPair,
  mode: Arm,
  runner: LLMRunner,
  goldenByPid: Map<string, GoldenPair>,
): Promise<Ab5Row> {
  const golden = goldenByPid.get(pair.pid)!;
  // mock store 与单测共用构造器（countL1=池长、isFtsAvailable=true、searchL1Fts 按池序截 topK）
  const { store } = build5CandMockStore(pair);
  const base = {
    pid: pair.pid,
    mode,
    golden: golden.answer_user,
    sim: golden.sim,
    band: golden.band,
    twin_source: pair.twin_source,
    twin_rank: pair.twin_rank,
  };
  try {
    const decisions = await batchDedup({
      memories: [{
        record_id: `ab5_${pair.pid}`,
        content: golden.content_newer,
        type: golden.type_newer as never,
        priority: 80,
        source_message_ids: [],
        metadata: {},
        scene_name: "",
      }],
      config: {},
      logger,
      promptMode: "chat",
      llmRunner: runner,
      vectorStore: store,
      // fail-fast：只覆盖「调用失败」——LLM 调用失败整批上抛（judgeOne 记 error，
      // 不进指标分母）；parse 失败不抛错，走 fallbackStoreAll 降级 store
      // （l1-dedup-fallback-silent WARN 锚点，本 harness 计入 parseFallbackCount）
      dedupFailFast: true,
      dedupRecallRerank: mode,
      timeoutMs: TIMEOUT_MS,
    });
    return { ...base, action: decisions[0]?.action ?? "none" };
  } catch (err) {
    return { ...base, action: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

/** 任务队列：每对 none/lexical 相邻入队（时间漂移在两侧间大致均衡，同 golden-ab.ts）。 */
function interleaveTasks(pairs: Golden5CandPair[]): Array<{ pid: string; pair: Golden5CandPair; mode: Arm }> {
  const tasks: Array<{ pid: string; pair: Golden5CandPair; mode: Arm }> = [];
  for (const p of pairs) {
    tasks.push({ pid: p.pid, pair: p, mode: "none" });
    tasks.push({ pid: p.pid, pair: p, mode: "lexical" });
  }
  return tasks;
}

/** 工作池消费任务，逐判定追加 JSONL；返回本轮新产出行。 */
async function runTasks(
  tasks: Array<{ pid: string; pair: Golden5CandPair; mode: Arm }>,
  runner: LLMRunner,
  goldenByPid: Map<string, GoldenPair>,
  jsonlFile: string,
  poolSize: number,
): Promise<Ab5Row[]> {
  const rows: Ab5Row[] = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      const { pair, mode } = tasks[i]!;
      const row = await judgeOne(pair, mode, runner, goldenByPid);
      rows.push(row);
      appendFileSync(jsonlFile, `${JSON.stringify(row)}\n`, "utf-8");
      done++;
      if (done % 50 === 0) console.log(`[ab5] progress ${done}/${tasks.length}`);
    }
  };
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return rows;
}

// ── 聚合与输出 ──────────────────────────────────────────────────────────

function aggregate(rows: Ab5Row[], ctx: Ab5Context) {
  const noneRows = rows.filter((r) => r.mode === "none");
  const lexRows = rows.filter((r) => r.mode === "lexical");
  const none = abMetrics(noneRows);
  const lexical = abMetrics(lexRows);
  return {
    none: { metrics: none, twinSurvival: twinSurvival(noneRows, ctx), m1Decomposition: m1Decomposition(noneRows, ctx) },
    lexical: { metrics: lexical, twinSurvival: twinSurvival(lexRows, ctx), m1Decomposition: m1Decomposition(lexRows, ctx) },
    conditions: preregConditions(none, lexical),
    strata: { none: stratify(noneRows, ctx), lexical: stratify(lexRows, ctx) },
    degraded: isDegraded(rows),
  };
}

function printAggregate(rows: Ab5Row[], agg: ReturnType<typeof aggregate>): void {
  const f = (x: number | null) => (x === null ? "n/a" : `${x.toFixed(1)}%`);
  const { none, lexical, conditions } = agg;
  console.log("\n== D2 A/B 5 候选结果（预注册指标口径）==");
  console.log(`指标                  none        lexical`);
  console.log(`M1 该合未合          ${f(none.metrics.M1_该合未合).padEnd(10)} ${f(lexical.metrics.M1_该合未合)}`);
  console.log(`M2 不该合误合        ${f(none.metrics.M2_不该合误合).padEnd(10)} ${f(lexical.metrics.M2_不该合误合)}`);
  console.log(`M3 明确应合并子集    ${f(none.metrics.M3_明确应合并子集_M1).padEnd(10)} ${f(lexical.metrics.M3_明确应合并子集_M1)}`);
  console.log(`M4 漏记skip          ${f(none.metrics.M4_漏记skip).padEnd(10)} ${f(lexical.metrics.M4_漏记skip)}`);
  console.log(`孪生入池率           ${f(none.twinSurvival.twinInPoolPct).padEnd(10)} ${f(lexical.twinSurvival.twinInPoolPct)}`);
  console.log(`孪生最终名次分布 none: ${JSON.stringify(none.twinSurvival.finalRankHist)}`);
  console.log(`孪生最终名次分布 lexical: ${JSON.stringify(lexical.twinSurvival.finalRankHist)}`);
  for (const arm of ["none", "lexical"] as const) {
    const d = agg[arm].m1Decomposition;
    console.log(`M1 分解 ${arm}: 分母=${d.mergeGolden} 判store=${d.judgedStore}（召回截断=${d.recallTruncationLoss} 判定层=${d.judgmentFailure}）`);
  }
  console.log(`action 分布 none: ${JSON.stringify(none.metrics.action_dist)}`);
  console.log(`action 分布 lexical: ${JSON.stringify(lexical.metrics.action_dist)}`);
  console.log(`errors: none=${none.metrics.errors} lexical=${lexical.metrics.errors}`);
  console.log(`parseFallbackCount=${parseFallbackCount}（parse 失败降级 store 计数，l1-dedup-fallback-silent 锚点——这些行 action=store 但未经 LLM 有效判定）`);
  for (const arm of ["none", "lexical"] as const) {
    console.log(`分层表 ${arm}:`);
    console.log(`  stratum      n    入池   M1(判store/分母)  召回截断  判定层`);
    for (const s of agg.strata[arm]) {
      const m1 = s.M1pct === null ? "n/a" : `${s.judgedStore}/${s.mergeGolden}=${s.M1pct.toFixed(1)}%`;
      const pct = s.twinInPoolPct === null ? "n/a" : `${s.twinInPoolPct.toFixed(1)}%`;
      console.log(`  ${s.stratum.padEnd(11)} ${String(s.n).padStart(4)} ${pct.padStart(7)} ${m1.padStart(15)} ${String(s.recallTruncationLoss).padStart(8)} ${String(s.judgmentFailure).padStart(6)}`);
    }
  }
  console.log(`\n预注册三条件：①M1 降≥5pct: ${conditions.M1_drop_5pct}  ②M2 升≤3pct: ${conditions.M2_rise_3pct}  ③M3 减半: ${conditions.M3_halved}`);
  console.log(conditions.allMet ? "判定：lexical 有效 → 灰度维持" : "判定：未全中 → 按预注册分叉处置（灰度可保观测）");
  if (agg.degraded) console.log(`[ab5] DEGRADED：error 率 >10%，聚合指标仅作观测、不进判定（parse 降级 fallback-silent=${parseFallbackCount}，亦不计入 error 率分母、独立观测）。`);
}

function writeResult(outFile: string, payload: Record<string, unknown>): void {
  writeFileSync(outFile, JSON.stringify(payload, null, 1), "utf-8");
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 追加写前补齐结尾换行：上次进程中断可能留下无换行的撕裂半行，直接 append
 * 会把新行拼接到其上、吞掉一行判定（冒烟实测）。补一个 "\n" 让撕裂行终结，
 * 新行另起一行；读取侧 readJsonlRows 的撕裂容错继续兜底真正撕裂的行。
 */
function ensureTrailingNewline(file: string): void {
  if (!existsSync(file)) return;
  const buf = readFileSync(file);
  if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) appendFileSync(file, "\n", "utf-8");
}

function readJsonlRows(file: string): { rows: Ab5Row[]; skippedTorn: number } {
  if (!existsSync(file)) return { rows: [], skippedTorn: 0 };
  const byKey = new Map<string, Ab5Row>();
  let skippedTorn = 0;
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as Ab5Row;
      if (!r || typeof r.pid !== "string" || typeof r.mode !== "string") {
        skippedTorn++; // 可 parse 但 pid/mode 残缺——按撕裂行同口径处理
        continue;
      }
      // 按 resumeKey 去重，后行覆盖前行（追加写语义下同键重复时取最后一次判定）
      byKey.set(resumeKey(r.pid, r.mode), r);
    } catch {
      skippedTorn++; // 撕裂半行（进程中断写一半）——跳过不打断 resume
    }
  }
  return { rows: [...byKey.values()], skippedTorn };
}

// ── --selftest：确定性 stub runner，零网络端到端 ────────────────────────

/**
 * 确定性 stub：从 prompt 解出 pid，孪生 id 在 prompt 中 → merge，否则 store。
 * 零随机、零网络——同一输入恒同一输出；同时让 parse/指标两路都有样本。
 */
function selftestRunner(pairById: ReadonlyMap<string, Golden5CandPair>): LLMRunner {
  return {
    run: async ({ prompt }) => {
      const pid = prompt.match(/ab5_([A-Za-z0-9_]+)/)?.[1] ?? "";
      const twinId = pairById.get(pid)?.twin_id;
      const inPool = typeof twinId === "string" && prompt.includes(twinId);
      const decision: Record<string, unknown> = { record_id: `ab5_${pid}`, action: inPool ? "merge" : "store" };
      if (inPool) decision.target_ids = [twinId];
      return JSON.stringify([decision]);
    },
  };
}

/**
 * selftest 确定性选样：db 池内（twin_rank≤5，none 臂即入池）1 对 + db 池外
 * （twin_rank>5）1 对 + beyond（twin_rank=null）1 对——三类俱全时 selftest 必然
 * 同时覆盖 stub 的 merge 与 store 两路（真实数据集三类俱全）。
 */
function selftestPairs(pairs: readonly Golden5CandPair[]): Golden5CandPair[] {
  const pick = (pred: (p: Golden5CandPair) => boolean) => pairs.find(pred);
  const chosen = [
    pick((p) => p.twin_rank !== null && p.twin_rank <= 5),
    pick((p) => p.twin_rank !== null && p.twin_rank > 5),
    pick((p) => p.twin_rank === null),
  ].filter((p): p is Golden5CandPair => p !== undefined);
  for (const p of pairs) {
    if (chosen.length >= 3) break;
    if (!chosen.includes(p)) chosen.push(p);
  }
  return chosen.slice(0, 3);
}

async function selftestMain(): Promise<void> {
  const data = loadData(DEFAULT_DATASET);
  const pairs = selftestPairs(data.pairs);
  const ctx = buildAb5Context(pairs, [...data.goldenByPid.values()]);
  const tasks = interleaveTasks(pairs);
  const jsonlFile = join(tmpdir(), `d2-ab5-selftest-${process.pid}-${Date.now()}.jsonl`);
  console.log(`[ab5] selftest：${pairs.map((p) => `${p.pid}(rank=${p.twin_rank})`).join(" ")} × 2 臂 = 6 次判定（确定性 stub runner，零网络；POOL=1 保输出序确定）`);
  const rows = await runTasks(tasks, selftestRunner(ctx.pairById), data.goldenByPid, jsonlFile, 1);

  // 端到端自检：6 行、3 pid × 2 mode、无重复；top-5 对（none 臂孪生必入池）
  // 必产出 merge、beyond 对必产出 store——两路 parse/指标都有样本
  const keys = rows.map((r) => resumeKey(r.pid, r.mode));
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (rows.length !== 6 || dup.length > 0) {
    throw new Error(`[ab5] selftest 自检失败：rows=${rows.length}（期望 6），重复键=${JSON.stringify(dup)}`);
  }
  if (!rows.some((r) => r.action === "merge") || !rows.some((r) => r.action === "store")) {
    throw new Error(`[ab5] selftest 自检失败：action 分布 ${JSON.stringify(rows.map((r) => r.action))} 未同时覆盖 merge/store 两路`);
  }
  const agg = aggregate(rows, ctx);
  printAggregate(rows, agg);
  console.log(`\n[ab5] selftest JSONL（临时文件）: ${jsonlFile}`);
  console.log(`[ab5] selftest 首行样例: ${JSON.stringify(rows[0])}`);
  console.log(`[ab5] selftest PASS：mock→batchDedup→parse→指标→JSONL 全链路 6/6 无重复`);
}

// ── 主流程（live）───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const limit = Number(argValue("limit") ?? 0);
  const resume = process.argv.includes("--resume");
  const datasetPath = argValue("dataset") ?? DEFAULT_DATASET;

  const data = loadData(datasetPath);
  let pairs = data.pairs;
  if (limit > 0) pairs = pairs.slice(0, limit);

  mkdirSync(OUT_DIR, { recursive: true });
  const jsonlFile = join(OUT_DIR, `d2-ab5-${utcDate()}.jsonl`);

  // resume：读当日 JSONL 跳过已判 (pid,mode)，聚合时并入。
  // readJsonlRows 已按 resumeKey 去重（后行覆盖前行）并容错跳过撕裂半行。
  let priorRows: Ab5Row[] = [];
  let tasks = interleaveTasks(pairs);
  if (resume) {
    const prior = readJsonlRows(jsonlFile);
    priorRows = prior.rows;
    if (prior.skippedTorn > 0) console.log(`[ab5] resume：跳过撕裂/残缺行 ${prior.skippedTorn}（JSON.parse 失败或 pid/mode 残缺）`);
    const judged = new Set(priorRows.map((r) => resumeKey(r.pid, r.mode)));
    const { pending, skipped } = resumeSkip(judged, tasks);
    tasks = pending;
    console.log(`[ab5] resume：已判 ${skipped}，待跑 ${pending.length}`);
  }

  const cfg = loadGatewayConfig();
  const llm = cfg.llm;
  const runner = new StandaloneLLMRunner({
    config: {
      baseUrl: llm.baseUrl,
      apiKey: llm.apiKey,
      model: llm.model,
      maxTokens: llm.maxTokens,
      timeoutMs: llm.timeoutMs,
      callDeadlineMs: llm.callDeadlineMs,
      maxConcurrency: llm.maxConcurrency,
    },
    enableTools: false,
    logger,
  });
  console.log(`[ab5] model=${llm.model} deadline=${llm.callDeadlineMs ?? "(auto)"}ms gate=${llm.maxConcurrency ?? 0}`);
  console.log(`[ab5] dataset=${datasetPath}`);
  console.log(`[ab5] pairs=${pairs.length}（×2 臂 = ${pairs.length * 2} 次判定，pool=${POOL}，jsonl=${jsonlFile}）`);

  ensureTrailingNewline(jsonlFile);
  const freshRows = await runTasks(tasks, runner, data.goldenByPid, jsonlFile, POOL);

  // 聚合并入当日全部行（resume 场景 = 旧 + 新）
  const rows = [...priorRows, ...freshRows];
  const agg = aggregate(rows, data.ctx);
  printAggregate(rows, agg);

  const outFile = join(OUT_DIR, `d2-ab5-result-${utcDate()}.json`);
  writeResult(outFile, {
    run_at: new Date().toISOString(),
    mode: "live",
    model: llm.model,
    dataset: datasetPath,
    dataset_pairs_total: data.datasetPairsTotal,
    fixture_pairs: pairs.length,
    resumed_rows: priorRows.length,
    fresh_rows: freshRows.length,
    degraded: agg.degraded,
    parseFallbackCount,
    arms: { none: agg.none, lexical: agg.lexical },
    conditions: agg.conditions,
    verdict: agg.conditions.allMet ? "lexical-effective" : "not-all-met",
    strata: agg.strata,
    results: rows,
  });
  console.log(`\n结果文件: ${outFile}`);
}

if (process.argv.includes("--selftest")) {
  selftestMain().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
