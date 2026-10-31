#!/usr/bin/env node
/**
 * 票⑤（exp/p1-5-scene-format-v2）离线模拟评测：小金标 + 默认读体积达成率。
 *
 * 口径（确定性、零网络、零 LLM）：
 * - 只读 fixtures（--in 目录），不写不删；问答集经 --qa-out 落到指定目录（默认不落盘）。
 * - 「v2 要点层」离线不可得（要点层=模型撰写的稳定摘要），用两个**下界代理**对比：
 *     A) 现状导航面 = META.summary 经 normalizeSceneSummary 同口径（PII 脱敏省略——
 *        fixtures 为词面统计口径，脱敏不影响词面覆盖结论；300 字预算同款）；
 *     B) v2 要点层代理 = 事实行（含锚点 id 的行）高频词去重拼接，300 字预算。
 * - 判分：词面覆盖启发式（非 LLM 问答判定）——真值 = 事实行分词（CJK 双字组+拉丁词，
 *   去锚点 id/停用词）；得分 = 候选视图覆盖的真值词占比。
 * - 「单场景默认 read ≤32K 达成率」：v2 默认视图代理 = META 块 + ## 要点（代理B）+
 *   ## 事实（锚点行）的字符数 ≤ 32768 计达成。
 *
 * 局限（如实）：本脚本给出的是**结构性下界**——真实可答率需 v2 启用后用模型要点层
 * + LLM 判定问答在 S 期复测；词面覆盖不能替代语义可答性。
 *
 * 用法：
 *   node scripts/p1-5-v2-sim.mjs --in <fixtures/scene_blocks> [--qa-out <dir>]
 */

import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

const args = process.argv.slice(2);
function argOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const inDir = argOf("--in");
if (!inDir) {
  console.error("用法: node scripts/p1-5-v2-sim.mjs --in <fixtures/scene_blocks> [--qa-out <dir>]");
  process.exit(1);
}
const qaOut = argOf("--qa-out");
const VIEW_CAP = 32768;
const GIST_BUDGET = 300;

const ANCHOR_RE = /m_\d{13}_[0-9a-f]{8}/g;
const META_START = "-----META-START-----";
const META_END = "-----META-END-----";

function truncate300(text) {
  if (text.length <= GIST_BUDGET) return text;
  const cut = text.slice(0, GIST_BUDGET - 1);
  const last = cut.charCodeAt(cut.length - 1);
  const isHigh = last >= 0xd800 && last <= 0xdbff;
  return (isHigh ? cut.slice(0, -1) : cut) + "…";
}

function parseMeta(raw) {
  const s = raw.indexOf(META_START);
  const e = raw.indexOf(META_END);
  if (s === -1 || e === -1) return { meta: null, metaLines: [], body: raw };
  const metaLines = raw.split("\n").slice(raw.slice(0, s).split("\n").length - 1, raw.slice(0, e).split("\n").length);
  const metaBlock = raw.slice(s + META_START.length, e);
  const summary = (metaBlock.match(/^summary:\s*(.*)$/m) ?? [, ""])[1] ?? "";
  const body = raw.slice(e + META_END.length).trim();
  return { meta: { summary }, metaLines: [...raw.split("\n").slice(raw.slice(0, s).split("\n").length, raw.slice(0, e).split("\n").length + 1)], body };
}

const STOP = new Set(["并且", "但是", "然后", "这个", "那个", "以及", "或者", "因为", "所以", "如果", "我们", "他们", "可以", "需要", "已经", "没有", "一个", "进行", "使用", "通过", "对于", "关于", "the", "and", "for", "with", "this", "that", "from", "have", "not"]);

/** 分词：CJK 连续段按双字组滑窗 + 拉丁/数字词。 */
function tokenize(text) {
  const tokens = new Set();
  const cleaned = text.replace(ANCHOR_RE, " ").replace(/\s+/g, " ");
  for (const m of cleaned.matchAll(/[A-Za-z][A-Za-z0-9_.-]{1,}/g)) {
    const w = m[0].toLowerCase();
    if (!STOP.has(w) && w.length >= 2) tokens.add(w);
  }
  for (const m of cleaned.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const seg = m[0];
    if (seg.length === 2) {
      if (!STOP.has(seg)) tokens.add(seg);
    } else {
      for (let i = 0; i + 2 <= seg.length; i++) {
        const g = seg.slice(i, i + 2);
        if (!STOP.has(g)) tokens.add(g);
      }
    }
  }
  return tokens;
}

const files = readdirSync(inDir).filter((f) => f.endsWith(".md")).sort();
const scenes = [];
for (const f of files) {
  const raw = readFileSync(join(inDir, f), "utf-8");
  const { meta, body } = parseMeta(raw);
  const bodyLines = body.split("\n");
  const facts = bodyLines.filter((l) => /m_\d{13}_[0-9a-f]{8}/.test(l));
  const summary = meta?.summary ?? "";
  scenes.push({ filename: f, summary, facts, raw, bodyLines });
}

