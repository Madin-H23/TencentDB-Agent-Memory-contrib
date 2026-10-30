# 实验分支拓扑（L2 场景治理 · 多方案并行）

> ⚠️ 本文件是分支关系的事实源，防混淆。**在役 develop（8f9db3a）一律不动、不合并**；
> 所有实验代码只存在于 exp/* 分支；最终采纳与否由用户审核后决定。

```
develop (8f9db3a)  ← 在役，禁止合并实验代码
   │
   └── exp/l2-base            ← 实验基线：评分器 + 方案规格 + 本文件
        ├── exp/l2-plan-a-compaction   方案A：确定性离线压实（锚点 100% 保留）
        ├── exp/l2-plan-b-section-read 方案B：read 分段读（offset/limit）+ 提示词按节读
        ├── exp/l2-plan-c-write-cap    方案C：edit/write 后像尺寸帽 + 结构化拒绝
        └── exp/l2-plan-d-summary-index 方案D：场景摘要索引注入（规格先行，后排实现）
```

## 工作树映射

| worktree | 分支 | 状态 |
|---|---|---|
| `D:/Develop/TencentDB-Agent-Memory/exp-wt-base` | exp/l2-base | 评分器 + 规格 |
| `D:/Develop/TencentDB-Agent-Memory/exp-wt-a` | exp/l2-plan-a-compaction | 开发中 |
| `D:/Develop/TencentDB-Agent-Memory/exp-wt-b` | exp/l2-plan-b-section-read | 开发中 |
| `D:/Develop/TencentDB-Agent-Memory/exp-wt-c` | exp/l2-plan-c-write-cap | 排队 |
| `D:/Develop/TencentDB-Agent-Memory/exp-wt-d` | exp/l2-plan-d-summary-index | 排队 |

## 纪律（每个分支的 agent 必须遵守）

1. 只在自己的 worktree 内工作；**不得** checkout / merge / rebase 其他分支；**不得** push；
   **不得**触碰在役树 `v3-wt/MemoryCore` 与 develop。
2. 评测数据（fixtures）在 workspace `D:/Develop/tdai-workspace/exp-l2/fixtures/`，
   **不进 git**（含个人记忆内容）；不得把 fixtures 拷进仓库。
3. 每个方案分支交付：TDD 实现 + 测试全绿 + `scripts/l2-score.mjs` 自评 PASS（A 类）或
   静态门（tsc ≤230 + 相关 vitest 绿）+ 在本文件末尾追加「分支交付记录」。
4. 方案之间不共享代码（各自独立实现），防串味；共用改进一律走 base 分支，由评审决定。
5. 不重启服务、不改 `tdai-gateway.yaml`、不动面板。

## 评测

```
node scripts/l2-score.mjs --fixtures D:/Develop/tdai-workspace/exp-l2/fixtures/scene_blocks [--output <方案输出目录>]
```

硬门槛：锚点保留率 100%、META 结构完整。软指标：压缩比、文件数。

## 分支交付记录

（各分支完成后在此追加：分支名 | commit | 评分 | 一句话结论）

exp/l2-plan-b-section-read | 86a681c | 静态门 PASS（vitest 556/556 全绿，tsc 230 与基线持平 ≤230）| read 支持 offset/limit 字符窗口（默认调用兼容钉 15/15 与旧实现逐字节一致）；两处 read 工具（storage-tools / llm-runner）共用 read-window 纯函数，零语义差；read-budget 计量口径不变（observe 记实际返回 chars 含标注行）；提示词两个 family 各追加第 8 条「大文件分段预览 + oldText 来自已读片段」规则，既有规则零删除。
exp/l2-plan-b-section-read | 6d6a12c | 静态门 PASS（修复后 vitest 651/651 全绿，tsc 230 与基线持平 ≤230）| 按 2026-10-30 交叉评审修复：①P0-C 提示词 write 护栏（两 family 第 4 条改条件式「大范围重写仅当本次已完整读过该文件或文件是新建」+ 第 8 条追加「已存在且未完整读过的文件禁止 write 整体重写（仅限新建与 [DELETED]）；更新一律 edit；残缺视图宁对已读片段 edit 追加，不重构未读部分」，既有规则锚点零删除）；②P1-2 撞顶可见性（第 8 条示例 limit 1500→15000，12000~16000 区间 + 步数预算 ≤15 步 + 优先读文件尾指引；llm-runner steps≥maxIterations 且末步含工具调用 → debug 升级 warn）；③P2 码点边界（read-window 切片端点落在 UTF-16 代理对中间向外扩到码点边界，标注记实际生效窗口，"a👍b🎉c" 全 offset/limit 矩阵 63 例无孤立代理项）。待独立复跑核验。
- exp/l2-plan-d-summary-index | 89e6ef8（实现；交付记录另 commit） | 静态门：vitest 56 文件/506 例全绿（基线 485 只增不减，新增 21：注入 8 + 模拟 13）+ tsc 230=基线（stash 复测零新增）；模拟评测 saving%=92.59%（indexed_cost 126,630 = 索引段 4,577 + 单场景平均 122,053 vs whole_cost 1,708,737，14 场景，fixtures/scene_blocks） | 场景索引注入默认 off 零行为变化（off 输出与基线逐字节一致，sha256 兼容钉 0b06ae16…），开启（persona.sceneIndexInPrompt）时 L2 提示词追加每场景一行「path | heat | summary≤300」紧凑索引（内存 scene_index 直读、零新增 I/O），两个 L2 read 工具 description 追加按需读取引导；模拟上「索引+定向读 1 场景」比整篇读省 92.59% 字符（存量场景文件超长是收益主因，真实收益取决于模型定向读的命中率）

