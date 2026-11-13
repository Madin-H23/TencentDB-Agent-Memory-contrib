/**
 * SceneExtractor: LLM-driven memory extraction into scene blocks.
 *
 * Replaces the keyword-based SceneManager.processNewMemories() with an
 * LLM agent that autonomously reads/writes scene block files using tools.
 *
 * Security: The LLM is sandboxed — workspaceDir is set to scene_blocks/
 * so it can ONLY operate on .md scene files. System files (checkpoint,
 * scene_index, persona.md) are physically invisible to the LLM.
 *
 * Flow:
 *   1. Backup + load scene index + build summaries
 *   2. Assemble extraction prompt with memories + scene context
 *   3. Run via CleanContextRunner (tools enabled, sandboxed to scene_blocks/)
 *   4. Cleanup: remove soft-deletes, sync index, update navigation
 *   5. Parse LLM text output for out-of-band persona update signals
 */

import { CleanContextRunner } from "../../utils/clean-context-runner.js";
import { CheckpointManager } from "../../utils/checkpoint.js";
import { BackupManager } from "../../utils/backup.js";
import { readSceneIndex, syncSceneIndex } from "../scene/scene-index.js";
import type { SceneIndexEntry } from "../scene/scene-index.js";
import { parseSceneBlock } from "../scene/scene-format.js";
import { compactSceneBlock } from "../scene/scene-compact.js";
import type { SceneCompactionConfig } from "../scene/scene-compact.js";
import { deterministicSupersede, type FactSupersedeConfig } from "./scene-supersede.js";
import { filterSupersededByApproval, parseJudgeApprovalState } from "./fact-ops.js";
import { planSceneSpill, type SceneArchiveConfig } from "./scene-archive.js";
import { checkAnchorPreservation, countSupersededChars } from "../../utils/supersede.js";
import { generateSceneNavigation, stripSceneNavigation } from "../scene/scene-navigation.js";
import type { ResolvedRecallRanking } from "../scene/recall-ranking.js";
import { normalizeSceneFilenames } from "./filename-normalizer.js";
import { isNoopSceneDiff } from "./noop-detect.js";
import { writeSceneSnapshot } from "./scene-snapshot.js";
import type { MemoryPromptMode } from "../../config.js";
import { buildSceneExtractionPrompt, buildSceneIndexSection } from "../prompts/scene-extraction.js";
import { report } from "../report/reporter.js";
import { reportL2LatencyMetrics } from "../report/metric-tracking-l2-latency.js";
import type { LLMRunner, Logger, TraceContext } from "../types.js";
import { buildTraceParams } from "../types.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { StoragePaths } from "../storage/types.js";
import type { ResolvedMemoryPrompt } from "../memory-prompt/types.js";
import { composeMemorySystemPrompt } from "../memory-prompt/composer.js";
import { createHash } from "node:crypto";

const TAG = "[memory-tdai] [extractor]";

type ExtractorLogger = Logger;

export interface ExtractionResult {
  memoriesProcessed: number;
  success: boolean;
  error?: string;
  /** True if LLM ran but produced no file changes (scene_index unchanged). */
  emptyExtraction?: boolean;
  /** Persisted final scene-file delta, captured after index synchronization. */
  sceneDiff?: PersistedSceneDiff;
}

export interface SceneFileSnapshot {
  filename: string;
  sha256: string;
  chars: number;
  parseable: boolean;
  created: string;
  updated: string;
  summary: string;
  heat: number;
  /** Present in memory only; diagnostic serialization decides whether it may be logged. */
  content: string;
  raw: string;
}

export interface PersistedSceneDiff {
  beforeFiles: string[];
  afterFiles: string[];
  created: SceneFileSnapshot[];
  updated: Array<{ before: SceneFileSnapshot; after: SceneFileSnapshot }>;
  deleted: SceneFileSnapshot[];
}

