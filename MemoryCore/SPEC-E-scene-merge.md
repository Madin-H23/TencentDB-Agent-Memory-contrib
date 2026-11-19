# SPEC-E：确定性 mergeScene（场景合并内核，默认 off）

- 状态：Stage 1 已本地提交（amend 后实际 HEAD `e70b170`，未 push）；Stage 2 shadow 钩子已提交（`ca34a68`，未 push）；Stage 3（S3-01–S3-06：on 解析放行、allowProductionDataDir、on 执行钩子、门禁 H、生产启用、回归/变异/双审）实现完成并本地提交（未 push）；生产网关 2026-11-20 01:22 CST 重启后 `mode=on` 生效，01:30 首轮实跑 `result=merged`（场景 23→22）；01:53 R2 与 02:11 R3 均 `rejected candidate_unavailable`、`ALERT=0`，R3 验证 done journal 在 C 被 Phase 5 改写后仍 noop（不报错、不回滚）｜日期：2026-11-20｜作者：DSH lead
- 依据：`reviews/merge-tool-spec-draft-20261119.md`、`reviews/merge-tool-risk-20261119.md`、v3-wt HEAD `87b7567` 只读源码、2026-11-19 18:2x 现场只读实测。
- 范围：Stage 1（纯内核 + 影子 CLI，默认 off、零生产写）。N2 橙档自动触发、D4 CREATE 硬闸、头部四场景、N3′ 归档召回均不在本文范围。
- 证据标记：【已核】本会话直接读源码/文件；【实测】2026-11-19 现场只读扫描；【设计】待实现。

## 1. Problem Statement

23 个活动场景在橙档形成稳定不动点：`maxScenes=24`、橙档 23 禁止 CREATE（`scene-extractor.ts:345-357`），而代码层没有任何确定性合并实现（src 无 `mergeScene`/`autoMerge`）。现有 MERGE 只能由 L2 模型按提示词执行，已被证明不可靠：读预算 80,000 字符、单次输出约 65,536 tokens、无 journal/锁、失败无回滚；14:22 与 11:16 的事故分别以零写入和误删归档收场。结果是大场景只增不减，TDAI 主档 2026-11-19 18:0x 已达约 398K/500K，而 23 个活动场景中已有 7 个 >150K。

需要的是一条不依赖模型、可审计、可恢复的「两个活动场景 → 一个新活动场景」确定性路径；它只负责释放槽位和合并尾部同主题场景，不承诺解决头部 54.7%。

## 2. Solution

把合并拆成两层：

1. **纯规划器 `planMerge`**：读入 A/B 的原始文本与 META，重排输入顺序，按 v2 三段做正文**全文拼接**（仅重复 v2 标题行归一化，见 §4.3），重算 META，执行锚点多重集/正文行多重集/字符帽三类断言，返回 `MergePlan`（含 C 全文、幂等键、指标）或结构化拒绝。零 fs、零 LLM、零网络。
2. **事务执行器 `executeMerge`**：先写 journal + A/B preimage，再写 C、回读校验、标记 A/B `[DELETED]`，每阶段落 journal；启动/每次合并前/每轮 Phase4 后执行恢复扫描。跨进程文件锁保护，幂等键保证重跑不产生第二个 C。

Stage 1 只交付这两层 + 影子 CLI；`persona.mergeScene.mode` 默认 `off`，不接 L2 提示词、不接橙档触发、不碰生产 `scene_blocks`。Stage 2 在 Phase4 后/Phase5 前接 L2 钩子（只 shadow：选对 + plan + metric，零写）；Stage 3 才做 `mode=on` 限定域执行（用户已口头批准，以门禁通过为前提）。

## 3. User Stories

1. As a memory operator, I want two active scenes merged without any LLM output, so that a slot is freed deterministically even when the model is over budget.
2. As an auditor, I want every merge to carry input sha256, anchor/body conservation proofs and preimages, so that I can verify zero loss and reconstruct A/B.
3. As an on-call engineer, I want a crash between any two stages to converge to 22 active scenes after restart, so that a half-merge never becomes a 24-scene red alert.
4. As a developer, I want the assembly and all assertions to be pure functions testable without fs, so that edge cases fail fast and cheaply.
5. As a maintainer, I want Stage 1 off by default with no prompt/config behavior change, so that shipping it cannot alter current L2 behavior.
6. As the future autonomy path, I want a stable `planMerge`/`executeMerge` interface, so that N2 can add candidate selection later without rewriting the transaction layer.

## 4. Implementation Decisions

### 4.1 模块与 seam

- 新增 `MemoryCore/src/core/scene/scene-merge.ts`（唯一新模块；不塞进 `scene-extractor.ts`，避免把事务逻辑与 L2 流程耦合）。
- 新增单文件理由（对用户「零新文件」偏好的显式豁免）：事务/状态机与 L2 抽取流程解耦，避免在 `scene-extractor.ts` 内再复制一套写盘路径；不新增依赖、不新增框架，其余全部复用现有函数；CONTRIBUTING.md 未要求零新文件。
- 导出：`planMerge(input, opts): MergePlan | MergeRejection`、`executeMerge(plan, deps, opts): MergeResult`、`recoverMergeJournal(deps, opts): RecoveryReport`、`deriveMergeKey`、`deriveMergeTargetName`。
- 复用现有纯函数（2026-11-19 18:3x 逐条已核）：`parseSceneBlock`/`formatMeta`/`isArchiveSceneFile`（`scene-format.ts:36-92`）、`findV2Sections`/`isV2Format`/`syncV2MetaSummary`/`buildV2ReadView`（`scene-format-v2.ts:91-179`）、`extractAnchorIds`/`isSupersededLine`/`checkAnchorPreservation`/`findUnrelocatedAnchors`/`checkSceneCharCapWithSupersede`（`utils/supersede.ts:79-205`）、`checkSceneCharCap`（`utils/scene-char-cap.ts:39-53`）、`renameWithRetry`（`utils/checkpoint.ts:173-189`）。
- 唯一需要改现有文件的地方：`scene-format-v2.ts:65` 的 `V2_HEADING_RE` 加 `export`（用于 v2 标题识别与重复标题归一化；不复制正则，避免口径漂移）。
- `parseSceneBlock` 的 `content` 会 `trim()`；合并内的字符数、行多重集一律以 `parseSceneBlock().content` 为基准，原文件字节仅用于 sha256/preimage。
- **禁止**复用 Phase 5 的直写路径（`scene-extractor.ts:730-736`/`:826-841`/`:974-985` 绕过帽与锚点守卫）；执行器必须显式调用上述纯函数做校验。
- Stage 1 零 LLM、零网络、零提示词改动。

