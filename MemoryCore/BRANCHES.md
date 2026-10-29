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
