#!/usr/bin/env bash
# list-models.sh <provider-name|current> —— v3 版（2026-10-16 自 v2 repo 移植）
# 拉取当前 yaml 厂商 GET {baseUrl}/models，输出可用模型 id 清单，辅助填写
# 模型目录/models 字段。key 经环境变量引用，不落盘、不回显。
# 用法: ./list-models.sh current
# 依赖: 仓库同级 node-v22（MemoryCore 运行时同款），yaml 包来自 MemoryCore/node_modules
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="${NODE_BIN:-$REPO_DIR/../node-v22/node.exe}"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node)"
exec "$NODE_BIN" "$REPO_DIR/MemoryCore/scripts/list-models.mjs" "$@"