### 4.2 输入与规范化

- 输入恰为两个**活动**场景文件名（相对 `scene_blocks`，禁路径分隔符/`..`）。身份判定以目录事实为主：`readdirNames(scene_blocks, ".md")` → 逐文件读内容 → `isArchiveSceneFile(file, raw)` 排除归档 → 内容 trim 后为 `[DELETED]` 排除；`readSceneIndex(dataDir, storage)` 只作交叉核对并告警，不得当唯一权威（sidecar 可能 stale；`scene-index.ts:40-42,74-89` 只过滤归档、不过滤 `[DELETED]`）。索引缺失/不一致以目录为准。Stage 1 无日志 seam，交叉核对告警随 §4.11 观测在 Stage 2 落地；本阶段只以目录事实为准。
- 双保险硬拒：文件名 `-archive.md` 结尾，或 META `archive:true`，或内容为 `[DELETED]`，或文件不存在/为空/非 v2 布局（三标题首次序缺失）。
- 顺序规范化：按 `(created asc, filename asc)` 重排为 A≺B；拼接顺序、`[DELETED]` 顺序、幂等键一律以规范序为准。换序调用必须得到逐字相同的 C 与相同 key。
- `target`：Stage 1/2 由 CLI 或调用方指定；Stage 3 才自动派生。C 名必须经 `filename-normalizer.ts` 的 `normalizeSceneFilename` 同源校验：只允许单段 `.md` 文件名，禁路径分隔符/绝对路径/`..`/Windows 保留名/非法字符/尾点空格/超长；不得以 `-archive.md` 结尾，不得等于 A/B，不得与现有活动或归档文件同名（同名且 journal 无本 key → `MERGE_SKIPPED(target_exists)`）。
- Stage 2 的调用方是 L2 钩子：它用 `deriveMergeTargetName(A,B)` 生成**仅用于 plan 校验的占位 target**，不写盘、不取锁、不构成 Stage 3 命名承诺（见 §4.13）。

### 4.3 C 的拼装（全文，不投影）

1. 只接受 v2 布局：`## 要点`、`## 事实`、`## 活动` 三个标题的**首次出现顺序**必须为 要点→事实→活动；缺失或首次乱序 → `MERGE_REJECTED(unsupported_layout)`。**允许重复 v2 标题**（2026-11-19 18:4x 实测 12/23 活动文件含重复，全部是 `## 活动` 同段重入，含 3 个 Stage 1 正例：AIHOT 3 个、v2重构 2 个、h-family 2 个）：归一化时逐行扫描，凡命中 `V2_HEADING_RE` 的标题行只切换/保持当前逻辑段、不进入正文；已出现过的非当前段标题再次出现 → `MERGE_REJECTED(unsupported_layout)`。段内其它非 v2 `##` 行（如 h-family 活动段内 8 个）是正文，原样保留。不调用 `toV2Format` 迁移 v1。
2. 新 META：`created=min(createdA,createdB)`、`updated=now(ISO)`、`heat=max(heatA,heatB)`（D5）、`summary` 不手写——由 `syncV2MetaSummary` 从 C 的 `## 要点` 派生；不扩展 META 字段（`formatMeta` 只输出四键）。
3. 正文：按段序 `要点 → 事实 → 活动`，每段内 A 的全部行在前、B 的全部行在后，各保持原相对顺序；空段保留标题行。A 的非 META 序言（首个 v2 段标题前的非空行）原样放在 C 的 META 之后、`## 要点` 之前；B 的非 META 序言一律 `MERGE_REJECTED(unsupported_layout)`。
4. **除重复 v2 标题行归一化外不做行去重**、不做摘要、不折叠批次叙事；`[SUPERSEDED ...]` 行原样迁移。唯一新增是 META 与三个段标题。
5. 写入前对 C 自身再做一次 `findV2Sections` + `parseSceneBlock` 校验；C 必须仍是 v2 三段。
6. 落盘时再调用一次 `syncV2MetaSummary`，确保与 `storage-tools.ts:296-301` 的写路径同口径；不得只写 META 而让要点段与 summary 不一致。

### 4.4 守恒断言（fail-closed）

- **锚点多重集（只算正文，不算 META）**：`anchors(X) := extractAnchorIds(parseSceneBlock(rawX, nameX).content)`，即 META 块与三个段标题之外的正文；对每个 id 断言 `count_C(id) = count_A(id) + count_B(id)`。**不得把 A/B 的 META.summary 计入**：C 的 summary 由 `syncV2MetaSummary` 重算并截断 300 字（`scene-format-v2.ts:165-179`、`scene-format.ts:123-133`），A/B summary 内的锚点副本不会进入 C；2026-11-19 18:5x 对 ≤60K 的 76 对复算，全文件口径有 6 对会稳定误拒。
- **summary 单独断言**：`C.meta.summary === syncV2MetaSummary(formatSceneBlock(C.meta, C.content))` 的幂等结果（等价于 `normalizeSceneSummary(extractV2Gist(C.content))`）；summary 不参与锚点守恒。
- **允许重复锚点**：草案 §6.3/6.4 的「输入自身/跨输入重复即拒绝」不可执行——2026-11-19 18:2x 实测 23/23 活动场景均含重复锚点（TDAI 1268 实例/273 重复 id、S3S4 927/213、it-ops 1299/214；第三对 OpenCode+v2 共享 1 个 id）。拒绝规则会使工具对所有真实文件失败，故改为「多重集相加、全部保留」，只记 `duplicateAnchorIds` 指标；Stage 3 自动选对时加阈值（重复实例占比 >10% 拒绝）。
- **正文行多重集（精确和）**：剔除 META 块行与**所有** v2 标题行（含重复）后，对每个非空正文行断言 `count_C(line) = count_A(line) + count_B(line)`；A/B 同现一行时 C 必须保留两份。2026-11-19 18:5x 实测 ≤60K 的 76 对中 15 对存在跨输入重复行，「每文件 ≥」会漏检。
- 任一断言失败 → `MERGE_REJECTED(anchor_mismatch|body_mismatch)`，零写入。写侧守卫（`storage-tools.ts:129-174`、`supersede.ts:175-179`）只作第二道防线，不替代多重集断言。

### 4.5 字符帽预检

