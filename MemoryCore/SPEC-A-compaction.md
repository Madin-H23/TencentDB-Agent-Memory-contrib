# 方案A：确定性离线压实（offline compaction）

## 目标
把超预算的场景块（中位 156K 字符）压到 ≤32K，**不调用 LLM**（确定性、可评分）。

## 交付
`scripts/l2-compact.mjs`：
- 输入 `--in <fixtures目录> --out <输出目录> --cap 32000`
- 确定性规则（按序）：① META 原样保留（heat/summary 不动）；② 含事实锚点（m_\d{13}_[0-9a-f]{8}）的整行**逐字保留**；③ 重复段落/重复标题去重（逐字相同的段落只留最后一次）；④ 超帽时从最旧「批次叙述段」开始折叠为单行摘要（保留标题行 + 锚点行）。
- 自测：vitest（scripts/*.test.ts 或 tests/），含「锚点 100% 保留」「META 完整」「重复折叠确定性（两次运行逐字节相同）」。

## 评分
`node scripts/l2-score.mjs --fixtures <冻结输入> --output <压实输出>` 必须 verdict=PASS。

## 红线
- 不动在役 scene_blocks；输出写独立目录。
- 不得调用 LLM、不得访问网络。
- 先 TDD（红→绿），测试未过不得交付。
