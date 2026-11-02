/**
 * 票④b 前置 A3 兜底：向量回填手动脚本（幂等）。
 *
 * 背景：`initStores()` 检测到 embedding provider/model/dimensions 变更时 drop+重建
 * 向量表并返回 `needsReindex=true`，网关启动时已在后台自动回填（tdai-core
 * `startEmbeddingBackfill`）。但 `embedding_meta` 在 initSchema 末尾就写入新
 * provider——**若那次启动的回填失败，下次重启 savedMeta 已匹配、needsReindex=false，
 * 缺口不会自动重试**。此时跑本脚本补齐。
 *
 * 幂等：`reindexAll` 对每条文本 delete+insert 向量（L1/L0 各一层），可重复执行。
 *
 * 用法（在 MemoryCore 目录下）：
 *   npx tsx scripts/backfill-embedding.ts            # 回填 L1 + L0
 *   npx tsx scripts/backfill-embedding.ts --dry-run  # 只统计待回填条数
 *
 * 配置来源：`loadGatewayConfig()`（TDAI_GATEWAY_CONFIG > cwd > 默认数据目录），
 * 与网关完全同源；apiKey 由 env（embedding.apiKeyEnv）或 yaml 明文提供，
 * 本脚本**不打印任何凭据**。
 *
 * 退出码：0=完成（含 dry-run）；1=异常；3=store/embedding 不可用（provider=none、
 * apiKey 未解析或 store init 失败）。
 */
import { loadGatewayConfig } from "../src/gateway/config.js";
import { initStores } from "../src/utils/pipeline-factory.js";

const TAG = "[backfill-embedding]";
const PROGRESS_EVERY = 100;

const logger = {
  debug: (_message: string) => {},
  info: (message: string) => console.log(`${TAG} ${message}`),
  warn: (message: string) => console.warn(`${TAG} ${message}`),
  error: (message: string) => console.error(`${TAG} ${message}`),
};

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");

  const gw = loadGatewayConfig();
  const emb = gw.memory.embedding;
  logger.info(
    `config: provider=${emb.provider} model=${emb.model} dimensions=${emb.dimensions} ` +
    `sendDimensions=${emb.sendDimensions} apiKeyEnv=${emb.apiKeyEnv ?? "(none)"} ` +
    `apiKey=${emb.apiKey ? "(set)" : "(empty)"}`,
  );
  if (emb.configError) logger.warn(`configError: ${emb.configError}`);

  const stores = await initStores(gw.memory, gw.data.baseDir, logger);
  if (!stores.vectorStore || !stores.embeddingService) {
    logger.error("store/embedding 不可用（store init 失败或 embedding 被禁用），无法回填");
    return 3;
  }

  logger.info(
    `store ready: needsReindex=${stores.needsReindex}` +
    (stores.reindexReason ? ` reason=${stores.reindexReason}` : ""),
  );

  if (dryRun) {
    const l1 = await stores.vectorStore.getAllL1Texts();
    const l0 = await stores.vectorStore.getAllL0Texts();
    logger.info(`dry-run: L1=${l1.length} L0=${l0.length}（未调用 embedding）`);
    stores.vectorStore.close();
    return 0;
  }

  const t0 = Date.now();
  const result = await stores.vectorStore.reindexAll(
    (text) => stores.embeddingService!.embed(text),
    (done, total, layer) => {
      if (done === total || done % PROGRESS_EVERY === 0) {
        logger.info(`progress ${layer}: ${done}/${total}`);
      }
    },
  );
  logger.info(
    `done: L1=${result.l1Count} L0=${result.l0Count} elapsed=${Date.now() - t0}ms`,
  );
  stores.vectorStore.close();
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    logger.error(`failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
