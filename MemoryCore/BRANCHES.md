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

- exp/l2-plan-d-summary-index | 89e6ef8（实现；交付记录另 commit） | 静态门：vitest 56 文件/506 例全绿（基线 485 只增不减，新增 21：注入 8 + 模拟 13）+ tsc 230=基线（stash 复测零新增）；模拟评测 saving%=92.59%（indexed_cost 126,630 = 索引段 4,577 + 单场景平均 122,053 vs whole_cost 1,708,737，14 场景，fixtures/scene_blocks） | 场景索引注入默认 off 零行为变化（off 输出与基线逐字节一致，sha256 兼容钉 0b06ae16…），开启（persona.sceneIndexInPrompt）时 L2 提示词追加每场景一行「path | heat | summary≤300」紧凑索引（内存 scene_index 直读、零新增 I/O），两个 L2 read 工具 description 追加按需读取引导；模拟上「索引+定向读 1 场景」比整篇读省 92.59% 字符（存量场景文件超长是收益主因，真实收益取决于模型定向读的命中率）
