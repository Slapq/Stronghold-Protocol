#!/usr/bin/env bash
# scripts/deploy-native.sh — deploy on a Linux server WITHOUT Docker (systemd), tuned for servers in mainland China
# (docs/DEPLOY.md「国内服务器 / 不用 Docker」).
#
# Installs into the server, leaving other services alone:
#   /opt/stronghold/node       Node.js 22 (from the npmmirror Node mirror; the system Node is not touched)
#   /opt/stronghold/bin/caddy  Caddy (GitHub release via the GitHub proxy): HTTPS — a Let's Encrypt certificate for the
#                              server's public IP (or a domain) —, the login, and the art pack download at /pack/
#   the art, built in          downloaded through the GitHub proxy into public/assets: players need no import
#   deploy/pack/*.zip          the same art as a standalone pack to share (browser import, 设置 → 素材包)
#   systemd units              stronghold-game (127.0.0.1:<port>) and stronghold-caddy (80 / 443), user `stronghold`
# Settings and logins live in deploy/ (git-ignored). Re-running keeps them.
#
#   sudo scripts/deploy-native.sh [install] --ip 203.0.113.10 [options]    first install / reconfigure
#   sudo scripts/deploy-native.sh update        git pull + dependencies + new art + restart
#   sudo scripts/deploy-native.sh assets        download new art and rebuild the shared zip
#   sudo scripts/deploy-native.sh add-user NAME | del-user NAME | users | new-link
#   sudo scripts/deploy-native.sh retry-cert    try Let's Encrypt for the IP certificate again right now
#   sudo scripts/deploy-native.sh status | logs | restart | uninstall
#
# Options (install):
#   --ip ADDR            the public IPv4 players use (required unless --domain; with several public IPs pick one)
#   --domain NAME        use a domain instead of the IP (mainland servers: the domain needs an ICP 备案 for 80/443)
#   --bind ADDR          listen only on this local address (e.g. the private address the chosen public IP maps to),
#                        leaving 80 / 443 of the other addresses free; default: all addresses
#   --email ADDR         contact address for the certificate (recommended)
#   --auth MODE          basic (default: user + password) | link (one invite link) | none
#   --user NAME          basic auth login to create (repeatable; default: friend)
#   --port N             internal port of the game server (127.0.0.1 only; default 3000)
#   --no-zip             do not build the shareable art pack zip
#   --gh-proxy URL       GitHub download proxy (default https://ghfast.top/; `none` = direct)
#   --npm-registry URL   npm registry (default https://registry.npmmirror.com)
#   --node-mirror URL    Node.js download mirror (default https://npmmirror.com/mirrors/node)
#   -y, --yes            do not ask questions
set -Eeuo pipefail
# never exit silently: name the command that failed
trap 'rc=$?; printf "\n错误: scripts/deploy-native.sh 第 %s 行的命令失败（退出码 %s）：%s\n" "$LINENO" "$rc" "$BASH_COMMAND" >&2' ERR

cd "$(dirname "$0")/.."
ROOT=$PWD
DEPLOY="$ROOT/deploy"
ENV_FILE="$DEPLOY/native.env"
USERS_FILE="$DEPLOY/users.caddy"
CRED_FILE="$DEPLOY/credentials.txt"
CADDY_DIR="$DEPLOY/caddy"
CADDYFILE="$CADDY_DIR/Caddyfile"
PACK_DIR="$DEPLOY/pack"
GAME_ENV="$DEPLOY/game.env"
PREFIX=/opt/stronghold
NODE_DIR="$PREFIX/node"
NODE_BIN="$NODE_DIR/bin/node"
CADDY_BIN="$PREFIX/bin/caddy"
CADDY_VERSION=2.11.4
NODE_MAJOR=22
SVC_USER=stronghold
CADDY_STATE=/var/lib/stronghold-caddy
UNIT_DIR=/etc/systemd/system

ENV_KEYS="SP_IP SP_DOMAIN SP_BIND SP_EMAIL SP_AUTH SP_PORT SP_ZIP SP_GH_PROXY SP_NPM_REGISTRY SP_NODE_MIRROR SP_ASSET_URL SP_EXTRA_URLS SP_LINK_KEY"
CADDY_PACK_ROOT="$PACK_DIR"
ASSETS_ON_SERVER=1
# shellcheck source=scripts/lib/deploy-common.sh
. "$ROOT/scripts/lib/deploy-common.sh"
init_env

