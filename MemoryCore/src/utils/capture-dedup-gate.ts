/**
 * 同源重投捕获闸（P1 票④，extraction.captureDedupGate，默认 off）。
 *
 * 背景：场景摘要实证「第九次同源重投复验零新增」——重复内容反复进蒸馏管线，
 * 每轮消耗抽取额度并污染批次叙事（多重集 4,074 vs 唯一 1,546）。dedup 在
 * L1 判定层才拦=太晚。本闸在 L0 捕获入口做指纹预检：命中已捕获内容 → 短路免
 * 蒸馏；未命中 → 原路径放行。
 *
 * v2（2026-10-31 复核修复轮，复核结论 PASS-with-fixes P1-1/P2 + 范围裁决）：
 * - **分容器（P1-1 窗口饥饿修复）**：在案种子（archive）、持久 L0 近窗（persist）、
 *   本进程连发记账（pending）三分容器独立封顶——修复「每批全量再种子把 pending
 *   占位挤出 200 窗口」（在役 L1=2,336≫200 时连发收敛退化为一律放行）。
 * - **水位增量种子（P2）**：闸实例重建后首拍全量一次，此后 L1 按 updated_time
 *   水位增量拉取（可选能力 getL1TextsSince）、L0 近窗按 timestamp 水位增量
 *   （可选能力 getRecentL0Texts）；能力缺席回退全量（行为同旧）。
 * - **持久 L0 近窗（范围裁决后的核心增益）**：在案 sqlite 已存 L0 消息文本 +
 *   timestamp（idx_l0_timestamp）但无指纹列——不新增 schema，闸按同一归一化口径
 *   对近窗消息现算指纹（TTL 7 天、容量封顶），跨重启接住 L0 内部冗余重投
 *   （实测消息级内部冗余 28.9%）。命中条目带真实 L0 记录 id。
 * - **消息级语义（设计说明）**：v1 为整批 all-or-nothing（全部命中才短路、任一
 *   未命中整批放行）。v2 引入持久近窗后改为**消息级排除**：命中的消息在装配点
 *   跳过向量写入（其内容已在案/已在 L0——L0 原始日志与检查点游标不变，信息零
 *   丢失），未命中消息照常走原路径；全部可指纹化消息命中 = 整批短路（v1 行为
 *   成为 v2 的特例，返回形状兼容）。安全论证与 v1 相同：精确指纹命中即「同一
 *   归一化内容此前已被捕获」，排除不产生信息损失；未命中一律放行（零误杀）。
 *   整批短路时命中来源为在案（archive）才推 L1 热度（heatId）；pending/持久
 *   命中不推（非 L1 id，touchL1Heat 无意义）。
 *
 * 纪律（A/B/C/D 方案教训）：
 * - off 必须逐字节兼容：开关关闭时装配点零额外 I/O、返回对象与基线同形同序。
 * - 拒绝/短路语义结构化：返回 {shortcircuited, matchedId?, excluded?}，不靠日志文本。
 * - 观测锚点可面板化：整批短路打 `metric=capture_dedup_shortcircuit`、消息级排除
 *   打 `metric=capture_dedup_excluded`（与 pipeline_l1_trigger 同通道）。
 * - 语义近邻门（票面第二门）需新依赖/LLM 调用，本轮不做——hash 门先行，
 *   语义门待票④b。
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

/** pending 环容量（同进程连发记账；v1 的「窗口」语义只保留在这一个容器）。 */
export const CAPTURE_DEDUP_WINDOW = 200;

/** archive（在案 L1 种子）容器封顶：在役 2,336 条且增长，8192 留足余量。 */
export const CAPTURE_DEDUP_ARCHIVE_CAP = 8192;

/** persist（持久 L0 近窗）容器封顶：在役近 7 天 ≈1.3K 条，4096 留余量。 */
export const CAPTURE_DEDUP_PERSIST_CAP = 4096;

/** 持久近窗 TTL：7 天（超龄条目不参与判定，过期=放行）。 */
export const CAPTURE_DEDUP_PERSIST_TTL_MS = 7 * 86400_000;

/** pending 占位 TTL：24h（蒸馏失败的内容隔日可重投，占位不常驻）。 */
export const CAPTURE_DEDUP_PENDING_TTL_MS = 24 * 3600_000;