- 口径订正（2026-11-19 18:3x 已核）：`checkSceneCharCap`（`utils/scene-char-cap.ts:39-53`）测的是**裸 `content.length`，不扣 `[SUPERSEDED]`**；扣失效行的是 `checkSceneCharCapWithSupersede`（`utils/supersede.ts:187-205`）。Stage 1 双判必须分别调用这两个函数，不能把两者混为一谈。
- 硬帽双判：`checkSceneCharCap(C, sceneCharCap)` 与 `checkSceneCharCapWithSupersede(C, sceneCharCap)` 均为 null（当前 500,000）才允许落盘；写入的是裸文件，故裸长度也必须 ≤cap，即使失效行腾出余量也不放宽。
- 阶段 1/2 额外域：`A.content.length + B.content.length ≤ 40,000` 且 `C.length ≤ min(60,000, floor(sceneCharCap*0.9))`；`A/B.content` 取 `parseSceneBlock().content`。
- 阶段 3 候选域可放宽到 A+B ≤ 60,000，C 仍 ≤60,000；任何情况下不因 cap 上调而放宽 C 的 60K。
- 配置 fail-closed：`mode≠off` 时若 `sceneCharCap<=0/undefined/NaN`，直接拒绝启动/合并；`checkSceneCharCap` 对 cap≤0 返回放行（`scene-char-cap.ts:43`），不能把「帽关掉」误当安全。
- 头部 4 场景（TDAI治理 / PR战役-分片 / PR战役-S3S4 / it-ops架构）禁用名单硬编码在配置；即使字符数漂移也不自动解禁。

### 4.6 journal 与事务状态机

- 位置：`<dataDir>/.metadata/merge-journal/<key>.json`；preimage 放 `<key>/A.pre.md`、`B.pre.md`；临时 C 放 `<dataDir>/.metadata/merge-tmp/<key>.md.part`（**不以 .md 结尾**，避免 `syncSceneIndex` 的 `readdirNames(...,".md")` 收到；`scene-index.ts:132-138` 已核）。
- journal 字段：`version, key, inputs{a,b:{filename,sha256,chars,anchors,meta}}, concatOrder, target{filename,sha256,chars}, stage, attempts[], pid/host, startedAt/updatedAt, metrics, error, recovery`。
- stage：`prepared → c_persisted → a_deleted → b_deleted → done`，异常为 `failed` / `rolled_back`。journal 必须在写 C **之前**落盘（含 preimage）；写 journal 用 `<key>.json.tmp` + `renameWithRetry`（`utils/checkpoint.ts:173-189`；仅对本地 `fsMod` 的 EPERM/EBUSY 重试，行号以 18:3x 源码为准）。
- 次序（生产 Stage 3，仅本地 fs）：preflight（零写）→ journal(prepared)+preimage → 写 `.part` → fsync+复读校验 → `renameWithRetry`（本地 fs rename 为原子替换；storage/COS 模式见下条直接拒绝）进 `scene_blocks/<target>` → journal(c_persisted) → 重读 A 并比对 sha256 → 写 A=[DELETED] → journal(a_deleted) → 同法删 B → journal(b_deleted) → 交给本轮 Phase5 清理 A/B（C 不参与）→ **同轮** Phase6 `syncSceneIndex`（`scene-extractor.ts:585-588`，不是「下轮」）→ journal(done)。Stage 1 影子 CLI 不跑生产 Phase5/6：在 journal(b_deleted) 后**显式 unlink A/B**（等价 Phase5 清理）→ 自行 `syncSceneIndex` → journal(done)；若 kill 在 b_deleted，恢复扫描按同一次序补完（见下条）。
- 冲突策略（P0-3）：只有 A/B 当前内容与 journal preimage 逐字节一致，才允许写 `[DELETED]`；若当前内容不是本事务写的 `[DELETED]` 且 sha256 与 preimage 不一致，判定外部并发写（另一轮 Phase5/工具 edit）：停止，保留 C 与 A/B 现场，`MERGE_CONFLICT`+ALERT，**禁止用 preimage 覆盖**。若当前内容精确等于 `[DELETED]` 且 journal 记录本事务已写，才可按 preimage 回滚；回滚后校验 A/B 与 preimage 逐字节相等。
- 恢复扫描触发点：网关启动后首个 L2 前、每次 merge 前、每轮 Phase4 后；状态分支与 C 存在性判定见下两条。
- 无 journal 的孤儿 C：Stage 1 不自动判定/不自动删（正常场景与孤儿 C 无法零成本区分）；恢复扫描只处理 `merge-journal` 内条目。C 已写且 A/B 未删且无恢复动作 = 24 活动场景，必须 `MERGE_FAILED` + ALERT，不允许静默成功；孤儿 C 对账算法列入 Stage 3 前另票。
- 原子性分级（已核缺口）：`StorageAdapter.rename`（`core/storage/adapter.ts:243-249`）自述 3-step get→put→delete **非原子**；`LocalStorageBackend.putObject`（`core/storage/local-backend.ts:91-96`）是 `mkdir` + 裸 `writeFile`，**无 fsync、无 tmp**。因此：Stage 1/2 **固定本地 fs**（`dataDir` + `fsMod`），journal/preimage/C 三处 `fsync` 后才 rename；`executeMerge` 在 storage/COS/rowfs 模式直接返回 `MERGE_UNSUPPORTED_ATOMICITY`，不得以 journal-only 冒充可收敛。Stage 3 若要在 storage 模式跑，必须先补原子写原语或另行批准。
- 恢复扫描（持 merge 锁）分支：C 不存在或为空文件 → 按 `prepared` 清理/标 failed；C 存在且 sha256 与 journal 匹配才进入后续 stage（`putObject` 无 fsync，空文件必须当 prepared）；`c_persisted` → 补完标 A/B 或回滚；`a_deleted` → 补完删 B 或回滚恢复 A；**`b_deleted` → 校验 C sha256 后 unlink A/B（若仍存在）→ syncSceneIndex → journal(done)**；`done` → no-op。任何分支失败保留现场并 ALERT。

### 4.7 跨进程锁

