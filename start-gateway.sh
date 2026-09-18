#!/usr/bin/env bash
# ============================================================
# TDAI Memory Gateway 一键启动脚本
# ============================================================
# 用法:
#   先设置你的 LLM API Key (对应 tdai-gateway.yaml llm.providers 里
#   activeProvider 所引用的 apiKeyEnv; TDAI_LLM_API_KEY 为脚本最低校验项):
#     export TDAI_LLM_API_KEY=你的key
#   然后运行:
#     ./start-gateway.sh
#
# 本脚本使用便携版 Node 22(不污染全局 Node 20)。
# Gateway 监听 http://127.0.0.1:8420
# ============================================================

set -e

# ── 路径配置 ──
NODE22_DIR="/d/develop/TencentDB-Agent-Memory/node-v22"
PROJECT_DIR="/d/develop/TencentDB-Agent-Memory/repo/MemoryCore"
export PATH="$NODE22_DIR:$PATH"

echo "=== TDAI Memory Gateway 启动 ==="
echo "Node 版本: $(node -v)"
echo ""

# ── 检查 API Key ──
if [ -z "$TDAI_LLM_API_KEY" ]; then
  echo "❌ 未设置 TDAI_LLM_API_KEY 环境变量"
  echo "   请先运行: export TDAI_LLM_API_KEY=你的deepseek_key"
  exit 1
fi
echo "✅ TDAI_LLM_API_KEY 已设置 (生效厂商/模型以 tdai-gateway.yaml llm.activeProvider 为准)"

# ── 可选:开启 Gateway 鉴权(给桥接层/Hook 用)──
# 取消下行注释并填入自定义 key,则桥接层需配相同的 TDAI_GATEWAY_API_KEY
# export TDAI_GATEWAY_API_KEY=your-gateway-secret

# ── 思考型模型须关思考(否则 reasoning 烧穿 maxTokens,蒸馏 extracted=0)──
# 对所有 OpenAI 兼容通道生效(DeepSeek/OpenCode Go/智谱等),开关在 providers 条目
# 或层配置里也可用 llm.disableThinking 覆盖
export TDAI_DISABLE_THINKING=true

echo "工作目录: $PROJECT_DIR"
echo "启动 Gateway (监听 127.0.0.1:8420)..."
echo "按 Ctrl+C 停止"
echo "----------------------------------------"

cd "$PROJECT_DIR"
# 用 tsx 直接跑 TS(开发模式,日志直接输出到终端,便于调试)
exec npx tsx src/gateway/server.ts
