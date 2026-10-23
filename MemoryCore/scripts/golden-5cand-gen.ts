/**
 * 票 01（2026-10-24 金标 5 候选复测）生成脚本：快照→检索→数据集+统计一次产出。
 *
 * 流程（无 LLM 调用）：
 *   1. 只读打开活库 → VACUUM INTO 单文件一致快照（绝不以可写模式打开活库——网关在役；
 *      快照已存在则复用，保证脚本可重复执行且结果确定）。
 *   2. 在快照上开生产 VectorStore（dimensions=0，FTS-only）+ 生产分词 buildFtsQuery。
 *   3. 逐对金标：buildFtsQuery(content_newer) → searchL1Fts(top-50) →
 *      build5CandPair 三态状态机（注入策略预注册见 golden-5cand.ts 文件头）。
 *   4. 数据集经 loadGolden5CandDataset 全量自校验后再落盘（写不出非法数据集）。
 *   5. 统计 md：250 对覆盖、twin_source 三态计数、db 态名次直方图、
 *      与历史 rank_bucket 分布对照（差异>15pp 给归因）。
 *
 * 用法：cd MemoryCore && npx tsx scripts/golden-5cand-gen.ts
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadGoldenFixture, type GoldenPair } from "../src/core/record/golden-fixture.js";
import {
  GOLDEN_5CAND_SCHEMA,
  build5CandPair,
  loadGolden5CandDataset,
  type Golden5CandDataset,
  type Golden5CandPair,
} from "../src/core/record/golden-5cand.js";
import { VectorStore } from "../src/core/store/sqlite/memory-store.js";
import { buildFtsQuery } from "../src/core/store/tokenize.js";

const REPO = join(import.meta.dirname, "..");
const FIXTURE = join(REPO, "src", "core", "record", "__fixtures__", "m1-dedup-golden.json");
const LIVE_DB = "C:/Users/28951/.memory-tencentdb/memory-tdai/vectors.db";
const SNAPSHOT = "D:/develop/TencentDB-Agent-Memory/backup/vectors.db.snap-5cand-20261024";
const OUT_DIR = "D:/Develop/tdai-workspace/handoffs/m1-golden";
const OUT_JSON = join(OUT_DIR, "m1-5cand-dataset-20261024.json");
const OUT_MD = join(OUT_DIR, "m1-5cand-dataset-20261024.stats.md");
const SEED = "5cand-20261024";
const TOPK = 50;

/** fixture JSON 侧的 id 字段（GoldenPair 类型不声明，按 golden-ab.ts 惯例读取）。 */
type GoldenPairWithIds = GoldenPair & { older_id: string; newer_id: string };

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`);

// ── 1. 快照：只读 VACUUM INTO（已存在则复用）────────────────────────────
mkdirSync(join(SNAPSHOT, ".."), { recursive: true });
if (existsSync(SNAPSHOT)) {
  console.log(`[gen] 快照已存在，复用（保证可重复执行）: ${SNAPSHOT}`);
} else {
  const src = new DatabaseSync(LIVE_DB, { readOnly: true });
  try {
    src.exec(`VACUUM INTO '${SNAPSHOT}'`);
  } finally {
    src.close();
  }
  console.log(`[gen] 快照完成: ${SNAPSHOT}`);
}

// ── 2. 快照体检 + 生产 store（FTS-only）─────────────────────────────────
const chk = new DatabaseSync(SNAPSHOT, { readOnly: true });
let l1Count = 0;
let quickCheck = "n/a";
try {
  quickCheck = String((chk.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check);
  l1Count = (chk.prepare("SELECT COUNT(*) AS c FROM l1_records").get() as { c: number }).c;
} finally {
  chk.close();
}
if (quickCheck !== "ok") throw new Error(`快照 quick_check 异常: ${quickCheck}`);
console.log(`[gen] 快照体检 ok，l1_records=${l1Count}`);

const logger = {
  info: () => {},
  warn: (m: string) => console.log("[WARN]", m.slice(0, 200)),
  error: (m: string) => console.log("[ERR ]", m.slice(0, 200)),
  debug: () => {},
};
const store = new VectorStore(SNAPSHOT, 0, logger);
const initRes = store.init(); // 无 providerInfo：不做 reindex/重建；dimensions=0 走 FTS-only

// P2-1（双轴审查 2026-10-24）fail-fast：store degrade / FTS 不可用时 searchL1Fts 会
// 静默返空（memory-store.ts:3163 `if (this.degraded || !this.ftsAvailable) return []`），
// 脚本只会产出全 injected 的假数据集——此处显式拒绝、非零退出，绝不落数据集。
// countL1 无 filter 与 raw `SELECT COUNT(*) FROM l1_records` 同口径；degrade 时恒返 0
// （memory-store.ts:1686），与快照体检数交叉验证。
const countViaStore = await store.countL1();
if (store.isDegraded() || !store.isFtsAvailable() || countViaStore !== l1Count) {
  console.error(
    `[gen][FATAL] 快照 store 初始化不可用：degraded=${store.isDegraded()} ftsAvailable=${store.isFtsAvailable()} ` +
      `countL1=${countViaStore}（raw l1_records=${l1Count}）initReason=${initRes.reason ?? "n/a"}——` +
      `searchL1Fts 将静默返空，拒绝生成数据集`,
  );
  process.exit(1);
}

// 孪生在库判定：快照 l1_records 存在性（与是否被召回无关）
const stmtTwin = store.getRawDb().prepare("SELECT 1 AS ok FROM l1_records WHERE record_id = ?");

// ── 3. 逐对检索 + 三态状态机 ────────────────────────────────────────────
const fx = loadGoldenFixture(JSON.parse(readFileSync(FIXTURE, "utf-8")));
const pairsWithIds = fx.pairs.map((p) => {
  const w = p as GoldenPairWithIds;
  if (!w.older_id || !w.newer_id) throw new Error(`金标对缺 older_id/newer_id: ${p.pid}`);
  return w;
});
console.log(`[gen] fixture pairs=${pairsWithIds.length}，seed=${SEED}，topK=${TOPK}`);

const pairs: Golden5CandPair[] = [];
let noQueryCount = 0; // buildFtsQuery 为 null（分词为空）
let zeroHitCount = 0; // 有查询但零命中
let degradedToInjected = 0; // 零命中且孪生仍在库 → 按预注册退化为注入态

pairsWithIds.forEach((p, i) => {
  const q = buildFtsQuery(p.content_newer);
  const rows = q ? store.searchL1Fts(q, TOPK) : [];
  if (!q) noQueryCount++;
  else if (rows.length === 0) zeroHitCount++;
  const twinInDb = !!stmtTwin.get(p.older_id);
  const pair5 = build5CandPair({
    golden: p,
    olderId: p.older_id,
    newerId: p.newer_id,
    searchRows: rows,
    twinInDb,
    seed: SEED,
  });
  if (pair5.twin_source === "injected" && twinInDb) degradedToInjected++;
  pairs.push(pair5);
  if ((i + 1) % 50 === 0) console.log(`[gen] progress ${i + 1}/${pairsWithIds.length}`);
});
store.close();

// ── 4. 全量自校验后再落盘（JSON 往返模拟加载）───────────────────────────
const dataset: Golden5CandDataset = {
  schema: GOLDEN_5CAND_SCHEMA,
  // created_at 取快照创建时刻（birthtime）而非脚本运行时刻：快照复用时 birthtime 稳定，
  // 重跑数据集逐字节幂等（文件级 sha256 可复证，P2-1②）；数据集年代=快照年代更准。
  created_at: new Date(statSync(SNAPSHOT).birthtimeMs).toISOString(),
  source: {
    fixture: FIXTURE,
    live_db: LIVE_DB,
    snapshot: SNAPSHOT,
    l1_rows_in_snapshot: l1Count,
    seed: SEED,
    topk: TOPK,
    retrieval: "buildFtsQuery(content_newer) → VectorStore.searchL1Fts(limit=50)，活库只读 VACUUM INTO 快照",
    session_filter: "none（不套 session 过滤——金标生成于单会话主体时期，隔离边界见统计 md）",
    generator: "scripts/golden-5cand-gen.ts",
  },
  pairs,
};
loadGolden5CandDataset(JSON.parse(JSON.stringify(dataset)), fx); // 非法即抛，不落盘

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_JSON, JSON.stringify(dataset, null, 1), "utf-8");
console.log(`[gen] 数据集已写: ${OUT_JSON}`);

// ── 5. 统计 md ──────────────────────────────────────────────────────────
const n = pairs.length;
const dbInPool = pairs.filter((p) => p.twin_source === "db" && !p.twin_beyond_recall);
const dbBeyond = pairs.filter((p) => p.twin_source === "db" && p.twin_beyond_recall);
const injected = pairs.filter((p) => p.twin_source === "injected");

// db 态名次直方图（细桶）
const rankHist: Array<[string, number]> = [
  ["1-5", 0], ["6-10", 0], ["11-25", 0], ["26-50", 0],
];
for (const p of dbInPool) {
  const r = p.twin_rank!;
  const b = r <= 5 ? 0 : r <= 10 ? 1 : r <= 25 ? 2 : 3;
  rankHist[b]![1]++;
}

// 历史 bucket 分布（fixture 侧，全量 250）
const histBuckets = ["top-5", "6-10", "11-50", "50+", "absent", "no_query"] as const;
const hist: Record<string, number> = {};
for (const b of histBuckets) hist[b] = 0;
for (const p of fx.pairs) hist[p.rank_bucket]++;

// 今日观测口径映射：db 池内→名次桶；db 超召回→"50+"；injected→"injected"
const today: Record<string, number> = { "top-5": 0, "6-10": 0, "11-50": 0, "50+": 0, injected: 0 };
for (const p of dbInPool) {
  const r = p.twin_rank!;
  today[r <= 5 ? "top-5" : r <= 10 ? "6-10" : "11-50"]!++;
}
today["50+"] = dbBeyond.length;
today.injected = injected.length;

// 对照行：历史桶 vs 今日对应类（absent+no_query 合并对照 injected，语义差异见注）
const cmpRows: Array<{ label: string; histN: number; todayN: number }> = [
  { label: "top-5", histN: hist["top-5"]!, todayN: today["top-5"]! },
  { label: "6-10", histN: hist["6-10"]!, todayN: today["6-10"]! },
  { label: "11-50", histN: hist["11-50"]!, todayN: today["11-50"]! },
  { label: "50+", histN: hist["50+"]!, todayN: today["50+"]! },
  { label: "absent/no_query ↔ injected", histN: hist["absent"]! + hist["no_query"]!, todayN: today.injected },
];

const attribution: string[] = [];
for (const row of cmpRows) {
  const diff = ((row.todayN - row.histN) / n) * 100;
  if (Math.abs(diff) > 15) {
    attribution.push(
      `- **${row.label}**: 历史 ${row.histN} (${pct(row.histN, n)}) → 今日 ${row.todayN} (${pct(row.todayN, n)})，差 ${diff >= 0 ? "+" : ""}${diff.toFixed(1)}pp（>15pp）`,
    );
  }
}
if (attribution.length > 0) {
  attribution.push(
    `- 归因（通用）：①金标生成（2026-10-13）后库持续演进——历史 merge 删除孪生行，本次 injected 共 ${injected.length} 对（其中零命中退化 ${degradedToInjected} 对）；②库内新增记忆（快照 l1_records=${l1Count}）稀释 BM25 名次，同内容名次整体后移；③名次口径差异——本次 twin_rank 按剔除命中 newer 自身后的**池内位置**计（候选池语义），与历史 rank_older 的检索链名次存在至多 ±(newer 前置行数) 的偏移；④检索限 top-50，名次>50 一律落"50+"（历史 50+ 为 0，本次 ${dbBeyond.length} 对进「召回缺失地板」分层）。`,
  );
}

const md = `# 金标 5 候选池数据集 · 生成统计（2026-10-24）

