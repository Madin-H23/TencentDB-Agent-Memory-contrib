# 方案C：edit/write 后像尺寸帽 + 结构化拒绝

## 目标
L2 场景文件增长的 94% 来自无后像约束的 edit——给两个工具的**写入结果**加尺寸帽。

## 交付
1. 配置：`persona.sceneCharCap`（默认 32000，0=off）。
2. storage-tools 与 llm-runner 的 write/edit execute：写入后像超过帽 → **拒绝**（不落盘），返回 JSON `{error:"over_scene_char_cap", chars, cap, overflow, hint:"compress: 折叠重复批次段，保留事实锚点行"}`。
3. 按 storagePrefix 限定作用域：L3 persona（prefix 为空）不受帽限制。
4. 测试：超帽拒绝（write 与 edit 各一）/ 帽内放行 / prefix 空不受限 / 关闭开关。

## 红线
- 拒绝必须带可执行的压缩指令（防重试死锁）。
- `[DELETED]` 写入不受帽限制。
- 不动提示词（那是另一方案的变量，防串味）。