export interface SceneExtractorOptions {
  dataDir: string;
  config: unknown;
  model?: string;
  maxScenes?: number;
  /** Prompt family for L2 scene extraction (default: chat). */
  promptMode?: MemoryPromptMode;
  /**
   * 方案D（exp/l2-plan-d-summary-index）：在 L2 提示词追加场景索引段
   * （每场景一行 path | heat | summary，数据来自内存中的 scene_index，零新增 I/O）。
   * 默认 false=off，提示词与基线逐字节一致；yaml `persona.sceneIndexInPrompt` 控制。
   */
  sceneIndexInPrompt?: boolean;
  /** Resolved custom strategy. Undefined preserves the current system prompt exactly. */
  memoryPrompt?: ResolvedMemoryPrompt;
  sceneBackupCount?: number;
  timeoutMs?: number;
  logger?: ExtractorLogger;
  /** Plugin instance ID for metric reporting (optional) */
  instanceId?: string;
  /**
   * Host-neutral LLM runner. When provided, used instead of creating
   * a CleanContextRunner (decouples from OpenClaw runtime).
   * Must be configured with `enableTools: true`.
   */
  llmRunner?: LLMRunner;
  /** StorageAdapter for file operations (COS/local). Falls back to fs when absent. */
  storage?: StorageAdapter;
  /**
   * 方案C（exp/l2-plan-c-write-cap）：L2 场景块写入后像尺寸帽（字符数，≤0/undefined=off）。
   * 经 LLMRunParams.sceneCharCap 传给 runner 的 write/edit 工具工厂；缺省 off。
   */
  sceneCharCap?: number;
  /**
   * [P1 票⑥ 显式失效替代硬删]：L2 MERGE/折叠语义改 recency-wins——提示词 MERGE
   * 指令改「标记失效而非删除」，write/edit/read 工具启用锚点守卫/失效过滤/
   * 失效帽排除口径（经 LLMRunParams.explicitInvalidation 透传）。缺省 off=
   * 提示词与工具行为和基线逐字节一致。yaml `persona.explicitInvalidation` 控制。
   */
  explicitInvalidation?: boolean;
  /**
   * [P1 票⑤ 场景格式 v2 双层化]：场景文件三层结构（要点/事实/活动）——提示词追加
   * v2 规则块，read 默认两层（活动区折叠，includeArchive 审计），write/edit 落盘前
   * 要点段→META.summary 同步（经 LLMRunParams.sceneFormatV2 透传）。缺省 off=
   * 提示词与工具行为和基线逐字节一致。yaml `persona.sceneFormatV2` 控制。
   */
  sceneFormatV2?: boolean;
  /**
   * [候选-C·TICKETS-C-read-dedup-20261113] run 内 read 结果去重（persona.l2ReadDedup，
   * 经 LLMRunParams.l2ReadDedup 透传到 storage-tools）。缺省 off=行为逐字节不变。
   */
  l2ReadDedup?: import("../../utils/read-dedup.js").L2ReadDedupConfig;
  /**
   * [P1 票⑦ 召回多信号排序]：updateSceneNavigation 的导航排序口径（已解析配置，
   * undefined=off=基线热度降序逐字节不变）。yaml `persona.recallRanking` 控制，
   * 经 pipeline-factory 传入。
   */
  recallRanking?: ResolvedRecallRanking;
  /**
   * [P1 票⑧ 场景帽压力治理] Phase 5 确定性压实（缺省 undefined=off）：
   * 文件 > sceneCharCap×triggerRatio 时把 `## 活动` 段旧批次叙事折叠为一行标记
   * （锚点/事实/要点不动），写回于 syncSceneIndex 之前。yaml `persona.sceneCompaction`
   * 控制，经 pipeline-factory 传入；off 时该分支零 I/O。
   */
  sceneCompaction?: SceneCompactionConfig;
  /**
   * [P1-6b 同源替代生成] Phase 5 确定性同锚替代折叠（缺省 undefined=off）：
   * 同锚多重集 >1 且旧行与最新行脱敏相似度 ≥ minSimilarity 时，旧行加
   * `[SUPERSEDED <ISO>]` 前缀（只标不删）。mode=shadow 只打
   * `metric=l2_fact_supersede` 不落盘；mode=on 写回且锚点多重集零变化
   * （checkAnchorPreservation 防御性兜底）。yaml `persona.factSupersede` 控制。
   */
  factSupersede?: FactSupersedeConfig;
  /**
   * [P2-A3 C 案] 场景文件归档层（缺省 undefined=off）：活动段内旧批次段 spill 到
   * `<scene>-archive.md`（rolling ageDays·锚点全局守恒·默认读视图逐字节不变）。
   * yaml `persona.sceneArchive` 控制；off 时 Phase 5 该分支零调用零 I/O。
   */
  sceneArchive?: SceneArchiveConfig;
  /** langfuse 上报身份四元组（team/user/agent/session）。传下来会填充 trace 顶级字段。 */
  traceContext?: TraceContext;
}

/**
 * Parse LLM text output for a persona update request signal.
 *
 * Supports multiple formats for robustness:
 * - Block: [PERSONA_UPDATE_REQUEST]reason: xxx[/PERSONA_UPDATE_REQUEST]
 * - Inline: PERSONA_UPDATE_REQUEST: xxx
 */
export function parsePersonaUpdateSignal(text: string): { reason: string } | null {
  // Block format: [PERSONA_UPDATE_REQUEST]...[/PERSONA_UPDATE_REQUEST]
  const blockMatch = text.match(
    /\[PERSONA_UPDATE_REQUEST\]\s*(?:reason:\s*)?(.+?)\s*\[\/PERSONA_UPDATE_REQUEST\]/s,
  );
  if (blockMatch) return { reason: blockMatch[1]!.trim() };

  // Inline format: PERSONA_UPDATE_REQUEST: reason text
  const inlineMatch = text.match(
    /PERSONA_UPDATE_REQUEST:\s*(.+?)(?:\n|$)/,
  );
  if (inlineMatch) return { reason: inlineMatch[1]!.trim() };

  return null;
}

/** [P2-A3] 归档文件 META 构造（archive:true 标记·只读语义）。 */
function buildArchiveFile(content: string): string {
  const now = new Date().toISOString();
  return [
    "-----META-START-----",
    `created: ${now}`,
    `updated: ${now}`,
    "summary: 【归档文件·只读】旧批次段归档（scene-archive 机制·锚点全局守恒·LLM 请勿向本文件写入新内容）",
    "heat: 0",
    "archive: true",
    "-----META-END-----",
    "",
    "## 活动（归档批次段）",
    "",
    content,
  ].join("\n");
}

/** [P2-A3] 归档文件追加（updated 推进·summary 保只读标记·尾部空行归一）。 */
function mergeArchiveFile(existing: string, appendText: string): string {
  const now = new Date().toISOString();
  const withUpdated = existing.replace(/^(updated: ).*$/m, `$1${now}`);
  const body = withUpdated.replace(/\n{3,}$/, "\n");
  return `${body}\n${appendText.replace(/\n{3,}/g, "\n\n")}`;
}

/** [P2-A3 审核 P1-3] 归档文件识别（META archive:true·防 ⑧/⑥b 误处理）。 */
function isArchiveFile(raw: string): boolean {
  const m = raw.match(/-----META-START-----([\s\S]*?)-----META-END-----/);
  if (!m) return false;
  return /^archive:[ \t]*true[ \t]*$/m.test(m[1] ?? "");
}

export class SceneExtractor {
  private dataDir: string;
  private runner: LLMRunner;
  private maxScenes: number;
  private sceneBackupCount: number;
  private promptMode: MemoryPromptMode;
  private sceneIndexInPrompt: boolean;
  private memoryPrompt: ResolvedMemoryPrompt | undefined;
  private timeoutMs: number;
  private logger: ExtractorLogger | undefined;
  private instanceId: string | undefined;
  private storage: StorageAdapter | undefined;
  private sceneCharCap: number | undefined;
  private explicitInvalidation: boolean;
  private sceneFormatV2: boolean;
  private l2ReadDedup: import("../../utils/read-dedup.js").L2ReadDedupConfig | undefined;
  private recallRanking: ResolvedRecallRanking | undefined;
  private sceneCompaction: SceneCompactionConfig | undefined;
  private factSupersede: FactSupersedeConfig | undefined;
  private sceneArchive: SceneArchiveConfig | undefined;
  private traceContext: TraceContext | undefined;

