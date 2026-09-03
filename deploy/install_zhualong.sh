#!/usr/bin/env bash
# ============================================================
# 抓龙助手(足彩方案助手) · 腾讯云轻量服务器一键部署
# 适用系统: Ubuntu 22.04 / Debian 12 (x64, 2核2G及以上)
# 用法:
#   sudo bash install_zhualong.sh            # 全新安装
#   sudo bash install_zhualong.sh update     # 拉取更新并重启
# 安装后访问: http://<服务器公网IP>:8456
# 注意: 记得在腾讯云轻量控制台"防火墙"放行 TCP 8456 入站!
# ============================================================
set -euo pipefail

APP_DIR=/opt/zhualong
REPO_URL=https://github.com/leoyoyofiona/zhualong-zhushou.git
PORT=${PORT:-8456}

need_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "缺少 $1,请先安装"; exit 1; }; }

install_deps() {
  echo "[1/5] 安装基础软件(python3/git)..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq python3 git curl ca-certificates >/dev/null
  need_cmd python3
  need_cmd git
}

fetch_code() {
  echo "[2/5] 获取项目代码..."
  mkdir -p "$APP_DIR"
  if [ -d "$APP_DIR/.git" ]; then
    cd "$APP_DIR"
    git fetch --quiet origin main
    git reset --hard --quiet origin/main
    echo "      已更新到最新代码: $(git log -1 --oneline)"
  else
    git clone --quiet --depth 1 -b main "$REPO_URL" "$APP_DIR"
    echo "      代码已克隆: $(git -C "$APP_DIR" log -1 --oneline)"
  fi
}

ask_cos() {
  if [ ! -f "$APP_DIR/data/cos_config.json" ]; then
    echo "[3/5] 配置腾讯云 COS(建议弹幕持久化存储)..."
    mkdir -p "$APP_DIR/data"
    read -rp "  COS SecretId(回车跳过=不配置建议存储): " COS_SID
    if [ -n "$COS_SID" ]; then
      read -rp "  COS SecretKey: " COS_SK
      read -rp "  COS 桶名(如 thesis-music-1303737693): " COS_BUCKET
      read -rp "  COS 地域(如 ap-shanghai): " COS_REGION
      read -rp "  建议管理口令(用于删除/清空): " COS_ADMIN
      cat > "$APP_DIR/data/cos_config.json" <<EOF
{
 "secret_id": "$COS_SID",
 "secret_key": "$COS_SK",
 "bucket": "$COS_BUCKET",
 "region": "$COS_REGION",
 "admin_code": "$COS_ADMIN"
}
EOF
      chmod 600 "$APP_DIR/data/cos_config.json"
      echo "      COS 配置已保存(仅此服务器可读)"
    else
      echo "      跳过 COS 配置(建议弹幕不可用,其余功能正常)"
    fi
  else
    echo "[3/5] COS 配置已存在,跳过"
  fi
}

write_service() {
  echo "[4/5] 注册 systemd 自启服务..."
  cat > /etc/systemd/system/zhualong.service <<EOF
[Unit]
Description=Zhualong Zucai Assistant
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/python3 $APP_DIR/server.py --host 0.0.0.0 --port $PORT --no-browser
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1
# 如需用环境变量提供 COS(替代 cos_config.json)可在此加:
# Environment=COS_SECRET_ID=xxx
# Environment=COS_SECRET_KEY=xxx
# Environment=COS_BUCKET=xxx
# Environment=COS_REGION=xxx
# Environment=COS_ADMIN_CODE=xxx

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable zhualong >/dev/null 2>&1 || true
}

start_service() {
  echo "[5/5] 启动服务..."
  systemctl restart zhualong
  sleep 3
  systemctl --no-pager status zhualong | head -6 || true
  IP=$(curl -s -m 5 ifconfig.me || hostname -I | awk '{print $1}')
  echo ""
  echo "=========================================="
  echo " 抓龙助手已启动!"
  echo " 本机访问:   http://127.0.0.1:$PORT"
  echo " 公网访问:   http://$IP:$PORT"
  echo " 日志:       journalctl -u zhualong -f"
  echo " 更新:       sudo bash $0 update"
  echo " 提示: 公网无法访问时,请在腾讯云控制台 → 轻量服务器 → 防火墙 放行 TCP $PORT"
  echo "=========================================="
}

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行: sudo bash $0"; exit 1
fi

if [ "${1:-}" = "update" ]; then
  echo "== 更新模式 =="
  install_deps
  fetch_code
  write_service
  start_service
  exit 0
fi

install_deps
fetch_code
ask_cos
write_service
start_service