- `<dataDir>/.metadata/merge.lock`：本地 fs 的 `O_EXCL` 创建（`StorageAdapter` 无此原语）；内容 `{owner,pid,host,ts,ttlMs,key}`；TTL 300,000ms、心跳 30,000ms；已存在时等待 5,000ms，仍失败 → `MERGE_SKIPPED(lock_busy)`。仅 `stateBackend=local`（tdai-gateway.yaml:14）前提成立；非 local/多网关共享后端不承诺互斥。
- 过期锁可接管；接管前重读一次锁内容，避免双接管。Windows 的 pid 复用/权限行为未取证：不把「pid 不存在」作为唯一接管依据，优先按 TTL+最后心跳判断，接管仍须 CAS+owner token。
- 锁序：Phase4 从 `scene-extractor.ts:410` 开始；:359-377 是 Phase4 前的 LLM 内存快照、不持锁。Stage 3 钩子位于 Phase4 后/Phase5 前，此时 L2 运行在 worker 的 profile 串行作用域内（`pipeline-worker.ts:577`），**并不持有 checkpoint 锁**（`checkpoint.ts:518-525` 仅备份/清理，无锁）；merge 锁是**叶子锁**，持锁期间不得再取 worker 作用域锁/checkpoint 锁，恢复扫描同样不取，避免锁序反转。Phase5 与工具 edit 的排他域由 Stage 3 执行路径与门禁保证。
- 恢复扫描必须持 merge 锁执行；两进程同时恢复同一 journal 只允许一个生效。
- 接管必须用 `rename`/CAS + owner token；释放前校验 token，不得 unlink 别人的锁。
- Stage 3 排他域：Phase4 后至 Phase5 前不得有另一轮 Phase5 或工具 edit 同时写 A/B；否则 merge 锁保护不了，必须让 Phase5 取同一锁或串行化轮次。
- Stage 1 影子 CLI 同样取锁（即使是临时 dataDir），以验证锁语义。

### 4.8 幂等

- `key = sha256("merge-v1|" + sortedNames + "|" + sha256(A) + "|" + sha256(B) + "|" + concatOrder)`；换序调用 key 不变；**key 不含 target**（target 由调用方指定，但同对输入换 target 不得产生第二个 C），target 存入 journal 供审计。
- `stage=done` 且 journal 记录的 target **存在且非空** → `MERGE_SKIPPED_IDEMPOTENT`（调用方换 target 也返回 skip，不得产生第二个 C），零写入。**sha256 强校验只用于非终态 stage**（prepared/c_persisted/a_deleted/b_deleted 的补完判定）；done 之后 C 被 Phase 5 治理（spill/compact/supersede/factArchive）或 LLM 合法改写属正常，按存在性幂等，不得因 sha 变化报 MERGE_CONFLICT（seams P0 修复，见 §4.14）。
- `stage∈{prepared,c_persisted,a_deleted}` → 先跑恢复扫描再返回；`failed/rolled_back` 允许同 key 重试（attempts+1，C 若已存在先校验 sha256）。
- journal 保留最近 200 条或 90 天（先到为准）；failed 保留至解决；GC 只删 journal/preimage，不删 C。**Stage 1/2 不实现自动 GC**：Stage 1 工具默认 off，journal 只由显式 CLI 在隔离 dataDir 产生；Stage 2 shadow 钩子零写，不调用 GC。`gcMergeJournals`（200 条/90 天、failed 永不删）已随 S01 实现，由 Stage 3 执行路径或 CLI maintenance 在持 merge 锁时调用，不在本轮接入。

### 4.9 配置（Stage 1 新增，默认关闭）

`persona.mergeScene`：
- `mode: off | shadow | on`（默认 off；Stage 1 只允许 off/shadow）
- `pairCharLimit: 40000`、`cCharLimit: 60000`
- `lockTtlMs: 300000`、`heartbeatMs: 30000`、`lockWaitMs: 5000`
- `journalDir: .metadata/merge-journal`（相对 dataDir）
- `headScenes: [4 个头部文件名]`（显式名单；须为 `normalizeSceneFilenames` 规范化后的名字，`filename-normalizer.ts:143`；比较前对输入也做 `normalizeSceneFilename`，否则禁用失效）
- `maxPairsPerRound: 1`（Stage 3 用）

地基落点：`PersonaConfig` 在 `MemoryCore/src/config.ts:156-257`、`parseConfig` 的 persona 段在 `:904-945`（非法值 throw 约定同处）、唯一 `SceneExtractor` 装配点在 `MemoryCore/src/utils/pipeline-factory.ts:991-1048`（`sceneFactArchive` 透传同款防线）。配置与 `maxScenes`/`sceneArchive`/`sceneFactArchive` 同层；改动 yaml 后须重启网关（8420 无 HTTP shutdown，仅 SIGINT/SIGTERM，重启前确认 L2 空闲）。Stage 1 只加配置 schema 与默认值，不改变现有运行行为。

### 4.10 触发（分阶段）

- Stage 1：仅 CLI/库调用；不接 L2 提示词、不接 Phase4/5。影子轮次在隔离 dataDir 内按 `plan → executeMerge(file 级)` 跑完整轮；executeMerge 在 journal(b_deleted) 后**显式 unlink A/B**（不等生产 Phase5）→ 自行 `syncSceneIndex` → 导航重算；收敛断言 = 文件 22 + 索引 22 + 导航 22、无 `.part`/`[DELETED]` 残留。
- Stage 2：Phase4 后/Phase5 前钩子 + `mode=shadow`，只选对、plan、日志，零写入。
- Stage 3：同钩子 + `mode=on`，限定域（A+B≤60K、非头部、非归档、每轮≤1 对），需独立批准；Stage 3 允许改 `scene-extractor.ts` 的 Phase5 跳过 C/Phase6 顺序，但须另立票并重审，不再受「唯一新模块」约束。
- L2 工具入口可并存，但默认不注入提示词（自治诉求要求代码强制，不依赖模型自觉）。

### 4.11 观测

Stage 1 以 `plan.metrics`、`executeMerge`/`recoverMergeJournal` 返回值与 CLI 单行 JSON 交付；Stage 2 已有 logger seam，钩子 metric 见 §4.13，字段为实现子集（不再承诺 `anchorLost`/`linesConserved`/`capRatio`——守恒断言已由 `planMerge` 直接拒绝）：

- `metric=l2_merge`（Stage 2 已实现）：mode/result(planned|rejected|skipped|error)/code/key(前 12 位)/pair/target/charsA/charsB/charsC/anchorsIn/anchorsOut/readViewChars/sharedAnchors/scanned/elapsedMs；禁正文/summary/锚点 id 列表。超预算与异常一律 warn。
- 锚点全局 diff/ALERT 推迟到 Stage 3：Phase 5 的合法删场景与 `preExtractSnapshots`（Phase 4 前按 index 的内存快照）口径冲突会稳定误报；Stage 2 shadow 只对单次 planned A/B 做正文锚点守恒（复用 `planMerge` 已有断言），不实现全局 diff、不停用工具。
- journal stage 迁移逐条落日志；`MERGE_RECOVERED` 计数。

