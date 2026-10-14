# v3 迁移——本地补丁三选一盘点表（Phase 2 交付）

> 基准：repo@upstream-eval（HEAD ece04f5，51 个本地 commit）vs v3-wt@feat/server_team（HEAD badbd21，v2.0.3-beta.1）。
> 三选一：**被吸收**（v3 已有等价物）/ **需重做**（v3 无，迁后要补）/ **不再需要**（功能目标已达成或已撤销）。
> 生成：2026-10-14，探索代理实证 + 源码行号核查。

## 〇、两个推翻交接文档前提的偏差（拍板前必读）

1. **8 个团队修复 PR 全部 OPEN、未进 feat/server_team@badbd21**（gh 实核 2026-10-14：#1439/#1518/#1527/#1519/#1521/#1417/#1423/#1427 均 state=OPEN merged=null，head 分支各自存在）。v3 基线迁移**拿不到这 8 个修复**；要拿需另把 8 个 head 分支合并成本地集成分支（codex/health-report-degraded、codex/codegraph-sync-recovery、fix/1522-acl-check-restricted、fix/1509-claude-code-harness-input、fix/proxy-cc-queued-user-message、fix/issue-1380-conversation-search-messages、pi-adapter/developer-role-compat、pi-adapter/bridge-l1-prefix）。
2. **v3 重写丢失了本地已上线的多项数据质量修复**（详见下表 B/C/D 组）。裸迁 v3 = dedup 回到 fail-open（#1640 痛点复现）、L1 失败轮推进游标（跳过内容）、跨 sid 场景串线 bug 复现、LLM 并发/限流防护全无。

## 一、A 组：LLM 多厂商与分层（9 commit）

| commit | 内容 | 结论 | 依据/迁移处置 |
|---|---|---|---|
| 505badc | 多厂商 activeProvider+providers[] | 需替代 | v3 仅单 baseUrl+model；切厂商=改 yaml 重启（已映射为阶跃直连） |
| a3eabb3 | 多厂商折叠单测+告警 | 不再需要 | 随多厂商实现消失，无对应面 |
| 3274670 | OCR 审查修复 T1-T4 | 不再需要 | v3 LLM 配置面重写，旧缺陷不存在 |
| 3bff053+be628d0 | llm.layers 分层覆盖 | 部分替代 | v3 offload.l1/l2MaxTokens·TimeoutMs 已承接（新 yaml）；**分层 model 不可能**（全层单模型）；disableThinking 无对应 |
| d1ccd6d | list-models.sh 辅助脚本 | 不再需要 | 独立工具，留在旧 repo，需要时手工拷 |
| 98d690e | 运行时 yaml 提交惯例 | 不再需要 | 新 yaml 直接落 v3-wt（git 可回滚） |
| c00899f | L1 日志带厂商/模型归属 | 需重做(低优) | v3 完成日志无 model/provider（pipeline-factory.ts:670）；generation-log JSONL 有 model 字段可查 |

## 二、B 组：LLM 加固（并发/限流/期限，6 commit）——**v3 全无，稳定性回归**

| commit | 内容 | 结论 | 依据 |
|---|---|---|---|
| 8c00003 | llm.maxConcurrency 进程级并发闸门 | 需重做(高优，若留阶跃) | v3 无此键；多子系统叠加调用会再触发厂商并发秒拒 |
| e674e3a | 装配链 splice 丢字段修复 | 需审查 | v3 gateway/config.ts:679-696 仍是 splice 注入 llm→memory.lll 同类机制，须查是否同样丢字段 |
| 87f3c9b | 并发拒绝归类限流 | 随退避族 | 依赖 859d388 |
| 859d388 | 429 指数退避 runner 20-160s/worker 2-6min | 需重做(高优) | v3 无重试退避；免费/限额档高峰风险回归 |
| 0e73459 | 限流重试收敛+硬期限 | 部分替代 | v3 有单次 timeoutMs+AbortSignal.timeout（llm-runner.ts:285）；重试策略须看 offload.maxRetries |
| 7a93b9d+76b621c | llm.callDeadlineMs 整调用硬期限 | 需重做(中优) | v3 无；各层 timeoutMs 即硬期限（AbortSignal），180s 盖死问题不会复现，但整调用预算控制缺失 |

## 三、C 组：dedup/S1/D1/D2/D3（10 commit）——**数据质量核心，v3 回到 fail-open**