usage() { sed -n '2,37p' "$0" | sed 's/^# \{0,1\}//'; }

# ---- helpers -------------------------------------------------------------------------------------------------------

need_root() { [ "$(id -u)" -eq 0 ] || die "请用 root 运行（sudo scripts/$(basename "$0") …）"; }

gh() { # gh URL → the URL through the GitHub proxy
  case "$SP_GH_PROXY" in ''|none) printf '%s' "$1" ;; */) printf '%s%s' "$SP_GH_PROXY" "$1" ;; *) printf '%s/%s' "$SP_GH_PROXY" "$1" ;; esac
}

fetch() { curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 -sS "$@"; }

arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo amd64 ;;
    aarch64|arm64) echo arm64 ;;
    *) die "不支持的 CPU 架构：$(uname -m)（支持 x86_64 / aarch64）" ;;
  esac
}

is_public_ipv4() {
  [[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  local a=${BASH_REMATCH[1]} b=${BASH_REMATCH[2]} o
  for o in "${BASH_REMATCH[@]:1}"; do [ "$o" -le 255 ] || return 1; done
  [ "$a" -eq 10 ] || [ "$a" -eq 127 ] || [ "$a" -eq 0 ] || [ "$a" -ge 224 ] && return 1
  [ "$a" -eq 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ] && return 1
  [ "$a" -eq 192 ] && [ "$b" -eq 168 ] && return 1
  [ "$a" -eq 100 ] && [ "$b" -ge 64 ] && [ "$b" -le 127 ] && return 1
  [ "$a" -eq 169 ] && [ "$b" -eq 254 ] && return 1
  return 0
}

port_owner() { # port_owner PORT [ADDR] → process name listening there (empty = free)
  command -v ss >/dev/null 2>&1 || return 0
  # (a free port matches nothing: never let that fail the caller under set -e / pipefail)
  ss -ltnpH "( sport = :$1 )" 2>/dev/null | grep -o 'users:(("[^"]*"' | head -1 | sed 's/users:(("//; s/"$//' || true
}

as_svc() { runuser -u "$SVC_USER" -- "$@"; }

# ---- Caddyfile hooks (scripts/lib/deploy-common.sh) ---------------------------------------------------------------

caddy_site() { if [ -n "$SP_DOMAIN" ]; then printf '%s' "$SP_DOMAIN"; else printf 'https://%s' "$SP_IP"; fi; }
caddy_global() {
  # own admin socket: never clashes with another Caddy on localhost:2019
  printf '\tadmin unix//run/stronghold-caddy/admin.sock\n'
  # an IP certificate: browsers send no SNI for IP addresses, and behind the cloud's NAT the local address is private
  [ -z "$SP_DOMAIN" ] && printf '\tdefault_sni %s\n' "$SP_IP"
  # the internal fallback CA below must not try to install itself into the system trust store (no root; noise)
  [ -z "$SP_DOMAIN" ] && printf '\tskip_install_trust\n'
  return 0
}
caddy_tls() {
  [ -n "$SP_BIND" ] && printf '\tbind %s\n' "$SP_BIND"
  # Let's Encrypt issues IP-address certificates only with the short-lived profile (6 days; Caddy renews them).
  # Mainland IDCs often block port 80 and parts of the validation paths: then Caddy falls back to its own CA (the
  # browser warns once per visitor) and retries Let's Encrypt at every renewal of that 12-hour certificate.
  # Only the TLS-ALPN challenge (port 443): an http-01 attempt on a blocked port 80 wastes one of Let's Encrypt's
  # 5 failed validations per hour.
  [ -z "$SP_DOMAIN" ] && printf '\ttls {\n\t\tissuer acme {\n\t\t\tprofile shortlived\n\t\t\tdisable_http_challenge\n\t\t}\n\t\tissuer internal\n\t}\n'
  return 0
}
site_url() { if [ -n "$SP_DOMAIN" ]; then printf 'https://%s/' "$SP_DOMAIN"; else printf 'https://%s/' "$SP_IP"; fi; }
caddy_validate() { "$CADDY_BIN" validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1 || { "$CADDY_BIN" validate --config "$CADDYFILE" --adapter caddyfile || true; return 1; }; }
hash_password() { "$CADDY_BIN" hash-password --plaintext "$1" | tr -d '\r\n'; }
# the upstream depends on the saved --port, so it is set at write time
write_caddy() { CADDY_UPSTREAM="127.0.0.1:${SP_PORT:-3000}"; write_caddyfile; }

# ---- installs ------------------------------------------------------------------------------------------------------

ensure_tools() {
  local missing=() t
  for t in curl tar gzip sha256sum sha512sum runuser useradd systemctl; do command -v "$t" >/dev/null 2>&1 || missing+=("$t"); done
  command -v git >/dev/null 2>&1 || missing+=(git)
  [ ${#missing[@]} -eq 0 ] || die "缺少命令：${missing[*]}（Debian/Ubuntu: apt install curl tar git；CentOS/Alibaba Cloud Linux: dnf install curl tar git）"
  [ -d /run/systemd/system ] || die "这台机器没有在运行 systemd，本脚本需要 systemd 来常驻服务"
}

ensure_node() {
  if [ -x "$NODE_BIN" ] && [ "$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')" -ge "$NODE_MAJOR" ]; then return 0; fi
  local a sums line file sha tmp
  a=$(arch); [ "$a" = amd64 ] && a=x64
  say "安装 Node.js $NODE_MAJOR（$SP_NODE_MIRROR）…"
  sums=$(fetch "$SP_NODE_MIRROR/latest-v$NODE_MAJOR.x/SHASUMS256.txt") || die "无法从 $SP_NODE_MIRROR 获取 Node.js 版本列表（换一个 --node-mirror 试试）"
  line=$(printf '%s\n' "$sums" | grep -E " node-v$NODE_MAJOR\.[0-9.]+-linux-$a\.tar\.gz$" | head -1 || true)
  [ -n "$line" ] || die "镜像里找不到 linux-$a 的 Node.js $NODE_MAJOR"
  sha=${line%% *}; file=${line##* }
  tmp=$(mktemp -d)
  fetch -o "$tmp/$file" "$SP_NODE_MIRROR/latest-v$NODE_MAJOR.x/$file"
  echo "$sha  $tmp/$file" | sha256sum -c --quiet - || die "Node.js 安装包校验失败"
  rm -rf "$NODE_DIR.new"; mkdir -p "$NODE_DIR.new"
  tar -xzf "$tmp/$file" -C "$NODE_DIR.new" --strip-components=1
  rm -rf "$NODE_DIR"; mv "$NODE_DIR.new" "$NODE_DIR"; rm -rf "$tmp"
  say "Node.js $("$NODE_BIN" -v) → $NODE_DIR"
}

ensure_caddy() {
  if [ -x "$CADDY_BIN" ] && "$CADDY_BIN" version 2>/dev/null | grep -q "^v$CADDY_VERSION "; then return 0; fi
  local a base file sums sha tmp
  a=$(arch)
  file="caddy_${CADDY_VERSION}_linux_${a}.tar.gz"
  base="https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION"
  say "安装 Caddy $CADDY_VERSION（$(gh "$base/")）…"
  tmp=$(mktemp -d)
  sums=$(fetch "$(gh "$base/caddy_${CADDY_VERSION}_checksums.txt")") || die "下载 Caddy 校验文件失败（GitHub 代理 $SP_GH_PROXY 不可用？换一个 --gh-proxy）"
  sha=$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f { print $1 }')
  [ -n "$sha" ] || die "Caddy 校验文件里没有 $file"
  fetch -o "$tmp/$file" "$(gh "$base/$file")" || die "下载 Caddy 失败"
  echo "$sha  $tmp/$file" | sha512sum -c --quiet - || die "Caddy 安装包校验失败"
  mkdir -p "$PREFIX/bin"
  tar -xzf "$tmp/$file" -C "$tmp" caddy
  install -m 0755 "$tmp/caddy" "$CADDY_BIN.new" && mv "$CADDY_BIN.new" "$CADDY_BIN"
  rm -rf "$tmp"
  say "$("$CADDY_BIN" version | cut -d' ' -f1) → $CADDY_BIN"
}

ensure_user() {
  if ! id "$SVC_USER" >/dev/null 2>&1; then
    useradd --system --home-dir /var/lib/stronghold --no-create-home --shell "$(command -v nologin || echo /bin/false)" "$SVC_USER"
  fi
  as_svc test -r "$ROOT/server/index.js" || die "服务用户 $SVC_USER 读不到 $ROOT（例如放在了 /root 下）。请把项目放到 /opt 之类的目录：
  sudo mv $ROOT /opt/Stronghold-Protocol && cd /opt/Stronghold-Protocol && sudo scripts/$(basename "$0") …"
}

npm_install() {
  say "安装依赖（$SP_NPM_REGISTRY）…"
  ( cd "$ROOT" && PATH="$NODE_DIR/bin:$PATH" npm ci --omit=dev --no-audit --no-fund --registry="$SP_NPM_REGISTRY" ) \
    || die "npm ci 失败（网络？换一个 --npm-registry 试试）"
}

fetch_art() {
  say "下载素材到服务器（约 250 MB，GitHub 代理：${SP_GH_PROXY:-无}；中断后重跑会续传）…"
  local rc=0
  ( cd "$ROOT" && SP_GH_PROXY="$SP_GH_PROXY" "$NODE_BIN" tools/fetch-assets.mjs ) || rc=$?
  if [ "$rc" -ne 0 ]; then
    warn "素材下载没有全部成功（退出码 $rc），再试一次…"
    ( cd "$ROOT" && SP_GH_PROXY="$SP_GH_PROXY" "$NODE_BIN" tools/fetch-assets.mjs ) || warn "仍有素材没下载成功：游戏照常运行（缺的部分显示占位图），稍后运行 scripts/$(basename "$0") assets 重试"
  fi
  [ -n "$(ls -A "$ROOT/public/assets" 2>/dev/null)" ] || die "没有下载到任何素材（GitHub 代理 $SP_GH_PROXY 不可用？换一个 --gh-proxy）"
}

build_zip() {
  mkdir -p "$PACK_DIR"
  if [ "$SP_ZIP" = no ]; then find "$PACK_DIR" -maxdepth 1 -name 'stronghold-assets-*.zip' -delete; return 0; fi
  local hash out
  hash=$("$NODE_BIN" -p 'require(process.argv[1]).hash || "pack"' "$ROOT/data/assets.json")
  out="$PACK_DIR/stronghold-assets-$hash.zip"
  if [ -f "$out" ]; then say "素材包 zip 已是最新：$out"; return 0; fi
  say "打包独立素材包 zip…"
  ( cd "$ROOT" && "$NODE_BIN" tools/pack-assets.mjs --zip "$out" --quiet )
  find "$PACK_DIR" -maxdepth 1 -name 'stronghold-assets-*.zip' ! -name "$(basename "$out")" -delete
  chmod 644 "$out"
  say "素材包：$out（$(du -h "$out" | cut -f1)）"
}

write_game_env() {
  ( umask 027
    {
      echo "# Generated by scripts/deploy-native.sh"
      echo "NODE_ENV=production"
      echo "HOST=127.0.0.1"
      echo "PORT=$SP_PORT"
      echo "SP_ASSETS=server"
      echo "SP_ASSET_URL=\"$SP_ASSET_URL\""
      echo "TRUST_PROXY=auto"
    } > "$GAME_ENV.tmp" )
  mv "$GAME_ENV.tmp" "$GAME_ENV"
  chgrp "$SVC_USER" "$GAME_ENV"
}

write_units() {
  cat > "$UNIT_DIR/stronghold-game.service" <<EOF
# Generated by scripts/deploy-native.sh
[Unit]
Description=Stronghold Protocol game server
After=network-online.target
Wants=network-online.target

[Service]
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$ROOT
EnvironmentFile=$GAME_ENV
ExecStart=$NODE_BIN server/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true
PrivateDevices=true

[Install]
WantedBy=multi-user.target
EOF
  cat > "$UNIT_DIR/stronghold-caddy.service" <<EOF
# Generated by scripts/deploy-native.sh
[Unit]
Description=Stronghold Protocol HTTPS front (Caddy)
After=network-online.target stronghold-game.service
Wants=network-online.target

[Service]
User=$SVC_USER
Group=$SVC_USER
Environment=HOME=$CADDY_STATE XDG_DATA_HOME=$CADDY_STATE XDG_CONFIG_HOME=$CADDY_STATE
StateDirectory=stronghold-caddy
RuntimeDirectory=stronghold-caddy
ExecStart=$CADDY_BIN run --config $CADDYFILE --adapter caddyfile
ExecReload=$CADDY_BIN reload --config $CADDYFILE --adapter caddyfile --force
Restart=on-failure
RestartSec=5
TimeoutStopSec=5s
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true
PrivateDevices=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
}

fix_perms() {
  chgrp -R "$SVC_USER" "$CADDY_DIR"; chmod 750 "$CADDY_DIR"; chmod 640 "$CADDYFILE"
  chmod 755 "$DEPLOY"
  mkdir -p "$PACK_DIR"; chmod 755 "$PACK_DIR"
}

open_firewall() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw allow 443/udp >/dev/null && say "ufw：已放行 80 / 443"
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-service=http --add-service=https >/dev/null && firewall-cmd --reload >/dev/null && say "firewalld：已放行 http / https"
  fi
}

check_ports() {
  local p who
  for p in 80 443; do
    who=$(port_owner "$p")
    if [ -n "$who" ] && [ "$who" != caddy ]; then
      [ -n "$SP_BIND" ] && { warn "$p 端口已被 $who 占用（--bind $SP_BIND 只要它没占用这个地址就行）"; continue; }
      die "$p 端口已被 $who 占用。先停掉它，或用 --bind 只监听另一个地址。"
    fi
  done
  who=$(port_owner "$SP_PORT")
  if [ -n "$who" ] && [ "$who" != node ] && [ "$who" != MainThread ]; then die "游戏端口 $SP_PORT 已被 $who 占用，换一个：--port 3100"; fi
  return 0
}

wait_ready() {
  local i code target
  for i in $(seq 1 30); do
    curl -fsS --max-time 2 "http://127.0.0.1:$SP_PORT/healthz" >/dev/null 2>&1 && break
    [ "$i" = 30 ] && { journalctl -u stronghold-game -n 30 --no-pager || true; die "游戏服务没有启动（上面是日志）"; }
    sleep 1
  done
  say "游戏服务已启动（127.0.0.1:$SP_PORT）"
  target=${SP_BIND:-127.0.0.1}
  say "等待 HTTPS 证书（Let's Encrypt 需要从外网访问 $(site_url) 的 80 / 443 端口）…"
  local insecure
  for i in $(seq 1 45); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 --connect-to "${SP_DOMAIN:-$SP_IP}:443:$target:443" "$(site_url)healthz" 2>/dev/null || true)
    if [ -n "$code" ] && [ "$code" != 000 ]; then say "HTTPS 证书已生效（$(site_url)，响应 $code）"; return 0; fi
    # Let's Encrypt failed and Caddy serves its own certificate: playable now, the real one may follow later
    insecure=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 4 --connect-to "${SP_DOMAIN:-$SP_IP}:443:$target:443" "$(site_url)healthz" 2>/dev/null || true)
    if [ -z "$SP_DOMAIN" ] && [ "$i" -ge 20 ] && [ -n "$insecure" ] && [ "$insecure" != 000 ]; then
      warn "Let's Encrypt 暂时没有签下来（机房常拦 80 端口、跨境验证不稳定），现在用的是临时自签证书：
  朋友打开 $(site_url) 时浏览器会提示「不是私密连接」，点「高级 → 继续访问」即可正常游玩。
  Caddy 约每 8 小时会再试一次 Let's Encrypt，成功后自动换成正式证书；想马上再试：scripts/$(basename "$0") retry-cert"
      return 0
    fi
    sleep 2
  done
  warn "证书还没有申请下来。常见原因：云服务器安全组没有放行这个公网 IP 的 TCP 80 / 443；--ip 填的不是玩家访问的那个 IP。
  查看日志：journalctl -u stronghold-caddy -n 50 --no-pager（Caddy 会自动重试，修好后不用重装）"
}

# ---- commands ------------------------------------------------------------------------------------------------------

cmd_install() {
  local users=() ip= domain= bind= email= auth= port= zip= proxy= reg= mirror= extra=() set_extra=0 set_bind=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --ip) ip=${2:-}; shift 2 ;;            --ip=*) ip=${1#*=}; shift ;;
      --domain) domain=${2:-}; shift 2 ;;    --domain=*) domain=${1#*=}; shift ;;
      --bind) bind=${2:-}; set_bind=1; shift 2 ;; --bind=*) bind=${1#*=}; set_bind=1; shift ;;
      --email) email=${2:-}; shift 2 ;;      --email=*) email=${1#*=}; shift ;;
      --auth) auth=${2:-}; shift 2 ;;        --auth=*) auth=${1#*=}; shift ;;
      --user) users+=("${2:-}"); shift 2 ;;  --user=*) users+=("${1#*=}"); shift ;;
      --port) port=${2:-}; shift 2 ;;        --port=*) port=${1#*=}; shift ;;
      --no-zip) zip=no; shift ;;
      --zip) zip=yes; shift ;;
      --gh-proxy) proxy=${2:-}; shift 2 ;;   --gh-proxy=*) proxy=${1#*=}; shift ;;
      --npm-registry) reg=${2:-}; shift 2 ;; --npm-registry=*) reg=${1#*=}; shift ;;
      --node-mirror) mirror=${2:-}; shift 2 ;; --node-mirror=*) mirror=${1#*=}; shift ;;
      --asset-url) extra+=("${2:-}"); set_extra=1; shift 2 ;; --asset-url=*) extra+=("${1#*=}"); set_extra=1; shift ;;
      -y|--yes) YES=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "未知参数：$1（scripts/$(basename "$0") --help）" ;;
    esac
  done
  need_root
  ensure_tools
  load_env
  [ -n "$ip" ] && { SP_IP=$ip; SP_DOMAIN=; }
  [ -n "$domain" ] && { SP_DOMAIN=$domain; }
  [ "$set_bind" = 1 ] && SP_BIND=$bind
  [ -n "$email" ] && SP_EMAIL=$email
  [ -n "$auth" ] && SP_AUTH=$auth
  [ -n "$port" ] && SP_PORT=$port
  [ -n "$zip" ] && SP_ZIP=$zip
  [ -n "$proxy" ] && SP_GH_PROXY=$proxy
  [ -n "$reg" ] && SP_NPM_REGISTRY=$reg
  [ -n "$mirror" ] && SP_NODE_MIRROR=$mirror
  [ "$set_extra" = 1 ] && SP_EXTRA_URLS="${extra[*]}"
  SP_AUTH=${SP_AUTH:-basic}; SP_PORT=${SP_PORT:-3000}; SP_ZIP=${SP_ZIP:-yes}
  SP_GH_PROXY=${SP_GH_PROXY:-https://ghfast.top/}
  SP_NPM_REGISTRY=${SP_NPM_REGISTRY:-https://registry.npmmirror.com}
  SP_NODE_MIRROR=${SP_NODE_MIRROR:-https://npmmirror.com/mirrors/node}; SP_NODE_MIRROR=${SP_NODE_MIRROR%/}

  if [ -z "$SP_IP" ] && [ -z "$SP_DOMAIN" ]; then
    [ -t 0 ] && [ "$YES" != 1 ] && read -r -p "玩家访问用的公网 IP（有多个公网 IP 时填你要用的那个）：" SP_IP
    [ -n "$SP_IP" ] || die "需要 --ip 公网IP（或 --domain 域名）"
  fi
  if [ -n "$SP_DOMAIN" ]; then
    [[ "$SP_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "域名格式不对：$SP_DOMAIN"
  else
    is_public_ipv4 "$SP_IP" || die "$SP_IP 不是公网 IPv4（填云控制台里的公网 / 弹性 IP，不是网卡上的内网地址）"
  fi
  [ -z "$SP_BIND" ] || ip -o addr show 2>/dev/null | grep -qw "inet $SP_BIND/[0-9]*" || [ "$SP_BIND" = 0.0.0.0 ] || die "--bind $SP_BIND 不是本机网卡上的地址（ip -4 addr 查看）"
  [[ "$SP_PORT" =~ ^[0-9]+$ ]] && [ "$SP_PORT" -ge 1024 ] && [ "$SP_PORT" -le 65535 ] || die "--port 要在 1024–65535 之间"
  [ -z "$SP_EMAIL" ] || [[ "$SP_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] || die "邮箱格式不对：$SP_EMAIL"
  case "$SP_AUTH" in basic|link|none) ;; *) die "--auth 只能是 basic、link 或 none" ;; esac
  if [ "$SP_AUTH" = none ]; then ask "不设登录，任何知道地址的人都能进入。确定吗？" n || die "已取消（用 --auth basic 或 --auth link）"; fi

  check_ports
  mkdir -p "$DEPLOY" "$PACK_DIR"
  save_env
  ensure_node
  ensure_caddy
  ensure_user
  npm_install
  fetch_art
  build_zip
  case "$SP_AUTH" in
    basic)
      if [ ${#users[@]} -eq 0 ] && [ ! -s "$USERS_FILE" ]; then users=(friend); fi
      for u in ${users[@]+"${users[@]}"}; do [ -n "$u" ] && { add_user "$u" >/dev/null; say "已创建登录 $u"; }; done ;;
    link) [ -n "$SP_LINK_KEY" ] || SP_LINK_KEY=$(randhex 16) ;;
  esac
  asset_urls
  save_env
  write_caddy
  fix_perms
  write_game_env
  write_units
  open_firewall
  systemctl enable stronghold-game stronghold-caddy >/dev/null 2>&1
  systemctl restart stronghold-game
  systemctl reload-or-restart stronghold-caddy 2>/dev/null || systemctl restart stronghold-caddy
  wait_ready
  print_summary
}

print_summary() {
  print_access
  local z
  z=$(find "$PACK_DIR" -maxdepth 1 -name 'stronghold-assets-*.zip' -print -quit 2>/dev/null || true)
  if [ -n "$z" ]; then
    echo "${B}独立素材包：${N} $z"
    echo "  下载：$(site_url)pack/$(basename "$z")（需要登录）· 或 scp root@服务器:$z ."
    echo "  拿到 zip 的人在任意一个本游戏服务器的「设置 → 素材包」里选择这个文件即可导入。"
  fi
  echo "  云服务器安全组要对 ${SP_DOMAIN:-$SP_IP} 放行 TCP 80、443（以及 UDP 443）。"
  [ -z "$SP_DOMAIN" ] && echo "  请让朋友直接输入 https://$SP_IP/（机房拦截 80 端口时，http:// 不会自动跳转到 https）。"
  return 0
}

restart_all() { systemctl restart stronghold-game; systemctl reload-or-restart stronghold-caddy; }

cmd_update() {
  need_root; load_env; [ -n "$SP_IP$SP_DOMAIN" ] || die "还没有安装：先运行 scripts/$(basename "$0") --ip …"
  if [ -d "$ROOT/.git" ]; then
    say "更新代码…"
    git -C "$ROOT" checkout -- data/assets.json 2>/dev/null || true   # regenerated by the art download below
    local insteadof=()
    [ "$SP_GH_PROXY" != none ] && insteadof=(-c "url.$(gh https://github.com/).insteadOf=https://github.com/")
    git -C "$ROOT" ${insteadof[@]+"${insteadof[@]}"} pull --ff-only || warn "git pull 失败（本地有改动？），继续用当前代码"
  fi
  npm_install
  fetch_art
  build_zip
  asset_urls; save_env; write_caddy; fix_perms; write_game_env; write_units
  restart_all
  wait_ready
  say "已更新（重启会结束正在进行的对局）。"
}

cmd_assets() {
  need_root; load_env; [ -n "$SP_IP$SP_DOMAIN" ] || die "还没有安装"
  fetch_art; build_zip; asset_urls; save_env; write_game_env
  systemctl restart stronghold-game
  print_summary
}

cmd_add_user() {
  [ -n "${1:-}" ] || die "用法：scripts/$(basename "$0") add-user 名字"
  need_root; load_env; [ "$SP_AUTH" = basic ] || die "当前登录方式是 ${SP_AUTH:-未安装}，add-user 只用于 basic"
  local pw; pw=$(add_user "$1")
  write_caddy; fix_perms; systemctl reload stronghold-caddy
  echo "用户 $1 的密码：$pw （也记录在 $CRED_FILE）"
}

cmd_del_user() {
  [ -n "${1:-}" ] || die "用法：scripts/$(basename "$0") del-user 名字"
  need_root; load_env; [ "$SP_AUTH" = basic ] || die "当前登录方式不是 basic"
  grep -q "^$1 " "$USERS_FILE" 2>/dev/null || die "没有用户 $1"
  del_user_quiet "$1"
  write_caddy; fix_perms; systemctl reload stronghold-caddy
  say "已删除 $1"
}

cmd_new_link() {
  need_root; load_env; [ "$SP_AUTH" = link ] || die "当前登录方式不是 link"
  SP_LINK_KEY=$(randhex 16); save_env; write_caddy; fix_perms; systemctl reload stronghold-caddy
  say "新的邀请链接：$(site_url)join/$SP_LINK_KEY （旧链接和旧 Cookie 都已失效）"
}

cmd_retry_cert() {
  need_root; load_env; [ -z "$SP_DOMAIN" ] || die "retry-cert 只用于 IP 证书"
  local fallback="$CADDY_STATE/caddy/certificates/local/$SP_IP" since out i
  # with the internal certificate stored Caddy would only retry Let's Encrypt at its renewal (~8 h)
  rm -rf "$fallback"
  since=$(date '+%Y-%m-%d %H:%M:%S')
  systemctl restart stronghold-caddy
  say "正在向 Let's Encrypt 申请 $SP_IP 的证书（只走 443 端口验证，最多等 2 分钟）…"
  for i in $(seq 1 60); do
    sleep 2
    out=$(journalctl -u stronghold-caddy --since "$since" -o cat --no-pager 2>/dev/null || true)
    if printf '%s' "$out" | grep -q '"certificate obtained successfully".*"issuer":"acme-v02\.api\.letsencrypt\.org'; then
      say "成功：已拿到 Let's Encrypt 正式证书，浏览器不会再提示不安全。"; return 0
    fi
    if printf '%s' "$out" | grep -q '"certificate obtained successfully".*"issuer":"local"'; then
      warn "这次 Let's Encrypt 验证又失败了，仍在用临时证书（不影响游玩）。原因：$(printf '%s' "$out" | grep -o '"detail":"[^"]*"' | tail -1 | cut -d'"' -f4)
  过一段时间再运行 scripts/$(basename "$0") retry-cert（Let's Encrypt 每个 IP 每小时最多允许 5 次失败）。"
      return 0
    fi
  done
  warn "2 分钟内没有结果，Caddy 仍在后台重试：journalctl -u stronghold-caddy -f"
}

cmd_uninstall() {
  need_root
  ask "停止并删除 stronghold-game / stronghold-caddy 服务？（项目目录、deploy/ 里的设置和素材包保留）" n || exit 0
  systemctl disable --now stronghold-game stronghold-caddy 2>/dev/null || true
  rm -f "$UNIT_DIR/stronghold-game.service" "$UNIT_DIR/stronghold-caddy.service"
  systemctl daemon-reload
  if ask "同时删除 $PREFIX（Node.js、Caddy）和证书目录 $CADDY_STATE？" n; then rm -rf "$PREFIX" "$CADDY_STATE"; fi
  say "已卸载。"
}

main() {
  local cmd=${1:-install}
  case "$cmd" in
    help|-h|--help) usage ;;
    install) shift || true; cmd_install "$@" ;;
    -*) cmd_install "$@" ;;
    update) cmd_update ;;
    assets) cmd_assets ;;
    add-user) cmd_add_user "${2:-}" ;;
    del-user) cmd_del_user "${2:-}" ;;
    new-link) cmd_new_link ;;
    users) load_env; print_summary ;;
    status) systemctl --no-pager status stronghold-game stronghold-caddy ;;
    logs) journalctl -u stronghold-game -u stronghold-caddy -f -n 100 ;;
    restart) need_root; restart_all; say "已重启（正在进行的对局会结束）" ;;
    retry-cert) cmd_retry_cert ;;
    uninstall) cmd_uninstall ;;
    *) die "未知命令：$cmd（scripts/$(basename "$0") --help）" ;;
  esac
}

main "$@"
