#!/bin/bash
# 足彩方案助手 · 一键启动（macOS / Linux）
# 用法: ./run.sh          或  PORT=9000 ./run.sh
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "❌ 未找到 python3，请先安装 Python 3（https://www.python.org/downloads/）"
  exit 1
fi

PORT="${PORT:-8456}"
echo "▶ 正在启动 足彩方案助手  http://127.0.0.1:${PORT}"
exec python3 server.py --port "$PORT" "$@"