### 4.12 回滚

- 关闭：`mode=off` + 重启 → 钩子不再进入；已合并 C 不回滚（内容合法、守恒）。
- journal 回放：由 `recoverMergeJournal` 等价提供（未提交事务回到 3 场景或补完到 2 场景，preimage 恢复 A/B）；Stage 1 不提供独立 `--rollback` CLI flag；已完成合并的 C 不回滚（首条）。
- 外部全量快照优先（`scene_blocks` + `scene_index.json` + checkpoint + persona.md + SHA256SUMS），仓库内 `.backup` 只有 10 轮/108 分钟且不恢复，不能当唯一回滚件。

### 4.13 Stage 2：L2 钩子（shadow）

- 位置：`scene-extractor.ts` `extract()` Phase 4 成功之后、Phase 5 之前（约 :466）。**fail-soft**：钩子任何异常只 `logger.warn`，不得影响 L2 抽取结果/返回码。
- 启用：仅 `persona.mergeScene.mode === "shadow"` 时进入；`off` 零调用零 I/O；`on` 在 Stage 3 已解析期放行（须非空 `candidatePairs` 且 `maxPairsPerRound=1`，见 §4.14）。钩子不读提示词、不注入工具，自治靠代码。
- 输入：以 `scene_blocks` 目录事实为准，跳过 `-archive.md`、META `archive:true`、`[DELETED]`/空、非 v2 布局文件。不信任 `scene_index` sidecar（可能 stale/含软删）。读取必须与 Phase 5 同款双模式：有 `this.storage` 时用 `storage.readdirNames(StoragePaths.sceneBlocksDir, ".md")` + `storage.readFile`（只读），否则用 `node:fs/promises`。**不得以 `this.storage` 非空推断「非本地」**：`gateway/server.ts:704-715` 对 standalone/local 也无条件注入 `LocalStorageBackend`，在役网关该字段恒非空；执行器（Stage 3）的原子性门禁只看 `backend.type === "local"`。shadow 下禁止任何 storage 写。
- 选对（确定性，无 LLM/随机）：
  1. 配置 `candidatePairs` 非空时按配置顺序取第一对可用者（两文件都存在、非头部、非归档、v2、非空、非 `[DELETED]`；可用性与自动选对共用 `isMergeShadowCandidate` 同一过滤口径，不合格对继续试下一对）；列表非空但无一可用 → `result=rejected code=candidate_unavailable`，**不回退**自动选择（白名单是显式意图）。每轮最多 1 对。
  2. 否则 `selectMergeCandidate` 自动选择：候选为两两组合（非头部/非归档/v2/均非空），过滤 `A+B > pairCharLimit`；评分 = 共享锚点 id 数（`extractAnchorIds` 交集）降序 → A+B 字符升序 → 文件名字典序；共享锚点数为 0 不选（同主题证据）；返回 top1。
- 行为：`planMerge({filename,raw}×2,{config,now,target:deriveMergeTargetName(A,B),sceneCharCap})`；target 是占位，仅过 plan 校验，绝不落盘。成功打 `metric=l2_merge mode=shadow result=planned key=<前12位> pair=A|B charsA= charsB= charsC= anchorsIn= anchorsOut= readViewChars= elapsedMs=`；拒绝 `result=rejected code=...`（anchor/body mismatch 用 warn，其余 info）；异常 `result=error` 只打 `err.message`。**metric 禁输出正文/summary/锚点 id 列表**。**不调用 executeMerge、不取锁、不写 journal、不 sync index、不修改任何文件、不 GC**。整段包硬预算 `MERGE_SCENE_SHADOW_BUDGET_MS=2000`：读取后、选对后、plan 后各检查一次，超时 → `result=skipped code=budget_exceeded`（warn，不抛给 L2）；异常 → `result=error`（warn，只打 `err.message`）。
- GC：**shadow 钩子不调用 GC**（零写契约）。`gcMergeJournals` 已实现，留给 Stage 3 执行路径 / CLI maintenance 在持 merge 锁时调用；shadow 期间 journal 目录本应为空。
- 锚点全局告警：**Stage 2 不实现**。`preExtractSnapshots` 是 Phase 4 前按 index 的内存快照，而 Phase 5 会合法删除场景，二者口径不一致会稳定误报；锚点守恒改为 Stage 3 在 planned A/B 的 preimage 上做，并对存活文件 diff（见 §4.11）。
- 配置新增：`candidatePairs?: Array<{ a: string; b: string }>`（最多 8 对；两名字**先拒路径**再经 `normalizeSceneFilename`，拒绝 `-archive`、自配对、无序重复；`parseMergeSceneConfig` 内与 `headScenes` 求交，命中头部名解析期 throw；Stage 2 白名单，Stage 3 可作 override）。
- 测试 seam：selector 纯函数；GC 用临时 dataDir；extractor 集成用 fake `llmRunner`（返回 "done"）+ 临时 dataDir + logger 捕获，**opts 必须显式传 `mergeScene`**（否则 off 分支掩盖装配漏传），断言 metric 出现；零写断言分两种口径——直调私有 `runMergeShadowHook`（不跑 Phase 5）时要求 dataDir 整树 sha256 全等；跑完整 `extract()` 时只要求 `scene_blocks` 子树逐字节不变且无 merge 产物（Phase 5 写 `.metadata` 是合法行为，不算钩子写入）。装配级两层：`pipeline-factory.merge-scene.test.ts` mock 构造器只验 `SceneExtractorOptions` 透传；`pipeline-factory.merge-scene.integration.test.ts` 不 mock，走真实工厂装配 → 真实 `extract()` → Phase 4.5 钩子，断言 `result=planned` metric（门禁 A 证据）。
- Stage 2 门禁（A-G）：A 网关真实装配级 metric（`pipeline-factory` 传参 + 不 mock 的集成测试：真实工厂装配 → 真实 `extract()` → `l2_merge result=planned`）；B 直调私有 `runMergeShadowHook`（不跑 Phase 5）后 `dataDir` 整树（含 `.metadata`）sha256 全等，同目录完整 `extract()` 对照只要求 `scene_blocks` 子树逐字节不变且无 journal/.merge-tmp/.part；C backend 矩阵（`LocalStorageBackend` 读取正常、无 storage 的 fs 路径正常、不得以 storage 非空判不支持）；D 确定性（同输入两次 selection/metric 相同）；E 故障注入（candidatePairs 不可用 / readdir throw / 超预算 → L2 结果 success 不变，`scene_blocks` 子树零写）；F 生产 23 场景只读副本整轮 <5s、≥1 对 planned 且 metrics 字段完整、`scene_blocks` 逐字节不变；G 全量回归全绿（沙箱 HOME）+ 变异覆盖 selection/candidatePairs/装配/预算分支 ≥8 条；报告带源码 sha 且 `sourceStable`。Stage 2 通过后才进 Stage 3（`mode=on` 生产开关用户已口头批准，仍以门禁通过为前提）。
- 2026-11-20 00:05 CST Stage 2 门禁首跑（报告 `reviews/merge-stage2-shadow-gate-20261119.json`）：verdict=pass，A–G 全 pass，G 为 137 files / 1632 tests 全绿，F 自动选对 `AIHOT晨报-自动化发送与免费模型观察.md` + OpenCode 场景（charsA=18,492 / charsB=12,158 / charsC=31,045 / anchors=90 / 158ms），生产 profile 462 文件 sha256+mtime 前后全等，`sourceStable=true`，总耗时约 27.9s。
- 2026-11-20 00:3x CST S05 双审修复后门禁重跑（同一报告路径已刷新）：verdict=pass，A–G 全 pass——A 含真实工厂装配 → 真实 extract 的 `planned` 集成用例；G 为 138 files / 1637 tests 全绿 + 变异 12/12 killed（survived/invalid=0，originalSha 与当前源码一致）；F 仍自动选对同一对（charsA=18,492 / charsB=12,158 / charsC=31,045 / anchorsIn=90 / anchorsOut=90 / 157ms）；生产 profile 462 文件 sha256+mtime 前后全等，`sourceStable=true`，总耗时 35.8s。

