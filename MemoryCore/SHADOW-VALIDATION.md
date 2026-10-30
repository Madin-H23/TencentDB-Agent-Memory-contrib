# 候选分支在役影子验证方案（SHADOW-VALIDATION）

> 对象：`exp/l2-candidate`（base→B→D→C 合流）。
> 原则：分步启用、每步可回滚、每步有可复算的验收阈值；全程不动在役数据，快照已在位。

## 启用矩阵（分步）

| 阶段 | 内容 | 默认态 | 启用动作 | 回滚 |
|---|---|---|---|---|
| S1 部署 | 合流候选进 develop（普通 merge，保留实验历史）+ 重启网关 | C=32K 生效；B 向后兼容（默认读=旧行为）；D=off | merge + 重启（授权项） | `git revert` 合流 commit + 重启 |
| S2 观察 | C 的拒绝率、D off 基线 | — | 无动作，观察 3 天 | — |
| S3 开 D | `persona.sceneIndexInPrompt=true` + 重启 | D on | 改 yaml + 重启 | 开关切 false + 重启 |
| S4 判定 | 按下方阈值出报告 | — | 跑验收脚本 | — |

## 观测锚点（全部已在役，验收脚本 `tdai-workspace/scripts/readbudget-baseline-20261027.mjs` 复算）

| 锚点 | 含义 | 阈值 |
|---|---|---|
| `read-budget … task_id=` | 按 run 的读取字符 | P95 ≤ 基线 710,123 的 50%；over_file 不得因截断虚降（对比磁盘原始 size） |
| `read-cache-metrics would_hit=` | 缓存上界跟踪 | 记录即可，不作验收 |
| `l2-noop-processed` | 全零 diff 轮 | ≤2.8% 基线（16/391）；连续上升即回滚信号 |
| `over_scene_char_cap`（C 拒绝） | 写侧帽触发率 | <5%；>15% = 帽过紧，调 `sceneCharCap` |
| steps 撞顶 warn（B） | 工具步数 | 次数不高于基线；持续出现 = D 的 limit 指引需再调 |
| `l2_scenes_updated` 中位 | 产出量 | 不低于基线（中位 2–4） |
| 失败/死信 | 供应商错误分类 | 不得出现 context_length 新增 |

## 已知边界（采纳前必读）

- **存量 3MB 大块不在本组合解决范围内**——那是方案 A（离线压实）的定位；A 已核验 PASS 但有「折叠叙事唯一事实丢失」边界，单独决策。
- D 的 92.59% 是模拟上界，真实收益取决于模型定向读命中率——S3 阶段实测。
- B 的护栏是提示词软约束，配合 C 的硬帽才完整。
- 600s 超时主因是排队/供应商，非读取量——本组合不宣称修复该项。

## 回滚预案

- 行为级：D/C 配置开关 off + 重启（分钟级）。
- 代码级：revert 合流 commit（S1 的 merge 是普通 commit，可精确回退）。
- 数据级：L2 快照（10 份/37MB）在 `.backup/`，被折叠/写坏可恢复 scene_blocks。
