#!/usr/bin/env bash
# 财务管理台 · 云服务器部署前体检
#
# 用法（不需要 root，不改任何东西，只读检查）：
#   bash deploy/preflight.sh
#
# 为什么单独有这个脚本：云服务器上最常见的几类问题，install-linux.sh
# 是查不出来的——它们不会让安装失败，而是让系统装完之后悄悄地不对劲：
#   · 时区是 UTC     → 每月 1 日凌晨 8 点前，默认账套期间会算成上个月
#   · 安全组没放行   → 服务健康、日志干净，但同事就是打不开
#   * 数据盘没挂载   → 装在系统盘上，扩容或换机时数据搬不走
#   · 内存不足       → 平时够用，导出整套账时被 OOM Killer 杀掉
# 所以它只报告、不修改，让你在装之前就知道要先处理什么。

set -uo pipefail

PORT="${FIN_PORT:-8787}"
DATA_DIR="${FIN_DATA_DIR:-/var/lib/fin-console}"

PASS=0
WARN=0
FAIL=0

# 颜色只在真的输出到终端时才用。重定向进文件或管道时带转义序列，
# 日志里会变成一堆 ^[[32m，反而看不清——而排查问题时这份输出往往是要贴出来的。
if [[ -t 1 ]]; then
  C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_B=$'\033[1m'; C_0=$'\033[0m'
else
  C_G=''; C_Y=''; C_R=''; C_B=''; C_0=''
fi

ok()   { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$*"; PASS=$((PASS+1)); }
warn() { printf '  %s!%s %s\n' "$C_Y" "$C_0" "$*"; WARN=$((WARN+1)); }
bad()  { printf '  %s✗%s %s\n' "$C_R" "$C_0" "$*"; FAIL=$((FAIL+1)); }
note() { printf '      %s\n' "$*"; }
head2() { printf '\n%s%s%s\n' "$C_B" "$*" "$C_0"; }

echo "==================================================="
echo " 财务管理台 · 云服务器部署前体检"
echo "==================================================="

# ---------------------------------------------------------------
head2 "1. 运行时"

if ! command -v node >/dev/null 2>&1; then
  bad "未安装 Node.js"
  note "Ubuntu/Debian: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
  note "CentOS/Alibaba:  curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - && sudo yum install -y nodejs"
else
  NODE_V=$(node -v)
  MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  MINOR=$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)
  if (( MAJOR > 22 )) || { (( MAJOR == 22 )) && (( MINOR >= 5 )); }; then
    ok "Node 版本 $NODE_V"
  else
    bad "Node 版本过低：$NODE_V，需要 22.5 以上"
    note "22.5 是硬要求：系统用 Node 内置的 node:sqlite，这个模块 22.5 才有"
  fi
  if node -e 'require("node:sqlite")' 2>/dev/null; then
    ok "node:sqlite 可用（无需第三方数据库）"
  else
    bad "当前 Node 不支持 node:sqlite"
    note "某些精简发行版会裁掉它，请换官方 Node 22 LTS 构建"
  fi
fi

# ---------------------------------------------------------------
head2 "2. 时区（云服务器默认常是 UTC，会算错账套期间）"

TZ_NOW=$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo unknown)
OFFSET=$(date +%z)
if [[ "$OFFSET" == "+0800" ]]; then
  ok "时区 $TZ_NOW（$OFFSET），当前时间 $(date '+%Y-%m-%d %H:%M')"
else
  warn "时区 $TZ_NOW（$OFFSET），不是东八区"
  note "影响很具体：新装账套的默认期间取服务器当地时间的年月。"
  note "UTC 下 9 月 1 日 08:00 之前，默认账套期间仍是 8 月——月初结转会选错期间。"
  note "修复：sudo timedatectl set-timezone Asia/Shanghai"
  note "或在 /etc/fin-console.env 里设 TZ=Asia/Shanghai（只影响本服务，更保险）"
fi

# ---------------------------------------------------------------
head2 "3. 机器规格"

MEM_MB=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
if (( MEM_MB >= 1800 )); then
  ok "内存 ${MEM_MB} MB"
elif (( MEM_MB >= 900 )); then
  warn "内存 ${MEM_MB} MB，偏小但可用"
  note "服务常驻约 70 MB；导出整套账时会短时升高。建议加 swap 兜底："
  note "  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile"
  note "  sudo mkswap /swapfile && sudo swapon /swapfile"
  note "  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab"
else
  bad "内存 ${MEM_MB} MB，过小"
  note "1 GB 起步的云主机请务必先加 swap，否则导出时会被 OOM Killer 杀进程"