| commit | 内容 | 结论 | 依据 |
|---|---|---|---|
| 26de073+f124dec | S1 dedupFailFast fail-closed | **需重做(最高优)** | v3 全链路 fail-open：判定异常→全 store（l1-dedup.ts:190-199）、batchDedup 抛错→storeAllDirectly（l1-extractor.ts:361-364）、解析失败→fallbackStoreAll（l1-dedup.ts:349-351）。#1640 痛点在 v3 完整存在；#1641（我方 opt-in 修复）base=master 未进 v3 |
| b626b4c | Tier1 空召回 FTS 降级+timeout 透传 | 架构吸收+残留 | v3 向量/FTS 双腿并行+RRF（l1-candidate-recall.ts:84-97），空向量腿 FTS 仍可用；**但查重超时硬编码 180s（l1-dedup.ts:167,183），step-5 判定常 >120s 的教训（v2 调 240s）无容器承载** |
| dce061e | D1-b 查重提示词版本开关 | 需重做(低优) | v3 提示词文件不同（prompts/l1-dedup.ts）；金标 A/B 若要在 v3 续跑需适配 |
| 41d9c2b | D3 金标机器（250 对+κ） | 保留(不在网关内) | 评估资产在旧 repo/eval-data，schema 未变可续用 |
| 8ee00b9 | D1-c 金标回放 harness | 保留(不在网关内) | 同上（run-golden-ab.bat 在部署根） |
| 4db48bf+ece04f5 | D2 召回轻修+lexical 灰度 | **需重做(高优，灰度中断)** | v3 无 FTS 超额+词汇重排+指纹兜底；10-14 拍板的灰度在迁移后中断，行为回退到 v3 默认 |
| f0ad3cc | fallback store-all WARN 锚点 | 需重做(低优) | 观测锚点，随 S1 重做一并落 |
| dedupTimeoutMs 配置 | 240s 经验值 | 需重做(高优) | v3 硬编码 180s；阶跃 step-5 判定超 120s 常态下 180s 会放大失败→fail-open 放大重复 |

## 四、D 组：L0/L1 线程治理与游标（5 commit）——**一个正确性 bug 在 v3 复现**

| commit | 内容 | 结论 | 依据 |
|---|---|---|---|
| ed42826 | L0 按 sid 分组+per-sid 场景隔离 | **半吸收：分组✅ 串线❌** | v3 已按 sid 五元组分组（pipeline-factory.ts:456,548）；但 lastSceneName 单键跨组透传（:601,635,661-663）——「乙线拿甲线场景」串线 bug 复现，v2 的 per-sid map 修复需重做 |
| adf734a+8ffabad | L1 组间有界并行（工作池 3） | 需重做(中优) | v3 组间纯串行 for-await（pipeline-factory.ts:610-645）；多会话切片耗时回退为各组之和 |
| 6415c8e | L1 完成日志带 sid | 需重做(低优) | v3 完成日志无 sid（仅 per-group debug 行） |
| c32bc6b | 蒸馏失败不推进游标（#1395 语义） | **需重做(最高优)** | v3 把 LLM 失败当合法空产出并推进游标（l1-extractor.ts:211-217 → checkpoint.markL1ExtractionComplete :669 无条件推进）——失败轮内容被跳过，v2 修复语义完全丢失 |

## 五、E 组：归属护栏（5 commit）

| commit | 内容 | 结论 | 依据 |
|---|---|---|---|
| 00db4ef+695eb8a+b06267f | attributionGuard 三态→最终 off | **不再需要** | 用户 09-25 拍板撤护栏（误杀率 60%）；v3 无此功能恰=off 终态 |
| 3eb7c8b | userIdentityNames 白名单归一 | 需重做(中优，待用户表态) | v3 无白名单配置；第三方姓名可能入「用户（X）」。在役 yaml 配有白名单（何伟健等），说明用户在意 |
| 28abf46 | 提示词姓名归属护栏 | 部分吸收 | v3 提示词已有「用户（[姓名]）」句式约束（prompts/l1-extraction.ts:34,42,48），无归一兜底 |

## 六、F 组：召回（3 commit）

| commit | 内容 | 结论 | 依据 |
|---|---|---|---|
| 0e28458 | IDF 覆盖度优先排序 | **被吸收（机制不同目标一致）** | v3 用 FTS5 bm25() 排序+多 token OR 隐式覆盖（memory-store.ts:995-1005, tokenize.ts:62-99），OR 拼接首位错配的土壤已移除 |
| 1817cc5 | 过召回修复+质量门规则 | 部分吸收 | v3 有 applyRecallBudget 字符预算+小结果集兜底（auto-recall.ts:575-581,854-918）；验收时观察 |
| 2cd4af6 | 单词扫描截断保护 | 需重做(低优) | v3 仅 5x 超采无回捞循环（memory-store.ts:3010,3073） |

## 七、G 组：会话接口（2 commit）