- 生成时间（=快照创建时刻，重跑幂等；脚本运行时间见 stdout）: ${dataset.created_at}
- 脚本: \`MemoryCore/scripts/golden-5cand-gen.ts\`（npx tsx，无 LLM 调用；seed=\`${SEED}\`）
- 快照: \`${SNAPSHOT}\`（${statSync(SNAPSHOT).size} bytes，quick_check=${quickCheck}，l1_records=${l1Count}）
- 检索口径: 生产分词 \`buildFtsQuery(content_newer)\`（零复刻）→ 生产 \`VectorStore.searchL1Fts(query, ${TOPK})\`，在活库快照上执行；活库仅以只读连接 VACUUM INTO，绝不以可写模式打开
- **隔离边界**: 检索**不套 session 过滤**（金标生成于单会话主体时期；生产召回链在候选池阶段同样跨会话取候选）
- 数据集: \`${OUT_JSON}\`（schema=${GOLDEN_5CAND_SCHEMA}，落盘前已经 \`loadGolden5CandDataset\` 全量自校验）

## 覆盖与三态计数（n=${n}）

| 状态 | 数量 | 占比 |
|---|---|---|
| db-池内（twin_source=db, beyond=false） | ${dbInPool.length} | ${pct(dbInPool.length, n)} |
| db-超召回（twin_source=db, beyond=true，两臂都取不到孪生→「召回缺失地板」） | ${dbBeyond.length} | ${pct(dbBeyond.length, n)} |
| injected（twin_source=injected，孪生已删/零命中退化） | ${injected.length} | ${pct(injected.length, n)} |

- 孪生仍在库比例: **${dbInPool.length + dbBeyond.length}/${n}（${pct(dbInPool.length + dbBeyond.length, n)}）**
- buildFtsQuery 为 null（分词为空）: ${noQueryCount} 对；有查询但零命中: ${zeroHitCount} 对；其中零命中且孪生在库退化为注入态: ${degradedToInjected} 对（空池在数据集 schema 中非法，按预注册口径退化并在生成日志可辨）

## db 态名次分桶直方图（n=${dbInPool.length}，池内名次）

| 名次桶 | 数量 | 占比(占全量) |
|---|---|---|
${rankHist.map(([b, c]) => `| ${b} | ${c} | ${pct(c, n)} |`).join("\n")}

## 与历史 rank_bucket 分布对照

历史分布（fixture \`rank_bucket\`，n=${n}）：${histBuckets.map((b) => `${b} ${hist[b]} (${pct(hist[b]!, n)})`).join("，")}

| 桶 | 历史 n (%) | 今日 n (%) | 差 (pp) |
|---|---|---|---|
${cmpRows.map((r) => {
  const hd = ((r.todayN - r.histN) / n) * 100;
  return `| ${r.label} | ${r.histN} (${pct(r.histN, n)}) | ${r.todayN} (${pct(r.todayN, n)}) | ${hd >= 0 ? "+" : ""}${hd.toFixed(1)} |`;
}).join("\n")}

> 口径注：历史 absent=当时检索链未出现（含未删但零命中的行）；今日 injected=孪生已删或零命中退化（预注册注入）。两者语义相近不同向，对照仅供漂移观察。
${attribution.length > 0 ? `\n### 差异>15pp 归因\n\n${attribution.join("\n")}\n` : "\n（所有桶差均 ≤15pp，无强制归因项）"}
`;

writeFileSync(OUT_MD, md, "utf-8");
console.log(`[gen] 统计已写: ${OUT_MD}`);
console.log(`[gen] 汇总: n=${n}，db池内=${dbInPool.length}，db超召回=${dbBeyond.length}，injected=${injected.length}，仍在库=${dbInPool.length + dbBeyond.length}/${n}`);
console.log(`[gen] 本次运行时间（不落数据集）: ${new Date().toISOString()}`);