  constructor(opts: SceneExtractorOptions) {
    this.dataDir = opts.dataDir;
    this.maxScenes = opts.maxScenes ?? 15;
    this.promptMode = opts.promptMode ?? "chat";
    this.sceneIndexInPrompt = opts.sceneIndexInPrompt ?? false;
    this.memoryPrompt = opts.memoryPrompt;
    this.sceneBackupCount = opts.sceneBackupCount ?? 10;
    this.timeoutMs = opts.timeoutMs ?? 300_000; // 5 min — LLM may do multiple tool calls
    this.logger = opts.logger;
    this.instanceId = opts.instanceId;
    this.storage = opts.storage;
    this.sceneCharCap = opts.sceneCharCap;
    this.explicitInvalidation = opts.explicitInvalidation ?? false;
    this.sceneFormatV2 = opts.sceneFormatV2 ?? false;
    this.l2ReadDedup = opts.l2ReadDedup;
    this.recallRanking = opts.recallRanking;
    this.sceneCompaction = opts.sceneCompaction;
    this.factSupersede = opts.factSupersede;
    this.sceneArchive = opts.sceneArchive;
    this.traceContext = opts.traceContext;

    // Use injected LLMRunner if available, otherwise fall back to CleanContextRunner
    this.runner = opts.llmRunner ?? new CleanContextRunner({
      config: opts.config,
      modelRef: opts.model,
      enableTools: true,
      logger: opts.logger,
    });

    this.logger?.debug?.(`${TAG} Created: dataDir=${opts.dataDir}, model=${opts.model ?? "(default)"}, promptMode=${this.promptMode}, maxScenes=${this.maxScenes}, timeout=${this.timeoutMs}ms`);
  }

