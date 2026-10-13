/**
 * M1 D3 金标归因器（第二段）——给 golden-gen.py 产出的候选对加 FTS 归因排名，
 * 并产出标注视图。防锚定（二审设计）：标注视图只显示 编号/类型/两条内容/裁决空栏；
 * sim / created_* / version_* / scene_* / band / subset / rank* 只进 candidates JSON。
 *
 * FTS 口径：导入生产零件（buildFtsQuery / parseFtsQueryTokens / bm25RankToScore /
 * rankByTokenCoverage / rowMatchesIsolation），orchestration 复刻自
 * `src/core/store/sqlite.ts:3115-3195`（searchL1Fts）；SQL 原文见 sqlite.ts:1146-1157；
 * TOKEN_SCAN_LIMIT=200（sqlite.ts:315，未导出，随口径 pin）。**若该段变更必须同步本
 * 脚本**——归因排名是金标的召回层度量，口径漂移 = 度量失真。
 *
 * 归因定义：对 (older, newer)，用 newer 的内容走生产 FTS 链（limit=50），找 older
 * 的名次。探针在「当前」库上跑，名次是创建时的**下界**（库只增不缩），与一审归因
 * 实验同款口径（handoff-m1-dedup-recall-review-20261013.md 第一节）。
 *
 * 库以 node:sqlite `{ readOnly: true }` 打开——绝不写。
 *
 * 用法：node --import tsx scripts/golden-attribute.ts <pairs.json> <outDir>
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  buildFtsQuery,
  parseFtsQueryTokens,
  bm25RankToScore,
  rankByTokenCoverage,
} from "../src/core/store/sqlite.js";
import { rowMatchesIsolation } from "../src/core/store/isolation.js";

const DB_PATH = join(homedir(), ".memory-tencentdb", "memory-tdai", "vectors.db");
const TOKEN_SCAN_LIMIT = 200; // sqlite.ts:315
const ATTRIBUTE_LIMIT = 50; // 归因看到的名次深度（生产候选池是 limit=10 内取 5）

// SQL 原文复刻自 sqlite.ts:1146-1157（stmtL1FtsSearch）
const FTS_SQL = `
  SELECT record_id, content_original AS content, type, priority, scene_name,
         session_key, session_id, team_id, task_id, user_id, agent_id, version,
         timestamp_str, timestamp_start, timestamp_end,
         metadata_json,
         bm25(l1_fts) AS rank
  FROM l1_fts
  WHERE l1_fts MATCH ?
  ORDER BY rank ASC
  LIMIT ?
`;

interface Pair {
  pid: string;
  band: string;
  subset: string;
  sim: number | null;
  older_id: string;
  newer_id: string;
  type_older: string;
  type_newer: string;
  version_older: number;
  version_newer: number;
  created_older: string;
  created_newer: string;
  scene_older: string;
  scene_newer: string;
  content_older: string;
  content_newer: string;
}

/** 复刻 searchL1Fts(sqlite.ts:3115-3195) 的排序结果（取前 limit 条 record_id 有序列表）。 */
function ftsChain(db: DatabaseSync, ftsQuery: string, limit: number): string[] {
  const retrieveLimit = Math.max(limit * 5, limit, 20);
  const rows = db.prepare(FTS_SQL).all(ftsQuery, retrieveLimit) as Array<Record<string, unknown>>;
  const mappedAll = rows
    .filter((r) => rowMatchesIsolation(r as Parameters<typeof rowMatchesIsolation>[0], undefined))
    .map((r) => ({ ...r, score: bm25RankToScore(Number(r.rank)) }));
  const tokens = parseFtsQueryTokens(ftsQuery);
  let ranked = mappedAll;
  if (tokens.length > 1 && mappedAll.length > 1) {
    const totalDocs = (db.prepare("SELECT COUNT(*) AS c FROM l1_fts").get() as { c: number }).c;
    const tokenDocIds = new Map<string, Set<string>>();
    let scanTruncated = false;
    for (const token of tokens) {
      const perToken = db.prepare(FTS_SQL).all(`"${token.replaceAll('"', "")}"`, TOKEN_SCAN_LIMIT) as Array<{ record_id: string }>;
      if (perToken.length >= TOKEN_SCAN_LIMIT) scanTruncated = true;
      tokenDocIds.set(token, new Set(perToken.map((r) => r.record_id)));
    }
    ranked = scanTruncated ? mappedAll.slice(0, limit) : rankByTokenCoverage(mappedAll, tokenDocIds, totalDocs);
  }
  return ranked.slice(0, limit).map((r) => String((r as { record_id: string }).record_id));
}

