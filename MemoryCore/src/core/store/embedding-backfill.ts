/**
 * Embedding 回填（票④b 前置 A3）。
 *
 * `initStores()` 在 provider/model/dimensions 变更时会 drop+重建向量表并返回
 * `needsReindex=true`；但 `embedding_meta` 在 `initSchema` 末尾就已写入新 provider
 * （memory-store.ts:1160-1170），**若本次启动不回填，下次重启 savedMeta 已匹配、
 * needsReindex=false，缺口永久静默化**。因此回填必须与首次检测同一次启动完成。
 *
 * 本模块只做编排：
 * - 未触发 → 返回 undefined（零开销，off/正常启动路径不变）；
 * - 触发 → 立即返回后台 Promise（调用方**不得 await**，避免阻塞 initStores）；
 * - 失败 → 吞掉异常 + `metric=embedding_reindex status=failed` 锚点（绝不阻断启动），
 *   并提示用手动脚本兜底（重试不会自动发生，见上）。
 */

import type { EmbeddingService } from "./embedding.js";
import type { IMemoryStore } from "./types.js";
import type { Logger } from "../types.js";
import { redactError } from "../../utils/redact-secrets.js";

const TAG = "[memory-tdai][embedding-backfill]";

export interface EmbeddingBackfillParams {
  /** 由 store init 返回的 needsReindex。false → 不触发。 */
  needsReindex: boolean;
  /** store init 给出的变更原因（锚点用）。 */
  reindexReason?: string;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  logger: Logger;
  /** 与 TdaiCore.destroy() 共享：保证关闭连接前回填任务被 drain。 */
  bgTaskRegistry?: Set<Promise<void>>;
  /** 进度锚点步长（默认每 100 条）。 */
  progressEvery?: number;
}

/**
 * 在需要时启动后台回填。返回后台 Promise（已启动）或 undefined（未触发）。
 * **调用方不要 await 返回值** —— 回填是后台任务。
 */
export function startEmbeddingBackfill(params: EmbeddingBackfillParams): Promise<void> | undefined {
  const { needsReindex, reindexReason, vectorStore, embeddingService, logger, bgTaskRegistry } = params;
  if (!needsReindex || !vectorStore || !embeddingService) return undefined;

  const progressEvery = params.progressEvery && params.progressEvery > 0 ? params.progressEvery : 100;

  const task: Promise<void> = (async () => {
    const t0 = Date.now();
    logger.info(
      `${TAG} metric=embedding_reindex status=start reason=${reindexReason ?? "(unknown)"}`,
    );
    try {
      const result = await vectorStore.reindexAll(
        (text) => embeddingService.embed(text),
        (done, total, layer) => {
          if (done === total || done % progressEvery === 0) {
            logger.info(
              `${TAG} metric=embedding_reindex status=progress layer=${layer} done=${done} total=${total}`,
            );
          }
        },
      );
      // reindexAll 内部吞掉异常并返回计数：needsReindex=true 意味着 init 时检测到
      // 存量数据（provider/model 变更分支），两计数都是 0 基本等价于「全部失败」。
      if (result.l1Count + result.l0Count === 0) {
        logger.warn(
          `${TAG} metric=embedding_reindex status=failed reason=zero_rows_or_all_failed ` +
          `ms=${Date.now() - t0} — 请运行 scripts/backfill-embedding.ts 兜底`,
        );
        return;
      }
      logger.info(
        `${TAG} metric=embedding_reindex status=ok l1=${result.l1Count} l0=${result.l0Count} ` +
        `ms=${Date.now() - t0}`,
      );
    } catch (err) {
      // 绝不外抛：回填失败只降级（向量腿偏少），不得影响启动/捕获。
      logger.warn(
        `${TAG} metric=embedding_reindex status=failed reason=${redactError(err)} ms=${Date.now() - t0} ` +
        `— embedding_meta 已写入新 provider，下次重启不会自动重试；请运行 scripts/backfill-embedding.ts 兜底`,
      );
    }
  })();

  if (bgTaskRegistry) {
    bgTaskRegistry.add(task);
    void task.finally(() => {
      bgTaskRegistry.delete(task);
    });
  }

  return task;
}