/** L1 增量种子单次上限：截断时下一批从新水位续拉（游标分页语义，无遗漏）。 */
export const CAPTURE_DEDUP_L1_SEED_LIMIT = 2000;

/** 短路命中：matchedId=首个命中条目 id（在案真实 id / 持久 L0 记录 id / 「pending:」占位）。 */
export interface CaptureGateShortCircuit {
  shortcircuited: true;
  matchedId: string;
  fingerprint: string;
  /**
   * 命中来源为在案记忆（archive）时的真实 L1 id——仅此情形装配点推热度
   * （touchL1Heat）；pending/持久近窗命中无此键（非 L1 id，不推）。
   */
  heatId?: string;
}

/** 未命中/不适用：原路径放行。excluded 非空 = 消息级排除（v2 持久门语义）。 */
export interface CaptureGatePass {
  shortcircuited: false;
  /**
   * 消息级闸：命中（在案/持久近窗/pending）消息在输入序列中的位置——其内容
   * 已在案/已在 L0（信息零丢失），装配点按此跳过向量写入。无命中时缺省
   * （返回形状与基线一致）。
   */
  excluded?: number[];
}

export type CaptureGateDecision = CaptureGateShortCircuit | CaptureGatePass;

/** 三分容器计数（测试/观测用）。 */
export interface CaptureGateStats {
  archive: number;
  persist: number;
  pending: number;
}

/** 命中条目：id 供 matchedId；heatId 仅在案命中携带。 */
interface GateHit {
  id: string;
  heatId?: string;
}

/** store 读取面可能同步也可能异步（与 core/store/types 的 MaybePromise 同构，此处零依赖解耦）。 */
type MaybePromise<T> = T | Promise<T>;

/**
 * 捕获闸判定器（v2，分容器，装配点持有）。
 *
 * - archive：在案 L1 近期记忆（seedFromArchive，真实 id，可推热度）。
 * - persist：持久 L0 近窗（seedPersist / seedFromStore，真实 L0 记录 id，带时间
 *   戳，TTL+封顶）——跨进程重启仍生效。
 * - pending：本进程连发记账（evaluate 放行时以时间戳记入）——同内容并发/连发
 *   第二次提交立即命中；蒸馏落库后 archive/persist 种子以真实 id 退场占位。
 * - 判定（v2 消息级）：逐消息查三分容器——命中 → excluded（装配点跳过其向量
 *   写入）；全部可指纹化消息命中 → 整批短路（v1 行为为特例）；任一未命中 →
 *   放行且未命中项以 pending 记账（新内容零误杀）。
 * - lookup 与记账之间无 await（同步临界区）：并发同文提交恰好一个放行。
 * - 三容器独立封顶：种子永不淘汰 pending（P1-1 窗口饥饿修复的根）。
 */
export class CaptureDedupGate {
  private readonly archive = new Map<string, string>();
  private readonly persist = new Map<string, { id: string; ts: number }>();
  private readonly pending = new Map<string, number>();
  private readonly windowSize: number;
  private readonly archiveCap: number;
  private readonly persistCap: number;
  private readonly persistTtlMs: number;
  private readonly pendingTtlMs: number;
  /** L1 增量水位（updated_time，ISO 字典序=时间序）；null=未知（未初始化或无增量能力）。 */
  private l1Watermark: string | null = null;
  /** L0 近窗增量水位（timestamp ms）；null=未初始化或无持久能力。 */
  private l0Watermark: number | null = null;
  /** 闸实例重建后首拍全量一次（P2：闸实例重建时全量）。 */
  private initialized = false;

  constructor(windowSize: number = CAPTURE_DEDUP_WINDOW) {
    this.windowSize = windowSize > 0 ? Math.floor(windowSize) : CAPTURE_DEDUP_WINDOW;
    this.archiveCap = CAPTURE_DEDUP_ARCHIVE_CAP;
    this.persistCap = CAPTURE_DEDUP_PERSIST_CAP;
    this.persistTtlMs = CAPTURE_DEDUP_PERSIST_TTL_MS;
    this.pendingTtlMs = CAPTURE_DEDUP_PENDING_TTL_MS;
  }