### 4.14 Stage 3：mode=on 执行路径（2026-11-20 立项；门禁 H 冻结复跑 PASS（A–L + M/N），H-7 回归 138/1652 绿，双审 P0/P1 清零；2026-11-20 01:30 生产首轮 merged 23→22，01:53 R2 rejected candidate_unavailable 且 0 ALERT，02:11 R3 验证 done+改写 C 恢复 noop 且 0 ALERT，`mode=on` 生效中）

- 启用：`persona.mergeScene.mode="on"` 解析期放行（删除 Stage 1 的解析期拒绝）；**on 必须同时配置非空 `candidatePairs`**（显式白名单，解析期 fail-closed），`maxPairsPerRound` 只允许 1（>1 解析期拒绝）。Stage 3 首轮不做自动选对，防止生产意外合并。
- 位置与顺序：复用 Stage 2 钩子位置（Phase 4 成功 → Phase 5 前）。on 分支先 `recoverMergeJournal`（收敛上一轮中断），再选对 → `planMerge` → `executeMerge`；每轮最多 1 对；不循环、不追赶。
- dataDir 与 backend：执行器使用 `this.dataDir`（生产 profile 目录）与 `backend=this.storage?.type`（无 storage 视为 local）；非 local（COS/rowfs）→ 不执行，`result=skipped code=unsupported_backend`（warn），L2 继续。`executeMerge`/`recoverMergeJournal` 新增**仅内部用**的 `allowProductionDataDir?: true`（缺省 false；类型只接受字面量 true）：CLI 恒不传，只有 extractor on 分支传 true；生产目录保护对 Stage 1 CLI 不变。
- 事务：完全复用 Stage 1 内核（preimage/journal/锁/崩溃恢复/幂等），钩子不自行实现写序。成功后 C 已落盘、A/B 已 unlink、索引/导航已 sync。**同轮 Phase 5 必须跳过本轮合并产物 C**（seams P0：生产 yaml 的 sceneArchive/sceneFactArchive/sceneCompaction/factSupersede 会改写 C，使 done journal 的 sha 与现状不符）——钩子把 merged target 记入实例字段，Phase 5 文件级空分支跳过 spill/compact/supersede/factArchive，下轮恢复治理；`done` journal 的恢复判定放宽为「目标存在且非空即 noop」，sha 强校验只用于非终态 stage。
- fail-soft：单轮任何异常 → `result=error` + `ALERT=l2_merge_error`（warn），不改变 L2 extract 的 success、不重试本轮；未完成事务由下一轮 `recoverMergeJournal` 收敛。锁忙 → `result=skipped code=lock_busy` 不阻塞 L2。
- metric：`metric=l2_merge mode=on result=merged|skipped|rejected|error code= key(前12位) pair target charsA/B/C anchorsIn/Out readViewChars journalStage message elapsedMs`；规模字段只在 result=merged 输出；skipped 带 `code=idempotent|retry_completed|recovered|MERGE_LOCK_BUSY` 与 journalStage；白名单两文件被消费后的 `candidate_unavailable` 降为 info（常态），异常/超预算/锁忙 skipped 只 warn；禁正文/summary/锚点 id 列表。
- 命名：target 由 `deriveMergeTargetName(A,B)` 派生（排序 stems + `-合并.md`），落盘前经 `normalizeSceneFilename` 校验；Stage 1/2 的调用方指定 target 语义保留。
- GC：on 钩子不调用 `gcMergeJournals`（避免与在途事务竞态）；GC 由 CLI maintenance 在持 merge 锁时执行。
- 生产启用（用户 2026-11-19 已全权批准）：离线副本门禁 H 全绿 → 备份 `scene_blocks`/`scene_index.json`/`persona.md`/journal → yaml 增 `mergeScene: {mode:"on", candidatePairs:[真实对]}` → 确认 L2 空闲后重启网关 → 观察首轮 metric、场景数 23→22、索引/导航一致；异常回滚 `mode:"off"` + 重启（已合并 C 不回滚，preimage/journal 留存）。
- 门禁 H：1) 生产副本 23 活动 + 旁观：on 一轮收敛 22、索引/导航 22、旁观 21 逐字节不变、journal=done、metric=merged；2) 独立 verifier 校验 C 结构/锚点正文守恒/读视图；3) 非 local backend → unsupported_backend 零写；4) 生产目录保护：allow=false 时 `MERGE_PRODUCTION_DATADIR`，allow=true 仅内部路径；5) kill -9 在 hook 内 execute 各阶段，下一轮 recover 收敛且不产生第二 C；6) 锁忙/并发不阻塞 L2；7) 全量回归 + 变异 ≥8（on gate/candidatePairs 必填/allow 标志/backend 分支/fail-soft/metric）；8) 双代理审 P0/P1 清零；报告带源码 sha 与 sourceStable。
- 2026-11-20 01:17 CST 门禁 H 冻结复跑（报告 `reviews/merge-stage3-gate-20261120.json/.md`，源码 sha merge=5c700bd5… extractor=217634a1… config=ae666d07… pipeline-factory=4b99024a…，`sourceStable`）：verdict=pass，A–L 全 pass，并新增 M（done journal 且 C 被改写后再跑一轮：rejected candidate_unavailable、无 `ALERT=l2_merge_error`、journal 仍 done、C 逐字保留）、N（Phase 5 四治理分支对 merged target 零调用、对其他场景有调用）；totalElapsedMs=9689。J kill -9 四点 prepared（trigger=lock，observedStage 空）/c_persisted（observedStage 越过为 a_deleted）/a_deleted（observedStage=a_deleted）/b_deleted（observedStage=b_deleted）均 killed=true、attemptsUsed=1，恢复后 active=22、C 唯一、journal=done、lockReleased=true、无 `.part/.merge-tmp/.json.tmp`（含 `.backup` 递归，快照已过滤原子临时文件）；K 生产 462 文件 sha256+mtime 全等；A metric charsA=12158/charsB=12957/charsC=25509/anchorsIn=Out=88/readView=18000/127ms。
- 2026-11-20 01:18 CST H-7：沙箱 HOME 全量 `npx vitest run` → 138 files / 1652 tests 全绿（10.97s）；变异 14/14 killed、survived/invalid=0、originalSha=restoredSha=当前源码（`reviews/merge-stage3-mutation-20261120.json`）。
- 回滚与观测：见 §4.12；生产 on 首轮成功后保留 journal 与备份，7 天观察期内不出问题再 GC。
- 2026-11-20 01:22–01:31 CST 生产启用实跑：备份 `C:/Users/28951/.memory-tencentdb/memory-tdai/backup-merge-stage3-on-20261120-0121`（38 个 .md + persona.md + scene_index/checkpoint + tdai-gateway.yaml.pre-on + SHA256SUMS.txt 42 行）；yaml 在 `persona.maxL2Batch` 后插入 `mergeScene: {mode:"on", candidatePairs:[AIHOT晨报-自动化发送与免费模型观察.md, 技术研究-Trending日报自动化与开源生态.md], maxPairsPerRound:1}`（改后 20,574 bytes / 345 行，探针按 `doc.memory.persona` 解析得 mode=on、pairs、cap 500000、target 不存在）；旧网关 server PID 28908（wrapper 38708）停止后按 `start-gateway-hidden-v3.bat` 重启，新 server PID 33080，/health ok。L2 timer 01:25:31 推进 +90s 后 01:27 启动首轮 L2 抽取，01:30:12 metric `mode=on result=merged`：key=54d15daff7f2、pair=AIHOT晨报-自动化发送与免费模型观察.md + 技术研究-Trending日报自动化与开源生态.md、target=AIHOT晨报-自动化发送与免费模型观察-技术研究-Trending日报自动化与开源生态-合并.md、charsA=12158 charsB=12957 charsC=25509、anchorsIn=88 anchorsOut=88、readViewChars=18000 sharedAnchors=0、journalStage=done、elapsedMs=416。结果：active 23→22、archive 15（total 37）；C 落盘 48,157 bytes / 134 行 / sha256=14a9b1ce…；A/B 已 unlink；journal stage=done（阶段序列 c_persisted→a_deleted→b_deleted→done，pid 33080，anchorLost=0、bodyLinesLost=0、duplicateAnchorIds=16、pairChars=25115）；scene_index 22 条（含 C、无 A/B）、persona.md 导航 22 个 `### Path:` 且含 C；live `scene_blocks` 无 .part/.merge-tmp/.json.tmp；`ALERT=l2_merge_error` 计数 0；/health status=ok。
- 2026-11-20 01:53 CST 生产 R2：`metric=l2_merge mode=on result=rejected code=candidate_unavailable scanned=37 message="白名单两文件已不齐（合并消费后为常态）" elapsedMs=103`，`ALERT=l2_merge_error` 全日志计数 0、metric 计数 2、active 保持 22。R2 的 Phase 5 已将 C 改写为 41,274 bytes / 111 行 / sha256=4ed4d274…（done journal 记录的 14a9b1ce… 已不符），构成 seams P0 生产现场：下一次 L2（R3）recover 按 §4.8 放宽后的 done 语义（目标存在且非空即 MERGE_SKIPPED_IDEMPOTENT）处理，不得 ALERT（watcher 待命验证）。
- 2026-11-20 02:11 CST 生产 R3（seams P0 在生产现场验证通过）：L2 timer 02:07:39 推进 +90s → 02:09:09 enqueued，02:11:52 metric `l2_merge mode=on result=rejected code=candidate_unavailable scanned=38 message="白名单两文件已不齐（合并消费后为常态）" elapsedMs=67`；`ALERT=l2_merge_error` 全日志仍为 0（metric 计数 3）。恢复侧：`recoverMergeJournal` 对 stage=done 且 target 存在非空按 §4.8 noop——journal 保持 stage=done、`target.sha256` 仍为旧的 14a9b1ce…（未被改写也不报错），C 实测 41,274 bytes / sha256=4ed4d274… / mtime 01:53:17 未被触碰（未回滚），active 保持 22、total 38、无 .part/.merge-tmp/.json.tmp、无 merge.lock 残留；scene_index 22 条、persona.md 导航 22 个 `### Path:`；/health status=ok。结论：Phase 5 对合并产物的合法治理不再触发永久 ALERT/阻塞新合并，seams P0 修复在生产成立。

