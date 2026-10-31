#!/usr/bin/env node
/**
 * 票⑦（exp/p1-7-recall-ranking）小金标：召回多信号排序 on/off 离线 A/B。
 *
 * 口径（确定性、零网络、零 LLM）：
 * - 只读 fixtures（--in 目录），不写不删；NOW 固定常量（--now 可覆盖）保证两次运行逐字节可复现。
 * - off 序 = 基线热度降序（稳定排序，平票保输入序）；on 序 = 多信号加权
 *     score = (w1·norm(heat) + w2·2^(-age/halfLife) + w3·relevance + w4·norm(uses)) / Σw
 *   纯导航面 relevance 恒 1；uses=heat（L2 无独立使用计数字段——与 TS 接线同口径）。
 * - norm(heat)=log1p(v)/log1p(max)（与 TS logNorm 同构；选型依据见 recall-ranking.ts）。
 * - 公式在脚本内复刻（TS rankSceneEntries 同构），防漂移交叉校验见
 *   src/core/scene/recall-ranking.sim-drift.test.ts（同输入双实现逐项同序断言）。
 *
 * 两节报告：
 * ① 真实语料（fixtures 全部场景）：off vs on 全序对比（逐场景名次差、Kendall tau
 *    距离、top5 平均年龄）。如实预期：fixtures 为 10-31 恢复合并后的新语料（全部
 *    age≤9 天），on 的重排应当温和——这不是「无效」而是「语料整体新鲜」的真实反映。
 * ② 构造「时效敏感查询」对比集（票面验收口径）：在真实 14 场景作上下文集合上，
 *    构造 陈旧高热(A) vs 新鲜低热(B) 场景对网格（stale-age × heat-ratio），报告
 *    off/on 的「新鲜方居上率」（时效敏感命中率 TSHR）与翻转矩阵。
 *
 * 局限（如实）：本脚本为**结构性/词面代理**，非 LLM 判定——「时效敏感查询显著改善」
 * 的真实结论需启用（on）后由模型行为在 S 期复测；TSHR 衡量的是排序面能否让新鲜
 * 记忆浮到陈旧记忆之前，不等于端到端问答质量。
 *
 * 用法：
 *   node scripts/p1-7-recall-sim.mjs --in <fixtures/scene_blocks> [--now <ISO>] \
 *     [--w1 0.35 --w2 0.30 --w3 0.25 --w4 0.10 --half-life 30]
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DAY_MS = 86_400_000;

/** 直跑 main 守卫：被 vitest 防漂移测试 import 时不执行 CLI 体（保持 import 副作用为零）。 */
function isMain() {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

// ── 与 TS rankSceneEntries 同构的公式复刻（防漂移测试钉住） ──

function ageDaysOf(updated, nowMs) {
  const ms = updated ? Date.parse(updated) : Number.NaN;
  const base = Number.isFinite(ms) ? ms : 0;
  return Math.max(0, (nowMs - base) / DAY_MS);
}

// 与 TS logNorm 同构：log1p(v)/log1p(max)，选型依据见 recall-ranking.ts
function logNorm(v, max) {
  if (max <= 0) return 0;
  const x = Math.log1p(Math.max(0, v)) / Math.log1p(max);
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function rankOffMjs(entries) {
  return [...entries]
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (b.e.heat - a.e.heat) || (a.i - b.i))
    .map((s) => s.e);
}

export function rankOnMjs(entries, ranking, nowMs) {
  if (entries.length === 0) return [];
  const heats = entries.map((e) => (Number.isFinite(e.heat) ? e.heat : 0));
  let hMax = heats[0];
  for (const h of heats) { if (h > hMax) hMax = h; }
  const wSum = ranking.w1 + ranking.w2 + ranking.w3 + ranking.w4;
  const scored = entries.map((e, i) => {
    const heat = heats[i];
    const recency = Math.exp(-((Math.LN2 * Math.max(0, ageDaysOf(e.updated, nowMs))) / ranking.halfLifeDays));
    const score =
      (ranking.w1 * logNorm(heat, hMax) +
        ranking.w2 * recency +
        ranking.w3 * 1 + // 纯导航 relevance 恒 1
        ranking.w4 * logNorm(heat, hMax)) / // uses=heat（与 TS 接线同口径）
      wSum;
    return { e, i, heat, score };
  });
  scored.sort((a, b) => (b.score - a.score) || (b.heat - a.heat) || (a.i - b.i));
  return scored.map((s) => s.e);
}

// ── fixtures 读取 ──

function parseMeta(raw) {
  const s = raw.indexOf("-----META-START-----");
  const e = raw.indexOf("-----META-END-----");
  if (s === -1 || e === -1) return { heat: 0, updated: "", summary: "" };
  const block = raw.slice(s + "-----META-START-----".length, e);
  const heat = block.match(/^heat:\s*(-?\d+)/m);
  const updated = block.match(/^updated:\s*(.*)$/m);
  const summary = block.match(/^summary:\s*(.*)$/m);
  return {
    heat: heat ? parseInt(heat[1], 10) || 0 : 0,
    updated: updated ? updated[1].trim() : "",
    summary: summary ? summary[1].trim() : "",
  };
}

function meanAgeDays(list, nowMs) {
  if (list.length === 0) return 0;
  return list.reduce((acc, e) => acc + ageDaysOf(e.updated, nowMs), 0) / list.length;
}

function kendallTauDistance(a, b) {
  // 以 filename 为键的两序的逆序对计数（Kendall tau 距离，n≤24 直接 O(n²)）
  const posB = new Map(b.map((e, i) => [e.filename, i]));
  const seq = a.map((e) => posB.get(e.filename));
  let inv = 0;
  for (let i = 0; i < seq.length; i++)
    for (let j = i + 1; j < seq.length; j++) if (seq[i] > seq[j]) inv++;
  return inv;
}

function main() {
  const args = process.argv.slice(2);
  const argOf = (flag, dflt) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : dflt;
  };
  const inDir = argOf("--in");
  if (!inDir) {
    console.error("用法: node scripts/p1-7-recall-sim.mjs --in <fixtures/scene_blocks> [--now <ISO>] [--w1 .. --half-life ..]");
    process.exit(1);
  }
  const NOW_MS = Date.parse(argOf("--now", "2026-10-31T00:00:00.000Z"));
  if (!Number.isFinite(NOW_MS)) {
    console.error("--now 非法 ISO");
    process.exit(1);
  }
  const RANKING = {
    w1: Number(argOf("--w1", "0.35")),
    w2: Number(argOf("--w2", "0.30")),
    w3: Number(argOf("--w3", "0.25")),
    w4: Number(argOf("--w4", "0.10")),
    halfLifeDays: Number(argOf("--half-life", "30")),
  };
  if (!(RANKING.w1 + RANKING.w2 + RANKING.w3 + RANKING.w4 > 0) || !(RANKING.halfLifeDays > 0)) {
    console.error("非法权重/半衰期（须 Σw>0 且 halfLife>0）");
    process.exit(1);
  }

  const entries = [];
  for (const f of readdirSync(inDir).sort()) {
    if (!f.endsWith(".md")) continue;
    const meta = parseMeta(readFileSync(join(inDir, f), "utf-8"));
    entries.push({ filename: f, heat: meta.heat, updated: meta.updated, summary: meta.summary });
  }

  const off = rankOffMjs(entries);
  const on = rankOnMjs(entries, RANKING, NOW_MS);
  const posOn = new Map(on.map((e, i) => [e.filename, i]));

  console.log("=== 票⑦ 召回多信号排序 on/off A/B（离线小金标）===");
  console.log(`配置: w1=${RANKING.w1} w2=${RANKING.w2} w3=${RANKING.w3} w4=${RANKING.w4} halfLifeDays=${RANKING.halfLifeDays}`);
  console.log(`NOW=${new Date(NOW_MS).toISOString()}（固定常量，两次运行逐字节可复现）`);
  console.log(`输入: ${entries.length} 场景（只读 ${inDir}）`);
  console.log("");

  console.log("── ① 真实语料全序对比（off=基线热度降序 | on=多信号加权）──");
  console.log("名次 | 场景 | heat | 天龄 | off秩→on秩 (Δ)");
  const moved = [];
  off.forEach((e, i) => {
    const j = posOn.get(e.filename);
    const age = ageDaysOf(e.updated, NOW_MS);
    const delta = i - j;
    if (delta !== 0) moved.push(e.filename);
    console.log(
      `${String(j + 1).padStart(4)} | ${e.filename} | ${e.heat} | ${age.toFixed(1)} | ${i + 1}→${j + 1} (${delta >= 0 ? "+" : ""}${delta})`,
    );
  });
  console.log("");
  console.log(`重排场景数: ${moved.length}/${entries.length}；Kendall tau 距离: ${kendallTauDistance(off, on)}`);
  console.log(`top5 平均天龄: off=${meanAgeDays(off.slice(0, 5), NOW_MS).toFixed(2)} → on=${meanAgeDays(on.slice(0, 5), NOW_MS).toFixed(2)} 天`);
  console.log("");

  console.log("── ② 构造「时效敏感查询」对比集（真实语料作上下文 + 注入 A/B 对）──");
  console.log("对定义: A=陈旧高热（heat=语料最大×ratio, age=staleAge 天） vs B=新鲜低热（heat=语料最小, age=0 天）");
  console.log("指标 TSHR=「新鲜方 B 居于陈旧方 A 之前」的对数占比；off 基线=0（A 热度必高于 B）");
  console.log("");
  const STALE_AGES = [3, 7, 14, 30, 60, 90, 180];
  const RATIOS = [1.2, 2, 5, 10, 50];
  const hotHeat = Math.max(...entries.map((e) => e.heat));
  const lowHeat = Math.min(...entries.map((e) => e.heat));
  const idOf = { A: (r, d) => `__PAIR_A_ratio${r}_age${d}__.md`, B: (r, d) => `__PAIR_B_ratio${r}_age${d}__.md` };
  const isoDaysAgo = (d) => new Date(NOW_MS - d * DAY_MS).toISOString();

  let pairTotal = 0, pairFlip = 0;
  const flipMatrix = [];
  for (const ratio of RATIOS) {
    const rowCells = [];
    for (const staleAge of STALE_AGES) {
      const pairEntries = [
        ...entries,
        { filename: idOf.A(ratio, staleAge), heat: Math.round(hotHeat * ratio), updated: isoDaysAgo(staleAge) },
        { filename: idOf.B(ratio, staleAge), heat: lowHeat, updated: new Date(NOW_MS).toISOString() },
      ];
      const offOrder = rankOffMjs(pairEntries);
      const onOrder = rankOnMjs(pairEntries, RANKING, NOW_MS);
      const rankIn = (list, name) => list.findIndex((e) => e.filename === name);
      const offAFirst = rankIn(offOrder, idOf.A(ratio, staleAge)) < rankIn(offOrder, idOf.B(ratio, staleAge));
      const onBFirst = rankIn(onOrder, idOf.B(ratio, staleAge)) < rankIn(onOrder, idOf.A(ratio, staleAge));
      pairTotal += 1;
      const flipped = offAFirst && onBFirst;
      if (flipped) pairFlip += 1;
      rowCells.push(flipped ? "翻" : (onBFirst ? "怪" : "·"));
    }
    flipMatrix.push({ ratio, rowCells });
  }
  console.log(`翻转矩阵（行=heat 倍率 ${RATIOS.join("/")}，列=陈旧天龄 ${STALE_AGES.join("/")}；翻=off 中 A 先且 on 中 B 越过 A）:`);
  for (const { ratio, rowCells } of flipMatrix) {
    console.log(`  ratio=${String(ratio).padStart(4)}: ${rowCells.join("   ")}`);
  }
  console.log("");
  console.log(`TSHR: off=0.00%（定义基准：A 热度恒高于 B，off 序 A 恒在前）→ on=${((pairFlip / pairTotal) * 100).toFixed(1)}%（${pairFlip}/${pairTotal} 对翻转）`);
  console.log(`解读: 陈旧天龄 ≥ halfLifeDays=${RANKING.halfLifeDays} 量级且热度倍率不过极端时，on 使新鲜低热场景越过陈旧高热场景；`);
  console.log(`      极端热度倍率（×${RATIOS[RATIOS.length - 1]}）与短陈旧期（<${STALE_AGES[0]} 天）不翻转=热度信号保留的设计口径。`);
  console.log("");
  console.log("局限（如实）: ①结构性/词面代理，非 LLM 判定——「显著改善」的真实结论需启用后 S 期模型行为复测；");
  console.log("              ②relevance 恒 1（纯导航面无查询文本），有查询面的 w3 未在本对比中生效；");
  console.log("              ③uses=heat 同源（L2 无独立使用计数字段），w1+w4 合并作用于热度；");
  console.log("              ④构造对的 age/heat 参数为网格枚举，真实语料 age≤9 天时 on 重排温和（见①，非无效）；");
  console.log("              ⑤B 取语料最小热度=对新鲜方的最苛刻构造（log 归一下仍可在中档倍率×长陈旧期翻转）。");
}

if (isMain()) main();
