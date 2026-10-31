/**
 * 同源重投捕获闸（P1 票④，extraction.captureDedupGate，默认 off）。
 *
 * 背景：场景摘要实证「第九次同源重投复验零新增」——重复内容反复进蒸馏管线，
 * 每轮消耗抽取额度并污染批次叙事（多重集 4,074 vs 唯一 1,546）。dedup 在
 * L1 判定层才拦=太晚。本闸在 L0 捕获入口做指纹预检：命中在案记忆 → 短路免蒸馏、
 * 只推热度时间戳；未命中 → 原路径放行。
 *
 * 纪律（A/B/C/D 方案教训）：
 * - off 必须逐字节兼容：开关关闭时装配点零额外 I/O、返回对象与基线同形同序。
 * - 拒绝/短路语义结构化：返回 {shortcircuited:true, matchedId}，不靠日志文本。
 * - 观测锚点可面板化：短路时打 `metric=capture_dedup_shortcircuit` 行 +
 *   report("capture_dedup_shortcircuit", …)（与 pipeline_l1_trigger 同通道）。
 * - 语义近邻门（票面第二门）需新依赖/LLM 调用，本轮不做——hash 门先行，
 *   语义门待后续票。
 *
 * 归一化口径：在役 normalizeForFingerprint（去空白+中英标点，与
 * scripts/l1_pairs.py 对账）基础上**先**折叠全角 ASCII（FF01–FF5E→0021–007E、
 * U+3000→空格），保证「ＡＢＣ１２３」与「ABC123」同指纹。指纹=sha1(归一化文本)，
 * 归一化为空（空串/纯空白/纯标点）→ null（不参与判定，畸形输入不误杀）。
 */
import { normalizeForFingerprint, fingerprintOfNormalized } from "./fingerprint.js";

/** 全角 ASCII 折叠：U+FF01–U+FF5E → U+0021–U+007E；U+3000（全角空格）→ 空格。 */
export function foldFullWidth(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x3000) {
      out += " ";
    } else if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCharCode(code - 0xfee0);
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * 捕获闸归一化：全角折叠 → 去空白与中英标点（复用在役口径）。
 * 非 string 入参经 String() 宽容转换（畸形输入不抛）。
 */
export function normalizeCaptureText(content: unknown): string {
  if (content == null) return "";
  return normalizeForFingerprint(foldFullWidth(String(content)));
}

/**
 * 捕获闸内容指纹：sha1(归一化文本) hex。
 * 归一化为空（空串/null/纯空白/纯标点）→ null：不参与判定（畸形输入不误杀）。
 */
export function captureContentFingerprint(content: unknown): string | null {
  return fingerprintOfNormalized(normalizeCaptureText(content));
}

/** 近期指纹窗口大小：防同会话快速重投 + 防 Map 无界增长。 */
export const CAPTURE_DEDUP_WINDOW = 200;

/** 短路命中：matchedId=在案记忆 id；自批次占位=「pending:」前缀（在案种子里真实 id 会覆盖它）。 */
export interface CaptureGateShortCircuit {
  shortcircuited: true;
  matchedId: string;
  fingerprint: string;
}

/** 未命中/不适用：原路径放行。 */
export interface CaptureGatePass {
  shortcircuited: false;
}

export type CaptureGateDecision = CaptureGateShortCircuit | CaptureGatePass;

/**
 * 捕获闸判定器（纯内存，装配点持有）。
 *
 * - 种子：在案 L1 近期记忆（装配点从 store 拉取后 seedFromArchive，真实 id）。
 * - 自批次记忆：evaluate 放行时把本批指纹以「pending:」占位记入——同内容
 *   并发/连发第二次提交立即命中（此时蒸馏尚未落 L1），第一次蒸馏落库后
 *   seedFromArchive 用真实 record_id 覆盖占位。
 * - 判定规则：本批**可指纹化**消息（fp≠null）非空且全部命中 → 短路；
 *   任一未命中 / 全部不可指纹化（畸形/空/纯标点）→ 放行（新内容零误杀）。
 * - lookup 与 remember 之间无 await（同步临界区）：并发同文提交恰好一个放行。
 */
export class CaptureDedupGate {
  private readonly ring = new Map<string, string>();
  private readonly windowSize: number;

  constructor(windowSize: number = CAPTURE_DEDUP_WINDOW) {
    this.windowSize = windowSize > 0 ? Math.floor(windowSize) : CAPTURE_DEDUP_WINDOW;
  }

  /** 注入在案记忆（真实 record_id 覆盖同指纹的 pending 占位）。 */
  seedFromArchive(entries: Iterable<{ id: string; content: unknown }>): void {
    for (const e of entries) {
      const fp = captureContentFingerprint(e?.content);
      if (!fp || !e?.id) continue;
      this.remember(fp, e.id, true);
    }
  }

  /**
   * 判定本批消息。同步临界区（无 await）：命中返回 {shortcircuited:true, matchedId}，
   * 否则放行并把本批指纹以 pending 占位记入。
   */
  evaluate(messages: Iterable<{ content: unknown }>): CaptureGateDecision {
    const fps: Array<{ fp: string }> = [];
    for (const m of messages) {
      const fp = captureContentFingerprint(m?.content);
      if (fp) fps.push({ fp });
    }
    if (fps.length === 0) return { shortcircuited: false };

    // 先全部查案：任一未命中 → 放行（新内容零误杀）且记账本批指纹
    // （防同文连发/并发二过闸；占位不覆盖真实 id）。全命中 → 短路。
    let matchedId: string | null = null;
    let allHit = true;
    for (const { fp } of fps) {
      const id = this.ring.get(fp);
      if (id === undefined) {
        allHit = false;
        break;
      }
      if (matchedId === null) matchedId = id;
    }

    if (!allHit) {
      for (const { fp } of fps) {
        this.remember(fp, `pending:${fp.slice(0, 12)}`, false);
      }
      return { shortcircuited: false };
    }
    return { shortcircuited: true, matchedId: matchedId as string, fingerprint: fps[0].fp };
  }

  /** 当前窗口条目数（测试/观测用）。 */
  size(): number {
    return this.ring.size;
  }

  private remember(fp: string, id: string, authoritative: boolean): void {
    if (!authoritative && this.ring.has(fp)) return; // 占位不覆盖
    this.ring.delete(fp); // Map 有序：delete+set = 刷到最新（LRU 语义）
    this.ring.set(fp, id);
    while (this.ring.size > this.windowSize) {
      const oldest = this.ring.keys().next().value;
      if (oldest === undefined) break;
      this.ring.delete(oldest);
    }
  }
}

/**
 * 装配点侧的按 store 实例缓存：同一 store 进程内共享一个闸实例，
 * 使跨次捕获的 pending 占位持续生效（并发/连发收敛）。store 换实例即新闸。
 */
const gateByStore = new WeakMap<object, CaptureDedupGate>();

export function captureGateForStore(store: object, windowSize?: number): CaptureDedupGate {
  let gate = gateByStore.get(store);
  if (!gate) {
    gate = new CaptureDedupGate(windowSize);
    gateByStore.set(store, gate);
  }
  return gate;
}