## 5. Testing Decisions

选择三个 seam，均为现有高层能力，不引入新测试框架：

- 测试文件旁置 `src/core/scene/scene-merge.test.ts` / `.execute.test.ts` / `.recovery.test.ts`（vitest include `src/**/*.test.ts`）；executeMerge/recoverMergeJournal 用隔离临时 dataDir 的真实本地 fs（原子性/崩溃语义必须在真 fs 演练；Stage 1 本就固定本地 fs），另可注入 `fsMod` 做崩溃点；变异测试用手工 mutant（不新增 stryker 等依赖），门禁脚本逐条记录红→绿。

1. **纯函数 seam**：`planMerge` 的输入是字符串与 META，输出是 C 字符串/结构化拒绝；无需 fs。覆盖段序、重复 v2 标题归一化、空段、序言、META 重算、锚点多重集、正文行多重集、cap、命名、幂等键，以及重复锚点（真实数据存在）。
2. **临时 dataDir + fsMod seam**：真实本地 fs 的隔离目录，按需注入 `fsMod` 计数/挂起；覆盖 journal 各 stage、锁忙、目标存在、写帽拒绝、[DELETED] 守卫、恢复补完/回滚（含 b_deleted）、外部改写冲突、索引同步失败。
3. **临时 dataDir CLI seam**：复制真实候选文件到隔离目录，跑完整 CLI；断言生产 `scene_blocks` 的 sha256/mtime 全等。

