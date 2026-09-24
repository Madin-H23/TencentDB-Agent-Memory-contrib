// 存量归属清理（一次性维护工具，2026-09-24 事故后）：
// 把 L1 records 中「用户（X）X 非白名单」的内容归一为「用户」，同步真相源
// （records/*.jsonl 原地重写）与检索引擎（vectors.db：delete+upsert 复用官方
// FTS 同步路径），并修正 L2 场景块 / 场景索引 / L3 persona 里扩散开的同款文本。
//
// 用法（网关需已停）：
//   npx tsx scripts/fix-user-attribution.ts --data <dataDir> [--dry]
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { VectorStore } from "../src/core/store/sqlite.js";
import { sanitizeUserAttribution } from "../src/core/record/attribution.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";

const args = process.argv.slice(2);
const dataDir = args.includes("--data") ? args[args.indexOf("--data") + 1]! : join(homedir(), ".memory-tencentdb", "memory-tdai");
const dry = args.includes("--dry");
const ALLOW = ["何伟健", "heweijian", "Weijian He"];
const PROFILE_DIR = join(dataDir, "profiles", "team%3Adefault%7Cagent%3Adefault");

const store = new VectorStore(join(dataDir, "vectors.db"), 4);
store.init();

let fixedL1 = 0;
const labelCounts = new Map<string, number>();

// ── L1 records：jsonl 原地重写 + VDB delete/upsert ──
const recordsDir = join(dataDir, "records");
for (const f of readdirSync(recordsDir).filter((n) => n.endsWith(".jsonl"))) {
  const p = join(recordsDir, f);
  const lines = readFileSync(p, "utf-8").split("\n");
  let changed = false;
  const out = lines.map((line) => {
    const t = line.trim();
    if (!t) return line;
    let r: MemoryRecord;
    try { r = JSON.parse(t) as MemoryRecord; } catch { return line; }
    const { text, dropped } = sanitizeUserAttribution(String(r.content ?? ""), ALLOW);
    if (text === r.content) return line;
    for (const label of dropped) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    r.content = text;
    changed = true;
    fixedL1++;
    if (!dry) {
      // 检索引擎侧：删旧行再 upsert（upsert 自行同步 FTS），embedding 未配置故无向量
      store.deleteL1(r.record_id);
      store.upsertL1(r, undefined);
    }
    return JSON.stringify(r);
  });
  if (changed && !dry) writeFileSync(p, out.join("\n"), "utf-8");
}

// ── L2 场景块 / L3 persona / 场景索引：同款归一 ──
let fixedL2 = 0;
let fixedL3 = 0;
let fixedIndex = 0;
const sceneDir = join(PROFILE_DIR, "scene_blocks");
for (const f of readdirSync(sceneDir).filter((n) => n.endsWith(".md"))) {
  const p = join(sceneDir, f);
  const text = readFileSync(p, "utf-8");
  const { text: fixed, dropped } = sanitizeUserAttribution(text, ALLOW);
  if (fixed !== text) {
    fixedL2 += dropped.length;
    for (const label of dropped) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    if (!dry) writeFileSync(p, fixed, "utf-8");
  }
}
const personaPath = join(PROFILE_DIR, "persona.md");
{
  const text = readFileSync(personaPath, "utf-8");
  const { text: fixed, dropped } = sanitizeUserAttribution(text, ALLOW);
  if (fixed !== text) {
    fixedL3 += dropped.length;
    for (const label of dropped) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    if (!dry) writeFileSync(personaPath, fixed, "utf-8");
  }
}
const indexPath = join(PROFILE_DIR, ".metadata", "scene_index.json");
{
  const raw = readFileSync(indexPath, "utf-8");
  let idx = JSON.parse(raw) as Array<{ summary?: string }>;
  let dirty = false;
  idx = idx.map((it) => {
    if (!it.summary) return it;
    const { text, dropped } = sanitizeUserAttribution(it.summary, ALLOW);
    if (text === it.summary) return it;
    dirty = true;
    fixedIndex += dropped.length;
    for (const label of dropped) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    return { ...it, summary: text };
  });
  if (dirty && !dry) writeFileSync(indexPath, JSON.stringify(idx, null, 2), "utf-8");
}

store.close();
console.log(
  `[fix-user-attribution] ${dry ? "DRY-RUN" : "已执行"}: L1=${fixedL1} L2=${fixedL2} L3=${fixedL3} index=${fixedIndex}`,
);
console.log("  丢弃标签 TOP15:", [...labelCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15));