  /**
   * Extract a batch of memories into scene blocks using the LLM agent.
   *
   * @param memories - Array of raw memory records from the API
   * @returns Extraction result with count and success flag
   */
  async extract(memories: Array<{ content: string; created_at: string; id?: string }>): Promise<ExtractionResult> {
    const extractStartMs = Date.now();
    this.logger?.info(`${TAG} extract() start: ${memories.length} memories`);

    if (memories.length === 0) {
      this.logger?.debug?.(`${TAG} extract() skipped: no memories`);
      return { memoriesProcessed: 0, success: true };
    }

    const sceneBlocksDir = this.storage ? StoragePaths.sceneBlocksDir : await (async () => { const path = await import("node:path"); return path.default.join(this.dataDir, "scene_blocks"); })();
    const metadataDir = this.storage ? StoragePaths.metadataDir : await (async () => { const path = await import("node:path"); return path.default.join(this.dataDir, ".metadata"); })();

    // Ensure directories exist
    if (this.storage) {
      await this.storage.mkdir(StoragePaths.sceneBlocksDir);
      await this.storage.mkdir(StoragePaths.metadataDir);
    } else {
      const fs = await import("node:fs/promises");
      await fs.default.mkdir(sceneBlocksDir, { recursive: true });
      await fs.default.mkdir(metadataDir, { recursive: true });
    }

    // Phase 1: Backup
    const backupStartMs = Date.now();
    const cpManager = new CheckpointManager(this.dataDir, this.logger, this.storage);
    const cp = await cpManager.read();
    // 2026-10-27：快照与回滚解耦。
    // 旧逻辑只在沙箱模式（!storage）建 BackupManager，而网关恒传 storage →
    // 在役从不做 L2 快照（实测 profiles 下无 .backup），写坏无可回滚单元。
    // 现在：只要本地 scene_blocks 目录存在就写快照（COS 等天然跳过）；
    // `bm` 仍只在沙箱模式下创建，因为下方 catch 分支的 restoreLatestDirectory
    // 会整目录 rm -rf，不能与并发 L2 run 共用（两轮审查 P0）。
    let bm: BackupManager | undefined;
    if (!this.storage) {
      const path = await import("node:path");
      bm = new BackupManager(path.default.join(this.dataDir, ".backup"));
    }
    await writeSceneSnapshot({
      dataDir: this.dataDir,
      keep: this.sceneBackupCount,
      tag: `offset${cp.total_processed}-${Date.now()}`,
      logger: this.logger,
    });
    this.logger?.debug?.(`${TAG} extract() backup phase: ${Date.now() - backupStartMs}ms`);

    // Phase 2: Load scene index
    const indexStartMs = Date.now();
    const index = await readSceneIndex(this.dataDir, this.storage);
    this.logger?.debug?.(`${TAG} extract() scene index loaded: ${index.length} entries (${Date.now() - indexStartMs}ms)`);

    // Build scene summaries for the prompt (relative filenames only)
    const { summaries: sceneSummaries, filenames: existingSceneFiles } =
      this.buildSceneSummaries(index);

    // 方案D：开关开启时用内存中的 scene_index 构建紧凑索引段（零新增 I/O）；
    // 空索引/开关关闭均不注入。
    const sceneIndexSection = this.sceneIndexInPrompt ? buildSceneIndexSection(index) : undefined;
    if (sceneIndexSection) {
      this.logger?.debug?.(`${TAG} extract() scene index section injected: ${sceneIndexSection.length} chars`);
    }

    // Build scene count warning (tiered system)
    let sceneCountWarning: string | undefined;
    const sceneCount = index.length;
    if (sceneCount >= this.maxScenes) {
      sceneCountWarning = `当前场景数量为 **${sceneCount} 个**，已达到或超过 ${this.maxScenes} 个上限！\n**你必须先执行 MERGE 操作**，将最相似的 2-4 个场景合并为 1 个，然后再处理新记忆。\n参考合并对象：热度最低或主题高度重叠的场景。`;
      this.logger?.warn(`${TAG} extract() scene count at limit: ${sceneCount}/${this.maxScenes}`);
    } else if (sceneCount === this.maxScenes - 1) {
      sceneCountWarning = `当前场景数量为 **${sceneCount} 个**，距离上限只差 1 个！\n本次处理**只能 UPDATE 现有场景，不能 CREATE 新场景**。`;
      this.logger?.warn(`${TAG} extract() scene count near limit (CREATE blocked): ${sceneCount}/${this.maxScenes}`);
    } else if (sceneCount >= this.maxScenes - 3) {
      sceneCountWarning = `当前场景数量为 **${sceneCount} 个**，建议优先考虑 UPDATE 或主动 MERGE 相似场景。`;
      this.logger?.debug?.(`${TAG} extract() scene count approaching limit: ${sceneCount}/${this.maxScenes}`);
    }

    // Snapshot scene index + content before LLM — used later to diff created/updated/deleted
    const preExtractIndex = new Map(index.map((e) => [e.filename, e.summary]));
    // Also snapshot scene content so we can detect content-only changes vs metadata-only changes
    const preExtractSnapshots = new Map<string, SceneFileSnapshot>();
    for (const e of index) {
      try {
        let raw: string | null;
        if (this.storage) {
          raw = await this.storage.readFile(`${StoragePaths.sceneBlocksDir}${e.filename}`);
        } else {
          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          raw = await fs.default.readFile(path.default.join(this.dataDir, "scene_blocks", e.filename), "utf-8");
        }
        if (!raw) continue;
        const block = parseSceneBlock(raw, e.filename);
        preExtractSnapshots.set(e.filename, snapshotSceneFile(e.filename, raw, block));
      } catch { /* non-fatal */ }
    }

    // Phase 3: Build prompt
    const promptStartMs = Date.now();
    const memoriesJson = JSON.stringify(
      memories.map((m) => ({
        content: m.content,
        created_at: m.created_at,
        id: m.id ?? "",
      })),
      null,
      2,
    );

    const currentTimestamp = formatTimestamp(new Date());

    const { systemPrompt: baseSystemPrompt, userPrompt } = buildSceneExtractionPrompt({
      memoriesJson,
      sceneSummaries: sceneSummaries || "(无已有场景)",
      currentTimestamp,
      sceneCountWarning,
      existingSceneFiles,
      maxScenes: this.maxScenes,
      promptMode: this.promptMode,
      sceneIndexSection,
      explicitInvalidation: this.explicitInvalidation,
      sceneFormatV2: this.sceneFormatV2,
      // 票⑨：v2 模板的字符帽文案引用实际值（off 路径不读取）。
      sceneCharCap: this.sceneCharCap,
    });
    const systemPrompt = composeMemorySystemPrompt(baseSystemPrompt, this.memoryPrompt);
    this.logger?.debug?.(`${TAG} extract() prompt built: ${userPrompt.length} chars (${Date.now() - promptStartMs}ms)`);

    // Phase 4: Run LLM agent (sandboxed to scene_blocks/)
    let llmOutput = "";
    let llmDurationMs = 0;
    try {
      this.logger?.debug?.(`${TAG} extract() starting LLM runner (timeout=${this.timeoutMs}ms, maxTokens=model default)...`);
      const runnerStartMs = Date.now();
      // langfuse trace 语义：L2 场景抽取有独立 name / 顶级 user/session 列 / 可筛选 tags。
      const traceParams = buildTraceParams("memory.scene-extract", this.traceContext);
      llmOutput = await this.runner.run({
        systemPrompt,
        prompt: userPrompt,
        taskId: `scene-extract-${Date.now()}`,
        timeoutMs: this.timeoutMs,
        // maxTokens omitted → core uses the resolved model's maxTokens from catalog
        workspaceDir: sceneBlocksDir,
        // Service mode: LLM tools read/write via StorageAdapter (COS) instead of local FS
        storage: this.storage,
        storagePrefix: this.storage ? StoragePaths.sceneBlocksDir : undefined,
        // 方案C：场景块写入后像尺寸帽（persona.sceneCharCap，0=off）—— 只在 L2 传入，
        // L3 persona 不传 → 不受限。
        sceneCharCap: this.sceneCharCap,
        // 票⑥：显式失效语义（persona.explicitInvalidation，默认 off）—— 只在 L2 传入。
        explicitInvalidation: this.explicitInvalidation,
        // 票⑤：场景格式 v2 双层化（persona.sceneFormatV2，默认 off）—— 只在 L2 传入。
        sceneFormatV2: this.sceneFormatV2,
        // [候选-C] run 内 read 去重（persona.l2ReadDedup，默认 off）—— 只在 L2 传入。
        l2ReadDedup: this.l2ReadDedup,
        ...traceParams,
      }) ?? "";
      llmDurationMs = Date.now() - runnerStartMs;
      this.logger?.debug?.(`${TAG} extract() LLM runner completed: ${llmDurationMs}ms`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const totalMs = Date.now() - extractStartMs;
      this.logger?.error(`${TAG} extract() LLM runner failed after ${totalMs}ms: ${errMsg}`);

      // Restore scene_blocks/ from the Phase 1 backup so partial LLM writes
      // (or a wiped sandbox) don't leak into the next recall cycle.
      // Fail-soft: a restore failure must never mask the original LLM error.
      // In service mode (`this.storage` set) we never took a local backup,
      // so `bm` is undefined and we skip restore — the storage backend
      // owns its own snapshot/restore semantics.
      if (bm) {
        try {
          const result = await bm.restoreLatestDirectory("scene_blocks", sceneBlocksDir);
          if (result.restored) {
            this.logger?.warn(`${TAG} extract() restored scene_blocks/ from backup: ${result.from}`);
          } else {
            this.logger?.debug?.(`${TAG} extract() no scene_blocks backup to restore from (first run or empty)`);
          }
        } catch (restoreErr) {
          const rMsg = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
          this.logger?.warn(`${TAG} extract() restore failed (non-fatal, original LLM error preserved): ${rMsg}`);
        }
      }

      return { memoriesProcessed: 0, success: false, error: errMsg };
    }

    // Phase 5: Subsequent processing — safe cleanup of soft-deleted files
    //
    // Security: The LLM has no `exec` tool and cannot run shell commands.
    // Instead, it "deletes" files by writing the marker `[DELETED]` to the file
    // (writing empty/whitespace-only content is rejected by core's write tool
    // parameter validation). Here we detect and remove those soft-deleted files
    // before syncing the index, so syncSceneIndex won't re-index stale entries.
    //
    // We also detect "META-only" files — files that contain only a META header
    // (e.g. [ARCHIVE] or [CONSOLIDATED] markers) but no actual scene content.
    // These are artifacts of LLM merges that didn't properly delete old files.
    const cleanupStartMs = Date.now();
    let cleanedCount = 0;
    try {
      let allFiles: string[];
      if (this.storage) {
        allFiles = await this.storage.readdirNames(StoragePaths.sceneBlocksDir, ".md");
      } else {
        const fs = await import("node:fs/promises");
        allFiles = (await fs.default.readdir(sceneBlocksDir)).filter((f: string) => f.endsWith(".md"));
      }
      for (const file of allFiles) {
        let raw: string | null;
        if (this.storage) {
          raw = await this.storage.readFile(`${StoragePaths.sceneBlocksDir}${file}`);
        } else {
          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          raw = await fs.default.readFile(path.default.join(this.dataDir, "scene_blocks", file), "utf-8");
        }
        if (!raw || raw.trim().length === 0 || raw.trim() === "[DELETED]") {
          // Empty file or [DELETED] marker — soft-delete
          if (this.storage) {
            await this.storage.unlink(`${StoragePaths.sceneBlocksDir}${file}`);
          } else {
            const fs = await import("node:fs/promises");
            const path = await import("node:path");
            await fs.default.unlink(path.default.join(this.dataDir, "scene_blocks", file));
          }
          cleanedCount++;
          this.logger?.debug?.(`${TAG} extract() removed soft-deleted file: ${file}`);
        } else {
          // Check if file has only META header but no actual content
          const block = parseSceneBlock(raw, file);
          if (!block.content || block.content.trim().length === 0) {
            if (this.storage) {
              await this.storage.unlink(`${StoragePaths.sceneBlocksDir}${file}`);
            } else {
              const fs = await import("node:fs/promises");
              const path = await import("node:path");
              await fs.default.unlink(path.default.join(this.dataDir, "scene_blocks", file));
            }
            cleanedCount++;
            this.logger?.debug?.(`${TAG} extract() removed META-only file (no content): ${file}`);
        } else if (isArchiveFile(raw)) {
          // [P2-A3 审核 P1-3] 归档文件（META archive:true）不参与 spill/⑧/⑥b——
          // 防 archive 被 toV2Format 迁移退化与 factSupersede 污染只读语义。
        } else {
          // [P2-A3 C 案·审核 P0-2] spill 先于 ⑧：先把活动段旧批次段抢救进可召回
          // archive（⑧ 折叠只进轮换 .backup·keep=10 会丢）；off 时零调用零 I/O。
          if (this.sceneArchive?.enabled === true) {
            await this.spillSceneFile(file, raw);
          }
          // [P1 票⑧ 场景帽压力治理] 确定性压实：只在 soft-delete/META-only 判定之后
          // （不对将删文件做无用功），且在 Phase 6 syncSceneIndex 之前（索引看到压实后
          // 内容）。off（undefined/enabled=false）时本分支零调用、零 I/O。
          if (this.sceneCompaction?.enabled === true) {
            await this.compactSceneFile(file, raw);
          }
          // [P1-6b 同源替代生成] 确定性同锚替代折叠（压实之后跑，读到当前文件态；
          // shadow=只打 metric 不落盘，on=写回）。off 时零调用、零 I/O。
          if (this.factSupersede) {
            await this.supersedeFactFile(file);
          }
        }
        }
      }
    } catch (cleanupErr) {
      // Non-fatal — log and continue to index sync
      this.logger?.warn(`${TAG} extract() soft-delete cleanup error: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
    }
    this.logger?.debug?.(`${TAG} extract() soft-delete cleanup: removed ${cleanedCount} empty files (${Date.now() - cleanupStartMs}ms)`);

    // Phase 5b: Normalize filenames (defensive — LLM occasionally produces names
    // with spaces / punctuation despite the prompt forbidding them, e.g.
    // "Daily Rhythm in Shanghai.md". Such names break downstream consumers
    // that parse Markdown navigation refs with `\S+\.md` style regexes
    // (health-checker), shell tools, and URL-encoded path consumers.
    //
    // Renaming here — *before* syncSceneIndex — means scene_index.json and
    // every downstream reader (PersonaGenerator, recall, profile-sync) only
    // ever sees canonical filenames. Idempotent and safe to run repeatedly.
    const normStartMs = Date.now();
    try {
      const normResult = await normalizeSceneFilenames(sceneBlocksDir, this.logger);
      if (normResult.renamed > 0) {
        this.logger?.info(
          `${TAG} extract() filename normalization: renamed ${normResult.renamed}, skipped ${normResult.skipped} (${Date.now() - normStartMs}ms)`,
        );
      } else {
        this.logger?.debug?.(
          `${TAG} extract() filename normalization: skipped ${normResult.skipped} (${Date.now() - normStartMs}ms)`,
        );
      }
    } catch (normErr) {
      // Non-fatal — log and continue. Index sync below will simply pick up
      // whatever names are present on disk.
      this.logger?.warn(`${TAG} extract() filename normalization error: ${normErr instanceof Error ? normErr.message : String(normErr)}`);
    }

    // Phase 6: Sync scene index (rebuilds from remaining non-empty files)
    const syncStartMs = Date.now();
    await syncSceneIndex(this.dataDir, this.storage);
    this.logger?.debug?.(`${TAG} extract() scene index synced: ${Date.now() - syncStartMs}ms`);

    // Phase 7: Update persona.md navigation (GAP-4 fix)
    const navStartMs = Date.now();
    try {
      await this.updateSceneNavigation();
      this.logger?.debug?.(`${TAG} extract() persona.md navigation updated: ${Date.now() - navStartMs}ms`);
    } catch (navErr) {
      // Non-fatal — log and continue
      this.logger?.warn(`${TAG} extract() failed to update persona navigation: ${navErr instanceof Error ? navErr.message : String(navErr)}`);
    }

    // Phase 8: Parse LLM output for out-of-band persona update signal
    if (llmOutput) {
      const signal = parsePersonaUpdateSignal(llmOutput);
      if (signal) {
        await cpManager.setPersonaUpdateRequest(signal.reason);
        this.logger?.debug?.(`${TAG} extract() persona update requested by LLM: ${signal.reason}`);
      }
    }

    const totalMs = Date.now() - extractStartMs;
    this.logger?.info(`${TAG} extract() completed: ${memories.length} memories processed in ${totalMs}ms`);

    const sceneDiff = await this.capturePersistedDiff(preExtractSnapshots);
    const resultScenes: Array<{ title: string; summary: string; content: string; status: "created" | "updated" }> = [
      ...sceneDiff.created.map((scene) => ({
        title: scene.filename.replace(/\.md$/, ""),
        summary: scene.summary,
        content: scene.content,
        status: "created" as const,
      })),
      ...sceneDiff.updated
        .filter(({ before, after }) => before.content !== after.content)
        .map(({ after }) => ({
          title: after.filename.replace(/\.md$/, ""),
          summary: after.summary,
          content: after.content,
          status: "updated" as const,
        })),
    ];
    const scenesCreated = sceneDiff.created.length;
    const scenesUpdated = sceneDiff.updated.filter(({ before, after }) => before.content !== after.content).length;
    const scenesDeleted = sceneDiff.deleted.length;

    // 2026-10-27（用户拍板「只观测不动游标」）：全零 diff 轮次记 WARN 锚点。
    // 既有 emptyExtraction 谓词在已有场景时恒 false（见下方 :498），实测 284 轮里
    // 8 轮 created/updated/deleted 全零却仍推进游标。这里只观测：不改判定、不阻断
    // 也不推进游标；是否据此做门控另票，等 3–7 天基线。
    if (isNoopSceneDiff(scenesCreated, scenesUpdated, scenesDeleted)) {
      this.logger?.warn?.(
        `${TAG} l2-noop-processed instance=${this.instanceId ?? "(none)"} created=0 updated=0 deleted=0 — 全零 diff 轮（只观测，游标照常）`,
      );
    }

    // ── l2_extraction metric ──
    if (this.instanceId && this.logger) {

      report("l2_extraction", {
        inputMemoryCount: memories.length,
        resultSceneCount: resultScenes.length,
        resultScenes,
        scenesCreated,
        scenesUpdated,
        scenesDeleted,
        llmDurationMs,
        totalDurationMs: totalMs,
        success: true,
        error: null,
      });

      // ── 评测指标：L2 延迟 + 场景变化 ──
      try {
        const postSceneCount = (await readSceneIndex(this.dataDir, this.storage)).length;
        reportL2LatencyMetrics({
          instanceId: this.instanceId ?? "",
          extractionLatencyMs: totalMs,
          llmDurationMs: llmDurationMs > 0 ? llmDurationMs : null,
          sceneCountBefore: preExtractIndex.size,
          sceneCountAfter: postSceneCount,
          scenesCreated,
          scenesUpdated,
          scenesDeleted,
          hasError: false,
        });
      } catch {
        // 静默忽略
      }
    }

    // Detect empty extraction: pre and post scene_index both empty means LLM didn't write anything
    const postIndex = await readSceneIndex(this.dataDir, this.storage);
    const emptyExtraction = preExtractIndex.size === 0 && postIndex.length === 0;
    if (emptyExtraction) {
      this.logger?.warn(`${TAG} extract() empty extraction detected: LLM produced no file changes`);
    }

    // Preserve the historical enumerable result shape: several callers compare
    // this object structurally. The in-process L2 runner can still read the
    // diagnostic delta, but it is not accidentally serialized as user content.
    const result: ExtractionResult = {
      memoriesProcessed: memories.length,
      success: true,
      emptyExtraction,
    };
    // 2026-10-30：no-op 门控判据——「零 diff 且最终输出为空」= 疑似中途夭折
    // （steps 撞顶/供应商挂起），pipeline-factory 据此阻断游标推进。
    // 非枚举：与 sceneDiff 同款，避免被结构比较/序列化带出去。
    Object.defineProperty(result, "outputChars", {
      value: llmOutput?.length ?? 0,
      enumerable: false,
      configurable: false,
    });
    Object.defineProperty(result, "sceneDiff", {
      value: sceneDiff,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return result;
  }

  /**
   * [P1 票⑧ 场景帽压力治理] 单文件确定性压实（Phase 5 内、syncSceneIndex 之前）。
   *
   * - 阈值：`raw.length > sceneCharCap × triggerRatio`（cap ≤0/非有限值 = 关闭）。
   * - 压实：`compactSceneBlock`（纯函数）把 `## 活动` 段的旧批次叙事折成一行标记，
   *   锚点行/事实段/要点段一字不动；折到 cap×targetRatio 即停。
   * - 写回：storage（COS/服务模式）与本地 fs 两路都要，保证索引同步看到压实后内容。
   * - 容错：本方法内异常只 warn，不中断 Phase 5 后续文件与 L2 主流程。
   * - off（sceneCompaction undefined 或不 enabled）时调用方不进本方法 ⇒ 零 I/O。
   */
  private async compactSceneFile(file: string, raw: string): Promise<void> {
    const cfg = this.sceneCompaction;
    const cap = this.sceneCharCap;
    if (!cfg || cfg.enabled !== true) return;
    if (cap === undefined || !Number.isFinite(cap) || cap <= 0) return;
    const triggerChars = cap * cfg.triggerRatio;
    if (raw.length <= triggerChars) return;
    try {
      const result = compactSceneBlock(raw, { triggerChars, targetChars: cap * cfg.targetRatio });
      if (!result.compacted || result.content === raw) return;
      if (this.storage) {
        await this.storage.writeFile(`${StoragePaths.sceneBlocksDir}${file}`, result.content);
      } else {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        await fs.default.writeFile(path.default.join(this.dataDir, "scene_blocks", file), result.content, "utf-8");
      }
      this.logger?.info?.(
        `${TAG} metric=l2_scene_compact enabled=1 file=${file} before=${result.beforeChars} after=${result.afterChars} folded=${result.foldedLines} anchors=${result.keptAnchorLines} reason=${result.reason ?? "ok"}`,
      );
    } catch (err) {
      this.logger?.warn(
        `${TAG} extract() scene compaction error (non-fatal, file kept as-is): ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * [P1-6b 同源替代生成] 单文件确定性同锚替代折叠（Phase 5 内、压实之后、syncSceneIndex 前）。
   *
   * - 判据：同锚多重集 >1 且旧行与同锚最新行脱敏相似度 ≥ minSimilarity → 旧行加
   *   `[SUPERSEDED <ISO>]` 前缀（只标不删，锚点多重集零变化）。
   * - mode=shadow：只打 `metric=l2_fact_supersede` 不落盘；mode=on：经
   *   checkAnchorPreservation 防御性守卫后写回（storage/本地 fs 两路）。
   * - [P1-6b 批准桶] on 且配置 judgeStatePath：只标记 judge 批准的对；state 读不到
   *   或批准集为空 ⇒ **fail-closed 一个都不标**（不是 fail-open 全量标记——
   *   全量标记正是本机制要堵的「静默绕过闸门」缺口）。
   * - 读取当前文件态（可能已被 compactSceneFile 写回）；marked=0 时零日志零写。
   * - 容错：异常只 warn 不中断 Phase 5 后续文件与 L2 主流程。
   */
  /**
   * [P2-A3 C 案] 单文件归档 spill（Phase 5 内、compactSceneFile **之前**·审核 P0-2）。
   * shadow=只打 metric=l2_scene_archive 不写盘；on=archive 先行、main 后行（审核 P0-3），
   * append 前按段 date 去重（防崩溃恢复重复追加）；锚点守恒内建于 planSceneSpill。
   */
  private async spillSceneFile(file: string, raw: string): Promise<void> {
    const cfg = this.sceneArchive;
    if (!cfg) return; // off（parse 已把 mode=off 映射为 undefined·此处不可达）
    try {
      const sceneName = file.replace(/\.md$/, "");
      const plan = planSceneSpill(sceneName, raw, cfg, Date.now());
      if (plan.segments.length === 0) return;
      this.logger?.info?.(
        `${TAG} metric=l2_scene_archive mode=${cfg.mode} file=${file} segments=${plan.segments.length} freed=${plan.freedChars} dates=${plan.segments.map((s) => s.date).join("/")} conserved=${plan.anchorsConserved}`,
      );
      if (cfg.mode !== "on" || !plan.anchorsConserved) return;
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const archName = `${sceneName}-archive.md`;
      // archive 先行：不存在则建（META archive:true）；存在则按段 date 去重后追加
      let archExisting = "";
      if (this.storage) {
        archExisting = (await this.storage.readFile(`${StoragePaths.sceneBlocksDir}${archName}`)) ?? "";
      } else {
        archExisting = await fs.default
          .readFile(path.default.join(this.dataDir, "scene_blocks", archName), "utf-8")
          .catch(() => "");
      }
      const already = new Set(
        (archExisting.match(/^###[ \t]+(?:★[ \t]*)?(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2})/gm) ?? []).map((h) =>
          h.replace(/^###[ \t]+(?:★[ \t]*)?/, ""),
        ),
      );
      const segText = (d: string) =>
        plan.segments.filter((s) => s.date === d && !already.has(s.date)).map(() => plan.archiveAppend).join("\n\n");
      const freshDates = plan.segments.filter((s) => !already.has(s.date)).map((s) => s.date);
      if (freshDates.length > 0) {
        const merged =
          archExisting.length === 0
            ? buildArchiveFile(plan.archiveAppend)
            : mergeArchiveFile(archExisting, plan.archiveAppend);
        if (this.storage) {
          await this.storage.writeFile(`${StoragePaths.sceneBlocksDir}${archName}`, merged);
        } else {
          await fs.default.writeFile(path.default.join(this.dataDir, "scene_blocks", archName), merged, "utf-8");
        }
      }
      // main 后行
      if (this.storage) {
        await this.storage.writeFile(`${StoragePaths.sceneBlocksDir}${file}`, plan.mainAfter);
      } else {
        await fs.default.writeFile(
          path.default.join(this.dataDir, "scene_blocks", file),
          plan.mainAfter,
          "utf-8",
        );
      }
      this.logger?.info?.(
        `${TAG} metric=l2_scene_archive_spill file=${file} archived=${freshDates.length} freed=${plan.freedChars}`,
      );
    } catch (err) {
      this.logger?.warn(
        `${TAG} extract() scene archive spill error (non-fatal, file kept as-is): ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  private async supersedeFactFile(file: string): Promise<void> {
    const cfg = this.factSupersede;
    if (!cfg || cfg.mode === "off") return;
    try {
      let current: string;
      if (this.storage) {
        const r = await this.storage.readFile(`${StoragePaths.sceneBlocksDir}${file}`);
        if (!r) return;
        current = r;
      } else {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        current = await fs.default.readFile(path.default.join(this.dataDir, "scene_blocks", file), "utf-8");
      }
      const result = deterministicSupersede(current, { minSimilarity: cfg.minSimilarity });
      if (result.markedLines.length === 0) return;
      const chars = countSupersededChars(result.content) - countSupersededChars(current);
      // 口径说明（P2-8）：marked=/chars= 均为**过滤前**读数（确定性候选规模），
      // on+judgeStatePath 模式下会高于实际落盘量；实际落盘量看 approved=/reverted=。
      // [P1-6b 批准桶] on 模式且配置了 judgeStatePath → 只标记 judge 批准的对。
      // shadow 模式不过滤（保持分布观测口径）；
      // 读不到 state / 畸形解析得空批准集 → fail-closed 一个都不标（不放大标记范围）。
      let outContent = result.content;
      let approved = 0;
      let reverted = 0;
      if (cfg.mode === "on" && cfg.judgeStatePath) {
        const fsP = await import("node:fs/promises");
        let raw: string | null = null;
        try {
          raw = await fsP.default.readFile(cfg.judgeStatePath, "utf-8");
        } catch {
          raw = null;
        }
        if (raw === null) {
          // fail-closed：配了闸门却拿不到批准集 ⇒ 一个都不标。
          // 选它而非 fail-open 全量标记，是因为全量标记正是本票要堵的结构性缺口
          // （静默绕过 judge）；零标记=零信息损失（事实保持可见），与 shadow 等效。
          this.logger?.warn(
            `${TAG} judge state unavailable, factSupersede marks nothing (fail-closed, non-fatal): ${cfg.judgeStatePath}`,
          );
          return;
        }
        const idx = parseJudgeApprovalState(raw);
        const f = filterSupersededByApproval(outContent, current, result.pairs, idx.approved, file);
        outContent = f.content;
        approved = f.kept;
        reverted = f.reverted;
      }
      this.logger?.info?.(
        `${TAG} metric=l2_fact_supersede mode=${cfg.mode} file=${file} marked=${result.markedLines.length} chars=${chars} spared=${result.sparedLowSim} nodate=${result.sparedNoDate}` +
          (cfg.mode === "on" && cfg.judgeStatePath ? ` approved=${approved} reverted=${reverted}` : ""),
      );
      if (cfg.mode !== "on") return;
      if (cfg.judgeStatePath && approved === 0) return; // 无批准对 ⇒ 零写盘（metric 已留痕）
      const loss = checkAnchorPreservation(current, outContent);
      if (loss) {
        this.logger?.warn(`${TAG} factSupersede anchor guard rejected (non-fatal): ${file} lost=${loss.lostCount}`);
        return;
      }
      if (this.storage) {
        await this.storage.writeFile(`${StoragePaths.sceneBlocksDir}${file}`, outContent);
      } else {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        await fs.default.writeFile(path.default.join(this.dataDir, "scene_blocks", file), outContent, "utf-8");
      }
    } catch (err) {
      this.logger?.warn(
        `${TAG} extract() factSupersede error (non-fatal, file kept as-is): ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async capturePersistedDiff(
    before: Map<string, SceneFileSnapshot>,
  ): Promise<PersistedSceneDiff> {
    const finalIndex = await readSceneIndex(this.dataDir, this.storage);
    const after = new Map<string, SceneFileSnapshot>();
    for (const entry of finalIndex) {
      try {
        let raw: string | null;
        if (this.storage) {
          raw = await this.storage.readFile(`${StoragePaths.sceneBlocksDir}${entry.filename}`);
        } else {
          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          raw = await fs.default.readFile(
            path.default.join(this.dataDir, "scene_blocks", entry.filename),
            "utf-8",
          );
        }
        if (!raw) continue;
        const block = parseSceneBlock(raw, entry.filename);
        after.set(entry.filename, snapshotSceneFile(entry.filename, raw, block));
      } catch {
        // A final index entry without a readable file is still visible through afterFiles.
      }
    }

    const created: SceneFileSnapshot[] = [];
    const updated: Array<{ before: SceneFileSnapshot; after: SceneFileSnapshot }> = [];
    const deleted: SceneFileSnapshot[] = [];
    for (const [filename, snapshot] of after) {
      const old = before.get(filename);
      if (!old) created.push(snapshot);
      else if (old.sha256 !== snapshot.sha256) updated.push({ before: old, after: snapshot });
    }
    for (const [filename, snapshot] of before) {
      if (!after.has(filename)) deleted.push(snapshot);
    }
    return {
      beforeFiles: [...before.keys()].sort(),
      afterFiles: finalIndex.map((entry) => entry.filename).sort(),
      created,
      updated,
      deleted,
    };
  }

  /**
   * Build human-readable scene summaries for the prompt,
   * and collect the list of existing scene filenames (relative).
   *
   * Includes a capacity counter at the top (e.g. "当前场景总数：5 / 15")
   * so the LLM can immediately see how close it is to the limit.
   */
  private buildSceneSummaries(
    index: SceneIndexEntry[],
  ): { summaries: string; filenames: string[] } {
    if (index.length === 0) return { summaries: "", filenames: [] };

    const lines: string[] = [];
    const filenames: string[] = [];

    // Inject capacity counter at the top — LLM sees this first
    lines.push(`**当前场景总数：${index.length} / ${this.maxScenes}**`);
    lines.push("");

    for (const entry of index) {
      filenames.push(entry.filename);
      lines.push(`### ${entry.filename}`);
      lines.push(`**热度**: ${entry.heat} | **更新**: ${entry.updated}`);
      lines.push(`**summary**: ${entry.summary}`);
      lines.push("");
    }
    return { summaries: lines.join("\n"), filenames };
  }

  /**
   * Update the scene navigation section at the end of persona.md.
   *
   * Reads the current scene index, generates the navigation block, then
   * strips any existing navigation from persona.md and appends the new one.
   *
   * IMPORTANT: If the persona body is empty (PersonaGenerator hasn't run yet),
   * we skip writing to avoid creating a persona.md that only contains the
   * scene navigation. PersonaGenerator.generate() will write the full
   * persona + navigation when it runs.
   */
  private async updateSceneNavigation(): Promise<void> {
    const index = await readSceneIndex(this.dataDir, this.storage);
    // 票⑦：persona.recallRanking on 时导航按多信号排序并打观测锚点；off=基线逐字节。
    const nav = generateSceneNavigation(index, undefined, false, this.recallRanking, (line) =>
      this.logger?.info(`${TAG} ${line}`),
    );

    let existing = "";
    try {
      if (this.storage) {
        existing = (await this.storage.readFile(StoragePaths.persona)) ?? "";
      } else {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        existing = await fs.default.readFile(path.default.join(this.dataDir, "persona.md"), "utf-8");
      }
    } catch {
      // No persona file yet — PersonaGenerator will create it with navigation.
      // Don't write a navigation-only file.
      this.logger?.debug?.(`${TAG} updateSceneNavigation() skipped: no persona file yet, waiting for PersonaGenerator`);
      return;
    }

    if (!existing.trim() && !nav) return;

    const stripped = stripSceneNavigation(existing).trimEnd();

    // If the persona body is empty (only navigation existed), don't overwrite
    // with a navigation-only file. Let PersonaGenerator handle full generation.
    if (!stripped) {
      this.logger?.debug?.(`${TAG} updateSceneNavigation() skipped: persona body is empty, waiting for PersonaGenerator`);
      return;
    }

    const updated = nav ? `${stripped}\n\n${nav}\n` : `${stripped}\n`;

    if (this.storage) {
      await this.storage.writeFile(StoragePaths.persona, updated);
    } else {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      await fs.default.writeFile(path.default.join(this.dataDir, "persona.md"), updated, "utf-8");
    }
  }
}

function snapshotSceneFile(
  filename: string,
  raw: string,
  block: ReturnType<typeof parseSceneBlock>,
): SceneFileSnapshot {
  return {
    filename,
    sha256: createHash("sha256").update(raw).digest("hex"),
    chars: raw.length,
    parseable: block.meta.created.length > 0 || block.meta.updated.length > 0,
    created: block.meta.created,
    updated: block.meta.updated,
    summary: block.meta.summary,
    heat: block.meta.heat,
    content: block.content,
    raw,
  };
}

function formatTimestamp(d: Date): string {
  return d.toISOString();
}