fi

SWAP_MB=$(awk '/SwapTotal/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
if (( SWAP_MB > 0 )); then
  ok "swap ${SWAP_MB} MB"
elif (( MEM_MB < 1800 )); then
  warn "未配置 swap"
fi

CPUS=$(nproc 2>/dev/null || echo 1)
ok "CPU ${CPUS} 核（单请求处理约 2~3 ms，1 核足够几十人同时用）"

# ---------------------------------------------------------------
head2 "4. 数据目录与磁盘"

CHECK_DIR="$DATA_DIR"
while [[ ! -d "$CHECK_DIR" && "$CHECK_DIR" != "/" ]]; do
  CHECK_DIR=$(dirname "$CHECK_DIR")
done

if [[ -d "$DATA_DIR" ]]; then
  ok "数据目录已存在：$DATA_DIR"
else
  note "数据目录尚未创建（install-linux.sh 会建）：$DATA_DIR"
fi

AVAIL_MB=$(df -Pm "$CHECK_DIR" 2>/dev/null | awk 'NR==2{print $4}')
FSTYPE=$(df -PT "$CHECK_DIR" 2>/dev/null | awk 'NR==2{print $2}')
MOUNT=$(df -P "$CHECK_DIR" 2>/dev/null | awk 'NR==2{print $6}')
if [[ -n "${AVAIL_MB:-}" ]] && (( AVAIL_MB >= 5000 )); then
  ok "可用空间 ${AVAIL_MB} MB（挂载点 $MOUNT，类型 $FSTYPE）"
elif [[ -n "${AVAIL_MB:-}" ]] && (( AVAIL_MB >= 1000 )); then
  warn "可用空间仅 ${AVAIL_MB} MB（挂载点 $MOUNT）"
  note "账套本身很小（几万条记录约几十 MB），但默认保留 30 份热备，按份数×库大小估算"
else
  bad "可用空间不足：${AVAIL_MB:-未知} MB（挂载点 $MOUNT）"
fi

case "$FSTYPE" in
  nfs|nfs4|cifs|smb3|fuse.sshfs|9p|virtiofs)
    bad "数据目录在网络文件系统上（$FSTYPE）"
    note "SQLite 依赖本地文件锁，网络盘上的锁语义不可靠，会损坏数据库。"
    note "请把 FIN_DATA_DIR 指向本地盘或云硬盘（ext4/xfs）；备份可以再同步到网络盘。"
    ;;
  ext4|xfs|btrfs|ext3|overlay)
    ok "文件系统 $FSTYPE 适合 SQLite"
    ;;
  *)
    [[ -n "$FSTYPE" ]] && warn "文件系统类型 $FSTYPE，请确认它支持本地文件锁"
    ;;
esac

if [[ "$MOUNT" == "/" ]]; then
  warn "数据目录在系统盘上（挂载点 /）"
  note "能用，但换机器/扩容时要整机搬。云上更常见的做法是挂一块独立云硬盘："
  note "  格式化并挂到 /var/lib/fin-console，写进 /etc/fstab，之后换机器只需重挂这块盘"
else
  ok "数据目录在独立挂载点 $MOUNT（换机器时可整盘迁移）"
fi

# ---------------------------------------------------------------
head2 "5. 端口与网络"

if command -v ss >/dev/null 2>&1; then
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${PORT}\$"; then
    bad "端口 $PORT 已被占用"
    note "查是谁：sudo ss -ltnp | grep :$PORT"
    note "或改用别的端口：在 /etc/fin-console.env 里设 FIN_PORT"
  else
    ok "端口 $PORT 空闲"
  fi
else
  note "没有 ss 命令，跳过端口占用检查"
fi

for p in 80 443; do
  if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}\$"; then
    ok "端口 $p 已有服务在听（大概是 nginx/caddy，反代已就绪）"
  fi
done

if command -v curl >/dev/null 2>&1; then
  ok "curl 可用（安装脚本用它做健康检查）"
else
  bad "缺少 curl，install-linux.sh 无法确认服务是否真的起来了"
  note "sudo apt install -y curl   /   sudo yum install -y curl"
fi