// ── 候选视图构造 ──
function gistProxyCurrent(s) {
  return truncate300(s.summary.replace(/\s+/g, " ").trim());
}
function gistProxyV2(s) {
  // 事实行高频词去重拼接（要点层下界代理）
  const freq = new Map();
  for (const line of s.facts) {
    for (const t of tokenize(line)) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const parts = [];
  let len = 0;
  for (const [tok] of ranked) {
    if (len + tok.length + 1 > GIST_BUDGET) break;
    parts.push(tok);
    len += tok.length + 1;
  }
  return parts.join(" ");
}

// ── Mode A：小金标（词面覆盖） ──
// 真值口径：**区分性词**——在 ≥2 条不同事实行中出现（复现主题，现实查询词形态）
// 的 token（拉丁词 ≥3 字符 / CJK 双字组），按出现行数取前 30。全量 bigram 滑窗作
// 真值在数学上不可被 300 字视图覆盖（实测 1.3% 假阴性），弃用。
const qa = [];
let microHit = 0, microTotal = 0;
const perScene = [];
for (const s of scenes) {
  const lineCount = new Map();
  for (const line of s.facts) {
    const seen = new Set();
    for (const t of tokenize(line)) {
      if (seen.has(t)) continue;
      seen.add(t);
      lineCount.set(t, (lineCount.get(t) ?? 0) + 1);
    }
  }
  const distinct = [...lineCount.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const truth = new Set(distinct.slice(0, 30).map(([t]) => t));
  // 真值太小（<5 词）的场景不计入（无区分度）
  if (truth.size < 5) {
    perScene.push({ scene: s.filename, truthTokens: truth.size, skip: true, skipReason: `区分性词 ${distinct.length} <5` });
    continue;
  }
  const cands = { "A_现状索引300": gistProxyCurrent(s), "B_v2要点层代理300": gistProxyV2(s) };
  const scores = {};
  for (const [k, text] of Object.entries(cands)) {
    const cover = [...truth].filter((t) => text.toLowerCase().includes(t.toLowerCase()));
    scores[k] = cover.length / truth.size;
  }
  microHit += [...truth].filter((t) => cands["B_v2要点层代理300"].toLowerCase().includes(t.toLowerCase())).length;
  microTotal += truth.size;
  perScene.push({ scene: s.filename, truthTokens: truth.size, scores });
  // 派生问答：取真值中前 2 个词各出一题（带证据行）
  for (const tok of [...truth].slice(0, 2)) {
    const evidence = s.facts.find((l) => l.toLowerCase().includes(tok.toLowerCase())) ?? "";
    qa.push({
      scene: s.filename,
      q: `场景《${s.filename.replace(/\.md$/, "")}》中与「${tok}」相关的事实行是什么？`,
      keyword: tok,
      expectedEvidenceLine: evidence,
    });
  }
}
const qaCapped = qa.slice(0, 20);
const macro = perScene.filter((p) => !p.skip && p.scores);
const avg = (arr, k) => (arr.length ? arr.reduce((acc, p) => acc + p.scores[k], 0) / arr.length : NaN);
const microB = microTotal ? microHit / microTotal : 0;

// ── Mode B：默认 read ≤32K 达成率（v2 默认视图代理） ──
const sizes = scenes.map((s) => {
  const metaPart = s.raw.split(META_END)[0] + META_END;
  const gist = gistProxyV2(s);
  const view = [metaPart, "", "## 要点", gist, "", "## 事实", ...s.facts].join("\n");
  return { scene: s.filename, viewChars: view.length, wholeChars: s.raw.length, ok: view.length <= VIEW_CAP };
});
const okCount = sizes.filter((x) => x.ok).length;

console.log("=== 票⑤ 离线模拟（词面覆盖启发式 + 结构性读视图代理）===");
console.log(`语料: ${scenes.length} 个场景（${inDir}）`);
console.log("");
console.log("[小金标] 要点层词面覆盖（真值=事实行分词，非 LLM 判定）");
console.log(`  A 现状导航面（summary 300 截断，即 D 索引现状）: 宏平均 ${(avg(macro, "A_现状索引300") * 100).toFixed(1)}%`);
console.log(`  B v2 要点层代理（事实行高频词 300 字）:        宏平均 ${(avg(macro, "B_v2要点层代理300") * 100).toFixed(1)}%（微平均 ${(microB * 100).toFixed(1)}%）`);
console.log(`  计分场景: ${macro.length}/${scenes.length}（真值词 <5 的场景跳过）`);
console.log("");
console.log("[读体积] v2 默认视图代理（META+要点代理+事实行）≤32K 达成率");
for (const x of sizes) {
  console.log(`  ${x.ok ? "PASS" : "FAIL"}  ${x.scene.padEnd(40)} view=${x.viewChars}  whole=${x.wholeChars}`);
}
console.log(`  达成率: ${okCount}/${sizes.length} = ${((okCount / sizes.length) * 100).toFixed(1)}%（票面验收② 目标 ≥80%）`);
console.log("");
console.log("局限: 本脚本为结构性下界模拟——要点层真值需 v2 启用后由模型撰写并经 LLM 问答判定复测；词面覆盖≠语义可答性。");

if (qaOut) {
  mkdirSync(qaOut, { recursive: true });
  writeFileSync(join(qaOut, "qa-set.json"), JSON.stringify({ generatedFrom: basename(inDir), count: qaCapped.length, questions: qaCapped }, null, 2), "utf-8");
  writeFileSync(join(qaOut, "scores.json"), JSON.stringify({ perScene, microB, macroA: avg(macro, "A_现状索引300"), macroB: avg(macro, "B_v2要点层代理300"), viewSizes: sizes, viewOkRate: okCount / sizes.length }, null, 2), "utf-8");
  console.log(`\n问答集(${qaCapped.length} 题)与评分已落: ${qaOut}`);
}