  /** 注入在案记忆（真实 record_id；同指纹的 pending 占位退场）。 */
  seedFromArchive(entries: Iterable<{ id: string; content: unknown }>): void {
    for (const e of entries) {
      const fp = captureContentFingerprint(e?.content);
      if (!fp || !e?.id) continue;
      this.archive.delete(fp);
      this.archive.set(fp, e.id);
      this.pending.delete(fp);
      while (this.archive.size > this.archiveCap) {
        const oldest = this.archive.keys().next().value;
        if (oldest === undefined) break;
        this.archive.delete(oldest);
      }
    }
  }

  /** 注入持久 L0 近窗条目（真实 L0 记录 id + 时间戳；升序插入使封顶淘汰最旧）。 */
  seedPersist(entries: Iterable<{ id: string; content: unknown; ts: number }>): void {
    const rows: Array<{ fp: string; id: string; ts: number }> = [];
    for (const e of entries) {
      const fp = captureContentFingerprint(e?.content);
      const ts = Number(e?.ts);
      if (!fp || !e?.id || !Number.isFinite(ts)) continue;
      rows.push({ fp, id: e.id, ts });
    }
    rows.sort((a, b) => a.ts - b.ts);
    for (const r of rows) {
      this.persist.delete(r.fp);
      this.persist.set(r.fp, { id: r.id, ts: r.ts });
      this.pending.delete(r.fp);
      while (this.persist.size > this.persistCap) {
        const oldest = this.persist.keys().next().value;
        if (oldest === undefined) break;
        this.persist.delete(oldest);
      }
    }
  }

  /**
   * 从 store 种子（装配点每批调用）：闸实例重建后首拍全量一次（L1 全量 + L0 近窗
   * 一次），此后有增量能力只拉水位之后（P2 增量化）；能力缺席回退全量（行为同旧，
   * pending 独立容器不被挤）。
   *
   * 降级契约：本方法拒绝（如 getAllL1Texts/getRecentL0Texts 抛错）→ 装配点整体
   * 降级放行（fail-safe：放行零误杀，非致命），与 v1 的在案读取失败同向。
   */
  async seedFromStore(store: object, opts: { now?: number } = {}): Promise<void> {
    const now = opts.now ?? Date.now();
    const s = store as {
      getAllL1Texts?: () => MaybePromise<Array<{ record_id: string; content: string; updated_time: string }>>;
      getL1TextsSince?: (
        since: string,
        limit: number,
      ) => MaybePromise<Array<{ record_id: string; content: string; updated_time: string }>>;
      getRecentL0Texts?: (
        afterTs: number,
        limit: number,
      ) => MaybePromise<Array<{ record_id: string; message_text: string; timestamp: number }>>;
    };

    // ── L1 腿 ──
    if (!this.initialized) {
      const rows = (await s.getAllL1Texts?.()) ?? [];
      this.seedFromArchive(rows.map((r) => ({ id: r.record_id, content: r.content })));
      if (typeof s.getL1TextsSince === "function") {
        // 水位=全量最大 updated_time；空库给 ""（后续增量自然覆盖全部新行）
        let mx = "";
        for (const r of rows) if ((r.updated_time ?? "") > mx) mx = r.updated_time ?? "";
        this.l1Watermark = mx;
      }
    } else if (typeof s.getL1TextsSince === "function" && this.l1Watermark !== null) {
      const rows = await s.getL1TextsSince(this.l1Watermark, CAPTURE_DEDUP_L1_SEED_LIMIT);
      this.seedFromArchive(rows.map((r) => ({ id: r.record_id, content: r.content })));
      for (const r of rows) {
        const ut = r.updated_time ?? "";
        if (ut > this.l1Watermark) this.l1Watermark = ut;
      }
    } else if (typeof s.getAllL1Texts === "function") {
      // 无增量能力：回退每批全量（v1 行为）；pending 独立容器，不再被种子挤掉
      const rows = (await s.getAllL1Texts()) ?? [];
      this.seedFromArchive(rows.map((r) => ({ id: r.record_id, content: r.content })));
    }

    // ── L0 持久近窗腿（可选能力；缺席=持久层静默缺席，pending/archive 仍有效）──
    if (typeof s.getRecentL0Texts === "function") {
      if (!this.initialized) {
        const bound = now - this.persistTtlMs;
        const rows = (await s.getRecentL0Texts(bound, this.persistCap)) ?? [];
        this.seedPersist(rows.map((r) => ({ id: r.record_id, content: r.message_text, ts: Number(r.timestamp) })));
        let mx = bound;
        for (const r of rows) if (Number(r.timestamp) > mx) mx = Number(r.timestamp);
        this.l0Watermark = mx;
      } else if (this.l0Watermark !== null) {
        const rows = (await s.getRecentL0Texts(this.l0Watermark, this.persistCap)) ?? [];
        this.seedPersist(rows.map((r) => ({ id: r.record_id, content: r.message_text, ts: Number(r.timestamp) })));
        for (const r of rows) {
          const ts = Number(r.timestamp);
          if (ts > this.l0Watermark) this.l0Watermark = ts;
        }
      }
    }

    this.initialized = true;
  }