Stage 1 门禁（全部满足才可进 Stage 2）：
- 3/3 正例：AIHOT晨报+Trending日报、h-family+实习周报、OpenCode+v2重构。**字符数不硬编码**：每轮从 preimage 现算并断言 `A+B≤40,000`、`C≤60,000`；18:2x 旧值 pair1=25,971、pair2=14,511、pair3=34,784 仅作历史对照（18:5x 复算 pair3 已漂到 32,843）。
- 1/1 必拒：生活与健康+tdai-connect（18:2x=81,380；现算超域即可）→ `MERGE_SKIPPED(over_domain)`，零写。
- 结构断言（不能只看「不抛错」）：C 恰好一个要点/事实/活动且顺序固定、META 四键齐全、`C.summary` 与 `syncV2MetaSummary` 幂等结果一致、无第四类 v2 标题、无非当前段重入；`parseSceneBlock`/`findV2Sections`/`buildV2ReadView` 的宽松返回不算通过。
- 零锚点丢失（正文口径）、零正文丢失（精确多重集）、C≤60,000、C 的默认读视图 ≤40,000（read-budget 80K 口径）。
- 独立 verifier：门禁不得复用被测工具自己的断言；必须从 preimage 另写一份复算锚点/正文/summary，并做「rollback 后 A/B 与 preimage 逐字节相等」演练。
- 单对 <300s；零生产写（生产目录 sha256/mtime 全等，scene_index/persona 不变，`.metadata/merge-*` 零新增；CLI 硬拒生产 dataDir，生产目录加只读哨兵/句柄 watcher）。
- kill -9 注入至少覆盖：journal(prepared) 写入中、preimage 半写、`.part` 写后、rename 前、C 写后、A/B 标记后、恢复扫描中、rollback 中、Phase5 前；Windows 用 `taskkill /F /T` 并验证子进程真死；重启重跑均收敛到 22；同 key 重跑幂等。2026-11-19 实测 11 个时间点全 PASS（journal prepared / part open / part renamed / A、B 原子删除临时文件 open / c_persisted / a_deleted / b_deleted / unlink A / unlink B / done）。
- 变异测试 ≥15 条先红后绿：删锚点行、改锚点 id、复制锚点行、跨输入重复行删 1 份、超帽 1 字符、cap=0、删正文段、坏 journal、两进程并发、目标已存在、归档输入、头部输入、A+B 超域、META 四字段、[DELETED] 守卫、归档含同锚点仍拒、第四类 v2 标题/非当前段重入/乱序 v2 段、target 非法名。
- 回归：MemoryCore 既有 scene/archive 测试全绿；默认 off 时现有 L2 行为逐字节不变。
- 2026-11-19 Stage 1 门禁实跑（报告带源码 sha）：3/3 正例 + 1/1 必拒 PASS；全量 23→22 收敛 PASS（文件/索引/导航均 22、旁观 21 个场景逐字节不变、execute 已 unlink A/B 故 Phase 5 为 no-op）；kill -9 11/11 PASS；变异 19/19 killed（含 retry/幂等新增变异）；生产 profile 462 文件 sha256+mtime 前后全等。
- 2026-11-19 收口回归：沙箱 HOME 下 `npx vitest run` 134 文件 / 1605 例全绿（真实 HOME 会因 tdai-runtime-overrides.yaml 的 `x-opencode-session: ${TDAI_OPENCODE_SESSION}` 空值注入失败，属配置票须沙箱 HOME 的既有约束）；tsc 对本功能 5 个文件零错误。

## 6. Out of Scope

- N2 橙档自动触发与候选选择（同主题 Jaccard 标定、每轮≤1 对）——本 spec 只留接口，另案。
- D4 橙档 CREATE 代码硬闸；头部四场景拆分/折叠（H2/H1）；N3′ 归档可召回（rehydrate/recall/面板只读清单）；R0 布局规范化（已证伪）；`maxScenes` 调整；LLM 摘要/润色；归档文件合并；面板 UI。

## 7. Further Notes

- 双审订正（2026-11-19 18:4x）：已吸收 rev-spec-risk（锚点正文口径、正文精确多重集、冲突回滚、锁/恢复、本地 fs 原子性）与 rev-spec-standards（重复 v2 标题归一化、b_deleted 恢复、Stage1 显式 unlink、输入目录事实优先、journal/锁前提、idempotency key 去 target、孤儿 C 延后）两份审查的 7 个 P0。
- 与草案的实质偏离：①允许重复锚点（草案拒绝，实测 23/23 场景有重复，见 §4.4）；②第三对/必拒的字符数用 18:2x 实测值替换旧值；③明确 Stage 1 不接任何触发，避免「工具存在即被模型调用」。
- 已裁决项：C 名 Stage 1/2 调用方指定、Stage 3 自动派生；接受 summary 300 字截断并记 metric；钩子为主、tool 并存不注入；自研文件锁；阈值固定 40K/60K；白名单仅 Stage 1/2；不扩展 META mergeOf；第三对 OpenCode+v2；半完成态「sha 未变→补完，变→回滚」；kill -9 演练仅在影子临时目录。
- 待审项：Stage 3 自动命名的可读性；同主题 Jaccard 阈值标定；`syncV2MetaSummary` 截断导致 C 的 summary 只覆盖 A 要点是否接受。
- Stage 1 收口（2026-11-19 20:0x）：代码审后复核发现 `executeMerge` 成功尾段把 journal.stage 写成 `b_deleted` 而非 `done`，会令幂等 skip 误判、恢复扫描永远重试；已改为 `done`。该缺陷说明「三闸 + 变异」确有价值：变异 M16 因该行从 invalid 恢复为有效变异。
- 红线：不写生产数据、不改归档、不接提示词、不调 maxScenes、不碰 ZCode 正在改的文件；任何「on」或生产写需用户另行批准。
