#!/usr/bin/env node
/**
 * L2 治理多方案统一评分器（exp/l2-base，2026-10-30）。
 *
 * 所有方案分支用同一把尺子：
 *   node scripts/l2-score.mjs --fixtures <冻结输入目录> [--output <方案产物目录>]
 *
 * 硬门槛（任一不过 = 方案不合格）：
 *   - 锚点保留率 100%（m_<ts>_<rand> 多重集，压缩/拆分不得丢任何事实锚点）
 *   - 输出文件 META 结构完整（-----META-START----- / heat: / summary:）
 * 软指标（对比用）：
 *   - 体积：总字符 in/out 与压缩比
 *   - 文件数
 * 输入数据在 workspace（exp-l2/fixtures），**不进 git**（含个人记忆内容）。
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const fixtures = arg("fixtures");
const output = arg("output");
if (!fixtures || !existsSync(fixtures)) {
  console.error(`fixtures 目录不存在: ${fixtures}`);
  process.exit(2);
}

const ANCHOR_RE = /m_\d{13}_[0-9a-f]{8}/g;
const anchorsOf = (text) => text.match(ANCHOR_RE) ?? [];

function readDirText(dir) {
  const out = {};
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".md")) continue;
    const p = join(dir, f);
    if (statSync(p).isFile()) out[f] = readFileSync(p, "utf8");
  }
  return out;
}

const L = (s = "") => console.log(s);
const input = readDirText(fixtures);
const inAnchors = [];
const inChars = { total: 0 };
for (const [f, t] of Object.entries(input)) {
  inAnchors.push(...anchorsOf(t));
  inChars.total += t.length;
}
const inAnchorCount = new Map();
for (const a of inAnchors) inAnchorCount.set(a, (inAnchorCount.get(a) ?? 0) + 1);

L("# L2 方案评分报告");
L();
L(`## 输入（冻结 fixtures）`);
L(`- 文件数: ${Object.keys(input).length}`);
L(`- 总字符: ${inChars.total.toLocaleString()}`);
L(`- 事实锚点: ${inAnchors.length.toLocaleString()}（去重 ${inAnchorCount.size.toLocaleString()}）`);
L();

if (!output) {
  L("> 未提供 --output，仅输出输入基线。");
  process.exit(0);
}
if (!existsSync(output)) {
  console.error(`output 目录不存在: ${output}`);
  process.exit(2);
}

const out = readDirText(output);
const outAnchors = [];
let outChars = 0;
let metaOk = 0;
let metaBad = [];
for (const [f, t] of Object.entries(out)) {
  outAnchors.push(...anchorsOf(t));
  outChars += t.length;
  if (t.includes("-----META-START-----") && /(^|\n)heat:/.test(t) && /(^|\n)summary:/.test(t)) metaOk++;
  else metaBad.push(f);
}

// 锚点多重集保留率：输出对每个锚点 id 的计数 ≥ 输入计数 才算保留
let missing = 0;
for (const [id, n] of inAnchorCount) {
  const got = outAnchors.filter((a) => a === id).length;
  if (got < n) missing += n - got;
}
const retention = 100 - (missing / inAnchors.length) * 100;
const ratio = inChars.total / outChars;

L(`## 方案产物（${output}）`);
L(`- 文件数: ${Object.keys(out).length}（输入 ${Object.keys(input).length}）`);
L(`- 总字符: ${outChars.toLocaleString()}（压缩比 ${ratio.toFixed(2)}x）`);
L();
L("## 硬门槛");
L(`- 锚点保留率: ${retention.toFixed(4)}%（丢失 ${missing} 个）→ ${retention >= 100 ? "PASS" : "FAIL"}`);
L(`- META 结构: ${metaOk}/${Object.keys(out).length} → ${metaBad.length === 0 ? "PASS" : `FAIL（${metaBad.join(", ")}）`}`);
L();
const pass = retention >= 100 && metaBad.length === 0;
L(`SCORE anchor_retention=${retention.toFixed(4)} ratio=${ratio.toFixed(3)} meta_ok=${metaOk}/${Object.keys(out).length} verdict=${pass ? "PASS" : "FAIL"}`);
if (missing > 0) {
  L();
  L("丢失锚点样例（前 5）:");
  for (const [id, n] of inAnchorCount) {
    const got = outAnchors.filter((a) => a === id).length;
    if (got < n) L(`  - ${id}（输入 ${n} / 输出 ${got}）`);
    if (--missing <= -5) break;
  }
}
process.exit(pass ? 0 : 1);
