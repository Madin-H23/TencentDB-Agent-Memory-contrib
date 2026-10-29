#!/usr/bin/env node
/**
 * 方案D（exp/l2-plan-d-summary-index）模拟评测：索引→定向读 vs 整篇读 的字符量对比。
 *
 *   node scripts/l2-index-sim.mjs --in <fixtures/scene_blocks 目录>
 *
 * 模型（确定性、无网络、零依赖）：
 *   - indexed_cost = 索引段字符 + 定向读取的场景字符
 *     （模型先读索引段，再按需 read 所需场景；每文件行假设定向读该文件一次，
 *       合计行用「单场景平均字符」代表期望成本）
 *   - whole_cost  = 全部场景整篇字符之和（基线行为上界：不读索引、需通读）
 *   - saving%     = (1 - indexed_cost / whole_cost) × 100
 *
 * 索引段格式与 src/core/prompts/scene-extraction.ts 的 buildSceneIndexSection
 * 保持一致（__tests__/l2-index-sim.test.ts 有防漂移交叉校验）。
 * 注意：此处摘要只做长度截断（镜像 normalizeSceneSummary 的长度语义），不做
 * PII 脱敏——脱敏只会缩短，字符量按截断计为上界近似。
 *
 * 输入数据（fixtures）在 workspace，不进 git。
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** 与 SCENE_SUMMARY_CHAR_BUDGET 对齐的摘要预算。 */
export const SUMMARY_BUDGET = 300;
/** 与 buildSceneIndexSection 对齐的段头。 */
export const INDEX_HEADER = "### 🗂️ 场景索引（path | heat | summary）";
/** 段头下的引导行（与 TS 侧一致）。 */
export const INDEX_GUIDE = "配合场景索引按需读取所需场景，无需读取全部场景全文。";

/**
 * 截断摘要：超预算在字符边界切断补省略号，避免劈开 UTF-16 代理对。
 * 镜像 normalizeSceneSummary 的长度语义（不含 PII 脱敏，见文件头注释）。
 */
export function truncateSummary(text, maxChars = SUMMARY_BUDGET) {
  if (!text || typeof text !== "string") return "";
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars - 1);
  const lastChar = cut.charCodeAt(cut.length - 1);
  const isHighSurrogate = lastChar >= 0xd800 && lastChar <= 0xdbff;
  return `${isHighSurrogate ? cut.slice(0, -1) : cut}…`;
}

/**
 * 解析场景文件 META（镜像 parseSceneBlock 的字段提取语义，只取 summary/heat）。
 */
export function parseSceneMeta(raw) {
  const startIdx = raw.indexOf("-----META-START-----");
  const endIdx = raw.indexOf("-----META-END-----");
  if (startIdx === -1 || endIdx === -1) return { summary: "", heat: 0 };
  const metaBlock = raw.slice(startIdx + "-----META-START-----".length, endIdx).trim();
  const summaryMatch = metaBlock.match(/^summary:\s*(.*)$/m);
  const heatMatch = metaBlock.match(/^heat:\s*(.*)$/m);
  return {
    summary: summaryMatch ? summaryMatch[1].trim() : "",
    heat: parseInt(heatMatch ? heatMatch[1] : "", 10) || 0,
  };
}

/**
 * 构建索引段文本（与 TS buildSceneIndexSection 同款格式）。
 * entries: [{ filename, summary, heat }]
 */
export function buildIndexSectionText(entries) {
  if (!entries || entries.length === 0) return "";
  const lines = [INDEX_HEADER, INDEX_GUIDE];
  for (const entry of entries) {
    lines.push(`- ${entry.filename} | heat=${entry.heat} | ${truncateSummary(entry.summary)}`);
  }
  return lines.join("\n");
}

const round2 = (x) => Math.round(x * 10000) / 100;

/**
 * 模拟计算。
 * files: [{ filename, raw }]；raw 为文件全文（整篇读的计量口径）。
 */
export function simulate(files) {
  const sorted = [...files].sort((a, b) => (a.filename < b.filename ? -1 : 1));
  const entries = sorted.map((f) => ({ filename: f.filename, ...parseSceneMeta(f.raw) }));
  const sectionText = buildIndexSectionText(entries);
  const indexChars = sectionText.length;
  const rows = sorted.map((f) => {
    const chars = f.raw.length;
    const indexedCost = indexChars + chars;
    return { filename: f.filename, chars, indexedCost, savingPct: 0 };
  });
  const wholeCost = rows.reduce((acc, r) => acc + r.chars, 0);
  for (const row of rows) {
    row.savingPct = wholeCost > 0 ? round2(1 - row.indexedCost / wholeCost) : 0;
  }
  const sceneCount = rows.length;
  const avgSceneChars = sceneCount > 0 ? wholeCost / sceneCount : 0;
  const indexedCost = indexChars + avgSceneChars;
  const savingPct = wholeCost > 0 ? round2(1 - indexedCost / wholeCost) : 0;
  return { sceneCount, indexChars, avgSceneChars, indexedCost, wholeCost, savingPct, rows };
}

/** 读目录（仅 .md，排序确定序）并跑 simulate。 */
export function runCli(inputDir) {
  const files = [];
  for (const f of readdirSync(inputDir).sort()) {
    if (!f.endsWith(".md")) continue;
    const p = join(inputDir, f);
    if (!statSync(p).isFile()) continue;
    files.push({ filename: f, raw: readFileSync(p, "utf-8") });
  }
  return simulate(files);
}

function printReport(inputDir, r) {
  const L = (s = "") => console.log(s);
  L("# L2 场景索引模拟评测（方案D：索引→定向读 vs 整篇读）");
  L();
  L(`- 输入目录: ${inputDir}`);
  L(`- 场景数: ${r.sceneCount}`);
  L(`- 索引段字符: ${r.indexChars.toLocaleString()}`);
  L(`- 单场景平均字符: ${Math.round(r.avgSceneChars).toLocaleString()}`);
  L(`- 整篇总字符 (whole_cost): ${r.wholeCost.toLocaleString()}`);
  L();
  L("| 场景 | 全文字符 | indexed_cost(索引段+该场景) | whole_cost | 节省% |");
  L("|---|---:|---:|---:|---:|");
  for (const row of r.rows) {
    L(
      `| ${row.filename} | ${row.chars.toLocaleString()} | ${row.indexedCost.toLocaleString()} | ` +
        `${r.wholeCost.toLocaleString()} | ${row.savingPct.toFixed(2)}% |`,
    );
  }
  L();
  L(
    `合计: indexed_cost=${Math.round(r.indexedCost).toLocaleString()} ` +
      `(索引段 ${r.indexChars.toLocaleString()} + 单场景平均 ${Math.round(r.avgSceneChars).toLocaleString()}) ` +
      `| whole_cost=${r.wholeCost.toLocaleString()} ` +
      `| saving%=${r.savingPct.toFixed(2)}%`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argIdx = process.argv.indexOf("--in");
  const inputDir = argIdx > -1 ? process.argv[argIdx + 1] : undefined;
  if (!inputDir || !existsSync(inputDir)) {
    console.error(`用法: node scripts/l2-index-sim.mjs --in <scene_blocks 目录>（目录不存在: ${inputDir ?? "(缺省)"}）`);
    process.exit(2);
  }
  printReport(inputDir, runCli(inputDir));
}