  /**
   * 判定本批消息（v2 消息级）。同步临界区（无 await）：
   * - 全部可指纹化消息命中 → 整批短路 {shortcircuited:true, matchedId, heatId?}；
   * - 部分命中 → 放行 + excluded 位置表（装配点跳过命中项的向量写入），
   *   未命中项以 pending 记账（防同文连发/并发二过闸）；
   * - 无命中 / 全部不可指纹化 → 放行（返回形状与基线一致）。
   */
  evaluate(messages: Iterable<{ content: unknown }>, opts: { now?: number } = {}): CaptureGateDecision {
    const now = opts.now ?? Date.now();
    const fps: Array<{ fp: string; idx: number }> = [];
    let idx = 0;
    for (const m of messages) {
      const fp = captureContentFingerprint(m?.content);
      if (fp) fps.push({ fp, idx });
      idx++;
    }
    if (fps.length === 0) return { shortcircuited: false };

    let matchedId: string | null = null;
    let heatId: string | undefined;
    const excluded: number[] = [];
    let unmatched = 0;
    for (const { fp, idx: pos } of fps) {
      const hit = this.lookup(fp, now);
      if (hit === null) {
        unmatched++;
        continue;
      }
      excluded.push(pos);
      if (matchedId === null) {
        matchedId = hit.id;
        heatId = hit.heatId;
      }
    }

    if (unmatched === 0) {
      return heatId !== undefined
        ? { shortcircuited: true, matchedId: matchedId as string, fingerprint: fps[0].fp, heatId }
        : { shortcircuited: true, matchedId: matchedId as string, fingerprint: fps[0].fp };
    }
    for (const { fp } of fps) {
      if (this.lookup(fp, now) === null) this.rememberPending(fp, now);
    }
    return excluded.length > 0 ? { shortcircuited: false, excluded } : { shortcircuited: false };
  }

  /** pending 环条目数（测试/观测用，v1 兼容语义）。 */
  size(): number {
    return this.pending.size;
  }

  /** 三分容器计数（测试/观测用）。 */
  stats(): CaptureGateStats {
    return { archive: this.archive.size, persist: this.persist.size, pending: this.pending.size };
  }

  /**
   * 三容器查案（优先级 archive > persist > pending）：报真实 id 优先于占位。
   * 过期条目查案时惰性清除（TTL 内才参与判定，过期=放行）。
   */
  private lookup(fp: string, now: number): GateHit | null {
    const a = this.archive.get(fp);
    if (a !== undefined) return { id: a, heatId: a };
    const p = this.persist.get(fp);
    if (p !== undefined) {
      if (now - p.ts > this.persistTtlMs) {
        this.persist.delete(fp);
      } else {
        return { id: p.id };
      }
    }
    const pt = this.pending.get(fp);
    if (pt !== undefined) {
      if (now - pt > this.pendingTtlMs) {
        this.pending.delete(fp);
      } else {
        return { id: `pending:${fp.slice(0, 12)}` };
      }
    }
    return null;
  }

  /** pending 记账（带时间戳；独立环封顶，种子永不触碰本容器——P1-1 修复根）。 */
  private rememberPending(fp: string, now: number): void {
    this.pending.delete(fp); // Map 有序：delete+set = 刷到最新
    this.pending.set(fp, now);
    while (this.pending.size > this.windowSize) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
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
