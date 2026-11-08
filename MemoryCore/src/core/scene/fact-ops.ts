/**
 * 票 P1-6b 方案一/二：事实级四元操作（mem0 式 ADD/UPDATE/DELETE/NOOP）的
 * prompt 构建与响应解析。纯函数，零 I/O——LLM 调用与嵌入相似度由调用方注入。
 *
 * - 方案一「LLM 全量四元判定」：`buildFactOpsPrompt`（既有×新批全量）+ `parseFactOpsResponse`。
 * - 方案二「向量候选+轻判定」：`pairCandidatesBySimilarity`（文本相似度做候选池；
 *   生产接线时替换为 embedding 余弦）+ `buildJudgePrompt`/`parseJudgeResponse`（逐对小判定）。
 * - 输出约定：UPDATE/DELETE 落地时由调用方对 targetAnchor 行加 `[SUPERSEDED <ISO>]`
 *   前缀（复用 utils/supersede 的守卫与帽排除口径）；本模块不直接改写文件。
 */

export type FactOpKind = "add" | "update" | "delete" | "noop";

export interface FactOp {
  op: FactOpKind;
  /** 判定所涉的新事实文本。 */
  fact?: string;
  /** update/delete 的目标旧行锚点 id。 */
  targetAnchor?: string;
}

export interface FactOpsParseResult {
  ops: FactOp[];
  /** 整体解析失败（找不到 JSON 数组等）。 */
  error?: string;
  /** 逐条结构问题（未知 op / update-delete 缺 targetAnchor）。 */
  errors?: string[];
}

const OPS_PROMPT = `你维护一份长期记忆的事实清单。下面给出「既有事实」与「新批事实」。
对新批事实的每一条，对照既有事实判定操作并只输出 JSON 数组：
- ADD：全新事实（既有清单没有可替代项）→ {"op":"add","fact":"<新事实原文>"}
- UPDATE：同一事实的更新版本（数值/状态/结论变化）→ {"op":"update","fact":"<新事实原文>","targetAnchor":"<被替代旧行的锚点 id>"}
- DELETE：新信息使某条既有事实失效（被撤销/证伪）→ {"op":"delete","fact":"<新事实原文>","targetAnchor":"<失效旧行的锚点 id>"}
- NOOP：同源重投或无信息量 → {"op":"noop","fact":"<新事实原文>"}
判定语义（硬约束）：
1. 「同一事实的更新」= 陈述同一件事且新旧结论互斥或演进；「同一实体的不同事实」不是 UPDATE，是 ADD。
2. 拿不准一律 NOOP（宁漏勿错）。
3. UPDATE/DELETE 的 targetAnchor 必填且必须来自既有清单；被替代旧行将由系统加 [SUPERSEDED] 标记，不物理删除。
4. 只输出 JSON 数组，无其他文字。`;

export function buildFactOpsPrompt(existing: string[], incoming: string[]): string {
  const fmt = (title: string, arr: string[]) =>
    arr.length ? arr.map((s, i) => `${i + 1}. ${s}`).join("\n") : "（无）";
  return `${OPS_PROMPT}\n\n## 既有事实\n${fmt("existing", existing)}\n\n## 新批事实\n${fmt("incoming", incoming)}\n`;
}

function extractJsonArray(text: string): unknown[] | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const OP_KINDS: ReadonlySet<string> = new Set(["add", "update", "delete", "noop"]);

export function parseFactOpsResponse(text: string): FactOpsParseResult {
  const arr = extractJsonArray(text);
  if (!arr) return { ops: [], error: "no-json-array" };
  const ops: FactOp[] = [];
  const errors: string[] = [];
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i] as Record<string, unknown> | null;
    const op = typeof item?.op === "string" ? item.op.toLowerCase() : "";
    if (!OP_KINDS.has(op)) {
      errors.push(`[${i}] unknown-op:${String(item?.op ?? "∅")}`);
      continue;
    }
    if ((op === "update" || op === "delete") && typeof item?.targetAnchor !== "string") {
      errors.push(`[${i}] ${op}-missing-targetAnchor`);
    }
    ops.push({
      op: op as FactOpKind,
      fact: typeof item?.fact === "string" ? item.fact : undefined,
      targetAnchor: typeof item?.targetAnchor === "string" ? item.targetAnchor : undefined,
    });
  }
  return { ops, errors: errors.length ? errors : undefined };
}

/** 方案二候选对：新事实 × 既有事实的相似度过阈入选。 */
export interface CandidatePair {
  incomingIndex: number;
  existingIndex: number;
  incomingAnchor?: string;
  existingAnchor?: string;
  similarity: number;
}

/** 无锚版文本相似度（与 scene-supersede 同口径：空白归一 + 二字 gram Jaccard）。 */
function bareSimilarity(a: string, b: string): number {
  const x = a.replace(/\s+/g, "");
  const y = b.replace(/\s+/g, "");
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = (s: string): Set<string> => {
    const m = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) m.add(s.slice(i, i + 2));
    return m;
  };
  const gx = grams(x);
  const gy = grams(y);
  let inter = 0;
  for (const g of gx) if (gy.has(g)) inter++;
  return inter / (gx.size + gy.size - inter);
}

export function pairCandidatesBySimilarity(
  incoming: Array<{ text: string; anchor?: string }>,
  existing: Array<{ text: string; anchor?: string }>,
  threshold: number,
): CandidatePair[] {
  const pairs: CandidatePair[] = [];
  for (let i = 0; i < incoming.length; i++) {
    for (let j = 0; j < existing.length; j++) {
      const sim = bareSimilarity(incoming[i]!.text, existing[j]!.text);
      if (sim >= threshold) {
        pairs.push({
          incomingIndex: i,
          existingIndex: j,
          incomingAnchor: incoming[i]!.anchor,
          existingAnchor: existing[j]!.anchor,
          similarity: sim,
        });
      }
    }
  }
  return pairs.sort((p, q) => q.similarity - p.similarity);
}

const JUDGE_PROMPT = `判定下面两行记忆事实的关系，只输出一个词：
- SUPERSEDE：新行是对旧行**同一事实**的更新/复述（陈述同一件事，新旧结论互斥或演进）。
- DISTINCT：**同一实体的不同事实**或无关（不是同一件事）。
- UNKNOWN：信息不足。
拿不准输出 UNKNOWN（宁漏勿错）。

## 旧行
{OLD}

## 新行
{NEW}`;

export function buildJudgePrompt(oldLine: string, newLine: string): string {
  return JUDGE_PROMPT.replace("{OLD}", oldLine).replace("{NEW}", newLine);
}

export type JudgeVerdict = "supersede" | "distinct" | "unknown";

export function parseJudgeResponse(text: string): JudgeVerdict {
  const t = text.toLowerCase();
  if (t.includes("supersede")) return "supersede";
  if (t.includes("distinct")) return "distinct";
  return "unknown";
}
