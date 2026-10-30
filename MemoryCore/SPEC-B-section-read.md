# 方案B：read 分段读（offset/limit）+ 提示词按节读

## 目标
read 工具支持 `offset`/`limit`（字符窗口，逐字精确），让模型按节读而不是整篇灌上下文。

## 交付
1. `src/adapters/standalone/storage-tools.ts` 与 `llm-runner.ts` 两处 read 工具：schema 加可选 `offset`（默认 0）/`limit`（默认 = 全文）；返回被截取片段 + 尾部标注 `[... omitted N chars, offset=M limit=L of T total ...]`；越界安全（offset>len 返回空+标注）。
2. 提示词 `src/core/prompts/scene-extraction.ts`：增加「大文件先用 offset/limit 分段预览，edit 的 oldText 必须来自已读片段」的规则（保留既有规则不删）。
3. 测试：两套工具各测（默认全文=旧行为逐字节一致 / offset+limit 切片正确 / 越界安全 / 标注行格式）。

## 红线
- 默认行为（无 offset/limit）必须与旧版**逐字节一致**（兼容钉）。
- 不改 read-budget 计量口径（observe 仍记实际返回的 chars）。
- 不动 write/edit。