PUBIP=$(curl -s --max-time 4 https://api.ipify.org 2>/dev/null || true)
if [[ -n "$PUBIP" ]]; then
  ok "公网出口 IP：$PUBIP（外网可达，说明能签 Let's Encrypt 证书）"
  note "别忘了在云控制台安全组放行：80（证书签发用）、443（HTTPS）"
  note "不要放行 $PORT —— 应用只听 127.0.0.1，让 nginx/caddy 去接它"
else
  warn "取不到公网 IP（可能无外网出口或被限制）"
  note "纯内网部署没问题，但 Let's Encrypt 自动签证书需要外网，改用自签或内部 CA"
fi

# ---------------------------------------------------------------
head2 "6. 反向代理与 HTTPS"

if command -v nginx >/dev/null 2>&1; then
  ok "已安装 nginx（模板：deploy/nginx-fin-console.conf）"
elif command -v caddy >/dev/null 2>&1; then
  ok "已安装 caddy（模板：deploy/Caddyfile，自动签发续期证书，云上最省事）"
else
  warn "未安装反向代理"
  note "裸 HTTP 下口令和财务数据在网络上是明文。二选一："
  note "  sudo apt install -y caddy   （自动 HTTPS，推荐）"
  note "  sudo apt install -y nginx certbot python3-certbot-nginx"
fi

if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  ok "systemd 可用（开机自启、崩溃自动重启、日志归 journal）"
else
  warn "没有 systemd"
  note "WSL 默认如此。云服务器上正常不会缺；若确实没有，用 Docker 方案："
  note "  docker compose up -d --build"
fi

# ---------------------------------------------------------------
head2 "7. 配置一致性"

ENV_FILE=/etc/fin-console.env
if [[ -f "$ENV_FILE" ]]; then
  if [[ -r "$ENV_FILE" ]]; then
    HOST_SET=$(sed -n 's/^FIN_HOST=//p' "$ENV_FILE" | tail -n1)
    SECURE=$(sed -n 's/^FIN_COOKIE_SECURE=//p' "$ENV_FILE" | tail -n1)
    TRUST=$(sed -n 's/^FIN_TRUST_PROXY=//p' "$ENV_FILE" | tail -n1)
    MODE=$(stat -c '%a' "$ENV_FILE" 2>/dev/null)

    if [[ "$MODE" == "600" ]]; then
      ok "$ENV_FILE 权限 600"
    else
      bad "$ENV_FILE 权限是 $MODE，应为 600（里面可能有初始口令）"
      note "sudo chown root:root $ENV_FILE && sudo chmod 600 $ENV_FILE"
    fi

    if [[ "$HOST_SET" == "0.0.0.0" ]]; then
      warn "FIN_HOST=0.0.0.0：应用直接对外，跳过了反向代理"
      note "云服务器上建议保持 127.0.0.1，由 nginx/caddy 收 HTTPS 再转进来"
      [[ "$SECURE" == "1" ]] || note "若确实要直连，至少要有 HTTPS，否则口令走明文"
    else
      ok "FIN_HOST=${HOST_SET:-127.0.0.1}（只听本机，靠反代对外）"
    fi

    if [[ "$SECURE" == "1" && "$TRUST" == "1" ]]; then
      ok "FIN_COOKIE_SECURE=1 且 FIN_TRUST_PROXY=1（HTTPS 反代已配好的状态）"
    elif [[ "$SECURE" == "1" ]]; then
      warn "开了 COOKIE_SECURE 但没开 TRUST_PROXY：审计日志里所有人的 IP 都会是 127.0.0.1"
    elif [[ "$TRUST" == "1" ]]; then
      warn "开了 TRUST_PROXY 但没开 COOKIE_SECURE：HTTPS 下 Cookie 缺 Secure 标记"
    else
      note "两项都是关的——这是「还没配 HTTPS」的正确状态。配好证书后一起打开"
    fi
  else
    note "$ENV_FILE 存在但当前用户读不了（正常，它是 600），请用 sudo 重跑本脚本以检查配置"
  fi
else
  note "$ENV_FILE 尚不存在（install-linux.sh 会从模板生成）"
fi

# ---------------------------------------------------------------
echo
echo "==================================================="
printf " 结果：通过 %d 项" "$PASS"
(( WARN > 0 )) && printf "，提醒 %d 项" "$WARN"
(( FAIL > 0 )) && printf "，%s必须处理 %d 项%s" "$C_R" "$FAIL" "$C_0"
echo
echo "==================================================="

if (( FAIL > 0 )); then
  echo
  echo "有必须处理的问题，建议先解决再执行 sudo bash deploy/install-linux.sh"
  exit 1
fi

echo
if (( WARN > 0 )); then
  echo "没有致命问题。提醒项不影响安装，但会影响长期使用，建议顺手处理。"
else
  echo "环境就绪，可以执行： sudo bash deploy/install-linux.sh"
fi