function bucket(rank1: number | null): string {
  if (rank1 === null) return "absent";
  if (rank1 <= 5) return "top-5";
  if (rank1 <= 10) return "6-10";
  if (rank1 <= ATTRIBUTE_LIMIT) return "11-50";
  return "50+";
}

function main() {
  const [pairsPath, outDir] = process.argv.slice(2);
  if (!pairsPath || !outDir) {
    console.error("usage: golden-attribute.ts <pairs.json> <outDir>");
    process.exit(1);
  }
  const doc = JSON.parse(readFileSync(pairsPath, "utf-8")) as { pairs: Pair[] };
  const db = new DatabaseSync(DB_PATH, { readOnly: true });

  const buckets: Record<string, number> = {};
  const out: Pair[] = [];
  for (const p of doc.pairs) {
    const q = buildFtsQuery(p.content_newer);
    let rank1: number | null = null;
    let bkt = "no_query";
    if (q) {
      const chain = ftsChain(db, q, ATTRIBUTE_LIMIT);
      const idx = chain.indexOf(p.older_id);
      rank1 = idx >= 0 ? idx + 1 : null;
      bkt = bucket(rank1);
    }
    buckets[bkt] = (buckets[bkt] ?? 0) + 1;
    out.push({ ...p, rank_older: rank1 ?? -1, rank_bucket: bkt } as Pair & { rank_older: number; rank_bucket: string });
  }
  db.close();

  mkdirSync(outDir, { recursive: true });
  const candidates = {
    generated_at: new Date().toISOString(),
    source_pairs: pairsPath,
    attribution: {
      definition: "newer 内容走生产 FTS 链（limit=50）时 older 的名次；当前库口径=创建时下界",
      fts_source: "src/core/store/sqlite.ts:3115-3195（orchestration 复刻+零件导入）",
      buckets,
    },
    pairs: out,
  };
  const candPath = join(outDir, "m1-golden-candidates.json");
  writeFileSync(candPath, JSON.stringify(candidates, null, 1), "utf-8");

  // 标注视图：只显示 编号/类型/内容/裁决空栏（防锚定）
  const lines: string[] = [
    "# M1 小金标 · 一判标注（用户）",
    "",
    "> 对每对记忆裁决：**应合并**（同一事实/规则/偏好/事件的不同措辞或互补阶段）/",
    "> **不应合并**（同主题但不同事实、不同对象、不同时间点的独立事件）/",
    "> **应 update**（信息演进：新约束取代旧约束）/ **跳过**（无法判断）。",
    "> 只依据两条内容本身判断；不要推测来源。把每对的 `裁决:` 后填入关键词即可。",
    "",
  ];
  for (const p of out) {
    lines.push(`## ${p.pid}（${p.type_older} / ${p.type_newer}）`);
    lines.push(`- A：${p.content_older}`);
    lines.push(`- B：${p.content_newer}`);
    lines.push(`- 裁决：`);
    lines.push("");
  }
  const mdPath = join(outDir, "m1-golden-annotation.md");
  writeFileSync(mdPath, lines.join("\n"), "utf-8");

  console.log(JSON.stringify({ buckets, pairs: out.length, candidates: candPath, annotation: mdPath }, null, 2));
}

main();