| commit | 内容 | 结论 | 依据 |
|---|---|---|---|
| 5d34fb8 | /v2/conversation/sessions 端点 | **不再需要**（实测无在役消费方） | tdai-workspace/mem-check.ps1/自动化均无调用（2026-10-14 grep 实证）；v3 无此端点，ops 可直查 sqlite 或按需补 |
| 30e58e4 | search 补 session 维度 | 部分吸收 | v3 内部 hit 带 session 维度、请求支持 session_id 过滤（v2-router.ts:947）；API 返回项不带 session 字段（v2-router.ts:993-995） |

## 八、H 组：存储/运维/稳定（7 commit）

| commit | 内容 | 结论 | 依据 |
|---|---|---|---|
| e601281 | idx_l0_user_agent_ts 驱动索引 | 需重做(低优) | v3 无 (user,agent,timestamp) 复合索引（sqlite memory-store.ts:650-659）；一行 DDL 可作本地补丁 |
| b299c87 | 热路径与死代码清理 | 不再需要 | v2 特定清理面，v3 重写 |
| 70055eb | 运维降噪+损坏配置显错+unhandledRejection 兜底 | **需重做(高优)** | v3 无进程级兜底（node ≥15 默认 unhandled rejection 即 crash）；v3 yaml 解析失败反而**静默吞掉回退 env**（gateway/config.ts:609-611 空 catch）——比 v2 更糟 |
| a583c3d | L1 积压搁浅竞态+手动排空端点 | 需审查 | v3 pipeline-manager 重写，buffer 恢复机制不同（30s×5 重试）；需确认同类竞态是否存在 |
| e2bba75 | 空产出轮日志锚点 | **被吸收** | v3 有 l1-empty reason=llm_error 日志（l1-extractor.ts:211-217） |
| e854810 | skill.enabled=true | 配置承接 | 新 yaml 已带 |
| 1132661+f124dec(pipeline) | everyNConversations=5/maxScenes 20 | 配置承接 | v3 同键同语义（探索实证），新 yaml 已带 |

## 九、I 组：安全与基座（2 commit）

| commit | 内容 | 结论 | 依据 |
|---|---|---|---|
| 6187795-#1464 | asset 水平越权回移 | **被吸收** | v3 metadata-service.ts:1234 getAssetForCaller 在位（本机无 asset 表，行为零变化） |
| 6187795-#1385 | knowledge 服务键门回移 | **未吸收（回退）** | v3 /v3/knowledge/* 鉴权上下文未使用（knowledge-handlers.ts `_auth`），管理面绕过隔离；standalone+127.0.0.1 暴露面与 v2 回移前相当，敏感度低但需知情 |

## 十、8 个团队修复在 v3 基线上的覆盖状态

| PR | 修复 | v3@badbd21 现状 |
|---|---|---|
| #1439 | /health 三态化 | 无（两态 ok/degraded，server.ts:1535-1556） |
| #1518 | CodeGraph 同步故障域 | 无 |
| #1527 | ACL 组合矩阵+lazy | 无（metadata-service 有 checkAssetPermission 雏形，但 PR 本体未合） |
| #1519 | CC harness 按 block 过滤 | 无 |
| #1521 | IMPORTANT trailer 收窄 | 无 |
| #1417 | conversation_search 信封空列表区分 | **语义已在**（data.messages 恒存在，v2-router.ts:993-997）——PR 可能只剩测试/收窄 |
| #1423 | Pi provider role 钉死 | 无 |
| #1427 | pi: 前缀共享 helper | 无 |

## 十一、重做优先级汇总（若拍板「v3+重做」路线）

> **2026-10-14 更新：用户拍板路线 B；P0 三项已重做完成并实证**（commit 111c3b7，分支 local/p0-fixes，
> 红→绿 20/20 测试 + 坏端点注入冒烟：任务 3 重试→死信、游标不动、L1 数不变、恢复后补蒸馏；
> checkpoint 兼容性在 v2 生产写入的 30+ sid map 上直接实证）。配置承接 commit 2ca5a7e。

- **P0（数据正确性）**：~~S1 fail-closed + dedupTimeoutMs 可配（C 组）~~✅已重做；~~L1 失败不推进游标（c32bc6b）~~✅已重做；~~per-sid 场景连续性（ed42826 残留半边）~~✅已重做
- **P1（稳定性）**：unhandledRejection 兜底+配置解析显错（70055eb）、并发闸门+429 退避（B 组，若续用阶跃/免费档厂商）、D2 召回轻修重做
- **P2（低优/按需）**：组间并行、L0 复合索引、日志归属（model/sid）、userIdentityNames 白名单、扫描截断保护、金标 harness 适配
- **独立决策**：8 个团队 PR 合并成集成分支（未合入，含维护者仍在改的风险）→ 已拍板：等上游 release 一并收编
