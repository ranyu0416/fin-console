#!/usr/bin/env bash
# 财务管理台 · Linux 一键安装/升级脚本
# 用法（在项目根目录，即包含 server/ 的那一层）：
#   sudo bash server/deploy/install-linux.sh
# 幂等：重复执行即为升级（保留 /var/lib/fin-console 里的账套数据）。
set -euo pipefail

APP_DIR=/opt/fin-console
DATA_DIR=/var/lib/fin-console
ENV_FILE=/etc/fin-console.env
SERVICE=fin-console
RUN_USER=finconsole

die() { echo "错误：$*" >&2; exit 1; }
info() { echo "==> $*"; }

[[ $EUID -eq 0 ]] || die "请用 root 运行：sudo bash server/deploy/install-linux.sh"

# 定位源码目录。两种目录形态都要支持：
#   仓库形态：<项目根>/server/{server.js,deploy/}   —— 脚本在 server/deploy/ 下
#   发布包形态：<解包目录>/{server.js,deploy/}       —— 打包时已经去掉了 server/ 这一层
# 早先只认第一种，从 tar.gz 解出来直接跑会报「找不到 server/server.js」。
DEPLOY_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [[ -f "$DEPLOY_DIR/../server.js" ]]; then
  SRC_DIR=$(cd "$DEPLOY_DIR/.." && pwd)
elif [[ -f "$DEPLOY_DIR/../../server/server.js" ]]; then
  SRC_DIR=$(cd "$DEPLOY_DIR/../../server" && pwd)
else
  die "找不到 server.js。请在解包目录内执行：sudo bash deploy/install-linux.sh"
fi
info "源码目录：$SRC_DIR"

# 1) Node 版本（需要内置 node:sqlite，即 22.5+）
command -v node >/dev/null || die "未安装 Node.js。请先安装 Node 22 LTS：https://github.com/nodesource/distributions"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
if (( NODE_MAJOR < 22 )) || { (( NODE_MAJOR == 22 )) && (( NODE_MINOR < 5 )); }; then
  die "Node 版本过低（当前 $(node -v)），需要 22.5 以上（内置 node:sqlite）"
fi
node -e "require('node:sqlite')" 2>/dev/null || die "当前 Node 不支持 node:sqlite，请换用官方 Node 22 LTS 构建"
info "Node 版本检查通过：$(node -v)"

# 2) 运行账号
if ! id "$RUN_USER" >/dev/null 2>&1; then
  info "创建系统账号 $RUN_USER"
  useradd --system --shell /usr/sbin/nologin --home-dir "$DATA_DIR" "$RUN_USER"
fi

# 3) 同步程序文件（不动数据目录）
info "同步程序到 $APP_DIR"
mkdir -p "$APP_DIR/server"
# --delete 只作用于程序目录，账套数据在 $DATA_DIR 下，不会被碰到。
# 排除 data/：万一源码目录里跑过 demo，不要把演示数据带进正式部署。
if command -v rsync >/dev/null; then
  rsync -a --delete \
    --exclude 'data/' --exclude 'data-demo/' --exclude 'public/' --exclude 'node_modules/' --exclude 'dist/' \
    "$SRC_DIR/" "$APP_DIR/server/"
else
  rm -rf "$APP_DIR/server/lib" "$APP_DIR/server/scripts" "$APP_DIR/server/frontend" "$APP_DIR/server/deploy"
  cp -r "$SRC_DIR/lib" "$SRC_DIR/scripts" "$SRC_DIR/frontend" \
        "$SRC_DIR/deploy" "$SRC_DIR/server.js" "$SRC_DIR/package.json" "$APP_DIR/server/"
fi

# 4) 构建前端：把 frontend/ 复制成 public/，再做两道校验
info "构建前端静态资源"
( cd "$APP_DIR/server" \
    && node scripts/build-frontend.mjs \
    && node scripts/check-esm.mjs \
    && node scripts/verify-build.mjs )

# 5) 数据目录
info "准备数据目录 $DATA_DIR"
mkdir -p "$DATA_DIR/backups"
chown -R "$RUN_USER:$RUN_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

# 6) 环境文件（已存在则不覆盖，避免冲掉现场配置）
if [[ ! -f "$ENV_FILE" ]]; then
  info "写入初始配置 $ENV_FILE"
  cp "$APP_DIR/server/deploy/fin-console.env" "$ENV_FILE"
  echo "    提示：已生成默认配置，可编辑 $ENV_FILE 设置 FIN_ORG_NAME、FIN_HOST 等"
else
  info "保留已有配置 $ENV_FILE"
fi

# 这里包含 FIN_ADMIN_PASSWORD；历史安装可能遗留宽松权限，升级时也必须主动收紧。
ENV_OWNER=$(stat -c '%U:%G' "$ENV_FILE")
ENV_MODE=$(stat -c '%a' "$ENV_FILE")
if [[ "$ENV_OWNER" != "root:root" || "$ENV_MODE" != "600" ]]; then
  info "修正敏感配置文件权限（当前 $ENV_OWNER $ENV_MODE，要求 root:root 600）"
  chown root:root "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

# 7) systemd
info "安装 systemd 单元"
cp "$APP_DIR/server/deploy/fin-console.service" "/etc/systemd/system/$SERVICE.service"
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"

PORT=$(sed -n 's/^FIN_PORT=//p' "$ENV_FILE" | tail -n 1)
HOST=$(sed -n 's/^FIN_HOST=//p' "$ENV_FILE" | tail -n 1)
PORT=${PORT:-8787}
HOST=${HOST:-127.0.0.1}
# 0.0.0.0/:: 是监听地址，不能作为请求目标；本机健康检查固定走 loopback。
case "$HOST" in
  0.0.0.0|::|'') HEALTH_HOST=127.0.0.1 ;;
  *) HEALTH_HOST=$HOST ;;
esac

command -v curl >/dev/null || die "缺少 curl，无法确认服务健康状态"
info "等待服务健康检查：http://${HEALTH_HOST}:${PORT}/api/health"
READY=0
for _ in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 2 "http://${HEALTH_HOST}:${PORT}/api/health" >/dev/null; then
    READY=1
    break
  fi
  sleep 1
done

if [[ $READY -eq 1 ]]; then
  info "服务已启动：http://${HOST}:${PORT}"
  echo
  echo "下一步："
  echo "  1) 查看首次启动生成的管理员口令： journalctl -u $SERVICE -n 40 --no-pager"
  echo "  2) 需要 HTTPS/外网访问：参考 $APP_DIR/server/deploy/nginx-fin-console.conf"
  echo "  3) 忘记口令时重置： cd $APP_DIR/server && sudo -u $RUN_USER node scripts/reset-password.mjs admin"
else
  echo "服务在 30 秒内未通过健康检查，请查看日志：journalctl -u $SERVICE -n 60 --no-pager" >&2
  exit 1
fi
