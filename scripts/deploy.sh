#!/usr/bin/env bash
# scripts/deploy.sh — one-click deployment on a Linux server with a public IP and a domain (docs/DEPLOY.md「一键部署」).
#
# Docker Compose stack (deploy/docker-compose.yml): the game server (no art on it: SP_ASSETS=client) behind Caddy, which
# gets the HTTPS certificate, asks for a login (basic auth or an invite link) and serves the art pack at /pack/ for the
# players' browsers to import. State lives in deploy/ (.env, caddy/Caddyfile, users.caddy, credentials.txt, pack/; all
# git-ignored). Re-running keeps the existing settings and passwords.
#
#   sudo scripts/deploy.sh [install] --domain game.example.com [options]   first install / reconfigure (default command)
#   sudo scripts/deploy.sh update            git pull + rebuild + restart (the pack is kept; add --pack build to refresh)
#   sudo scripts/deploy.sh pack              (re)build the art pack in deploy/pack (downloads ~250 MB the first time)
#   sudo scripts/deploy.sh add-user NAME     add a login (basic auth); prints the new password
#   sudo scripts/deploy.sh del-user NAME     remove a login
#   sudo scripts/deploy.sh users             list logins / the invite link
#   sudo scripts/deploy.sh new-link          invalidate the invite link and make a new one (link auth)
#   sudo scripts/deploy.sh status | logs | down
#
# Options (install):
#   --domain NAME        the domain pointing at this server (A/AAAA record) — required on the first install
#   --email ADDR         contact address for the Let's Encrypt / ZeroSSL certificate (optional)
#   --auth MODE          basic (default: user name + password, the browser asks once)
#                        link  (one secret invite link sets a cookie; nothing to type, handy on phones)
#                        none  (no login — anyone who knows the address can play; not recommended)
#   --user NAME          basic auth login to create (repeatable; default: friend)
#   --pack MODE          build (default: download the art and host it at https://<domain>/pack/)
#                        none  (host nothing; players import a zip or use --asset-url)
#                        <dir with pack.json> | <file.zip>   host this pack
#   --asset-url URL      extra download source offered to players (repeatable; a pack directory or a .zip; CORS)
#   -y, --yes            do not ask questions (install Docker when missing, accept defaults)
#
# Env: DOCKER_MIRROR=Aliyun|AzureChinaCloud — mirror for the Docker install script (servers in mainland China).
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$PWD
DEPLOY="$ROOT/deploy"
ENV_FILE="$DEPLOY/.env"
USERS_FILE="$DEPLOY/users.caddy"
CRED_FILE="$DEPLOY/credentials.txt"
CADDY_DIR="$DEPLOY/caddy"   # mounted as a directory: a single-file bind mount would keep the old inode
CADDYFILE="$CADDY_DIR/Caddyfile"
PACK_DIR="$DEPLOY/pack"
CADDY_IMAGE="caddy:2-alpine"
TOOLS_IMAGE="stronghold-tools:local"

ENV_KEYS="SP_DOMAIN SP_EMAIL SP_AUTH SP_PACK SP_ASSET_URL SP_EXTRA_URLS SP_LINK_KEY"
CADDY_UPSTREAM="game:3000"
CADDY_PACK_ROOT="/srv/pack"
# shellcheck source=scripts/lib/deploy-common.sh
. "$ROOT/scripts/lib/deploy-common.sh"
init_env

usage() { sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'; }

# ---- docker --------------------------------------------------------------------------------------------------------

ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    [ "$(id -u)" -eq 0 ] || die "没有 Docker。请用 root 或 sudo 运行本脚本以便自动安装，或先自行安装 Docker。"
    ask "没有找到 Docker，现在用官方脚本 get.docker.com 安装吗？" y || die "需要 Docker：https://docs.docker.com/engine/install/"
    command -v curl >/dev/null 2>&1 || die "需要 curl 来安装 Docker（apt install curl / dnf install curl）"
    say "安装 Docker…"
    if [ -n "${DOCKER_MIRROR:-}" ]; then curl -fsSL https://get.docker.com | sh -s -- --mirror "$DOCKER_MIRROR"
    else curl -fsSL https://get.docker.com | sh; fi
    systemctl enable --now docker >/dev/null 2>&1 || true
  fi
  if ! docker info >/dev/null 2>&1; then
    systemctl start docker >/dev/null 2>&1 || true
    docker info >/dev/null 2>&1 || die "无法连接 Docker（权限不够？用 sudo 运行，或把当前用户加入 docker 组）"
  fi
  docker compose version >/dev/null 2>&1 || die "需要 Docker Compose v2 插件（docker compose）。安装 docker-compose-plugin 后重试。"
}

compose() { docker compose -f "$DEPLOY/docker-compose.yml" --env-file "$ENV_FILE" "$@"; }

# Caddy does not watch its config: apply a rewritten Caddyfile to a running container (no-op when it is not running)
reload_caddy() {
  compose ps -q caddy 2>/dev/null | grep -q . || return 0
  compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || compose restart caddy >/dev/null
}

hash_password() { docker run --rm "$CADDY_IMAGE" caddy hash-password --plaintext "$1" | tr -d '\r\n'; }

# ---- Caddyfile hooks (scripts/lib/deploy-common.sh write_caddyfile) -----------------------------------------------

caddy_site() { printf '%s' "$SP_DOMAIN"; }
caddy_global() { :; }
caddy_tls() { :; }
site_url() { printf 'https://%s/' "$SP_DOMAIN"; }
caddy_validate() {
  docker run --rm -v "$CADDY_DIR:/etc/caddy:ro" "$CADDY_IMAGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 && return 0
  docker run --rm -v "$CADDY_DIR:/etc/caddy:ro" "$CADDY_IMAGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile || true
  return 1
}

# ---- art pack ------------------------------------------------------------------------------------------------------

build_pack() {
  say "构建素材包（第一次要下载约 250 MB，中断后再次运行会续传）…"
  docker build --target tools -t "$TOOLS_IMAGE" "$ROOT"
  mkdir -p "$PACK_DIR"
  # named volumes keep the downloaded art between runs, so an update only fetches what changed
  docker run --rm \
    -v stronghold_art:/app/public/assets -v stronghold_fonts:/app/public/fonts -v stronghold_cache:/app/.cache \
    -v "$PACK_DIR:/out" "$TOOLS_IMAGE"
  [ -f "$PACK_DIR/pack.json" ] || die "素材包没有生成（看上面的下载日志；网络问题可以直接重新运行 scripts/deploy.sh pack）"
  chmod -R a+rX "$PACK_DIR"
  say "素材包：$(du -sh "$PACK_DIR" | cut -f1)（$PACK_DIR）"
}

host_pack_from() { # host_pack_from PATH (dir with pack.json, or a zip)
  local src=$1
  mkdir -p "$PACK_DIR"
  if [ -d "$src" ]; then
    [ -f "$src/pack.json" ] || die "$src 里没有 pack.json（用 node tools/pack-assets.mjs --dir 生成）"
    find "$PACK_DIR" -mindepth 1 -delete
    cp -a "$src/." "$PACK_DIR/"
  elif [ -f "$src" ] && [[ "$src" == *.zip ]]; then
    find "$PACK_DIR" -mindepth 1 -delete
    cp "$src" "$PACK_DIR/"
  else
    die "--pack 需要 build、none、一个带 pack.json 的目录，或一个 .zip 文件：$src"
  fi
  chmod -R a+rX "$PACK_DIR"
}

prepare_pack() {
  case "$SP_PACK" in
    build) if [ -f "$PACK_DIR/pack.json" ] && [ "${FORCE_PACK:-0}" != 1 ]; then say "沿用已有的素材包（重新构建：scripts/deploy.sh pack）"; else build_pack; fi ;;
    none) mkdir -p "$PACK_DIR" ;;
    hosted) mkdir -p "$PACK_DIR" ;;
    *) host_pack_from "$SP_PACK"; SP_PACK=hosted ;;
  esac
  asset_urls
}

# ---- checks --------------------------------------------------------------------------------------------------------

check_dns() {
  local ips pub
  ips=$(getent ahosts "$SP_DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)
  pub=$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || true)
  if [ -z "$ips" ]; then warn "$SP_DOMAIN 还解析不到任何地址：先在域名服务商那里添加 A 记录指向本机${pub:+ ($pub)}，否则申请不到证书。"
  elif [ -n "$pub" ] && [[ " $ips " != *" $pub "* ]]; then warn "$SP_DOMAIN 解析到 $ips，但本机公网 IPv4 是 $pub。请检查 A 记录（用了 CDN 代理的话先关掉代理再申请证书）。"
  fi
}

check_ports() {
  command -v ss >/dev/null 2>&1 || return 0
  local busy
  busy=$(ss -ltnH '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v docker-proxy || true)
  if [ -n "$busy" ] && ! compose ps -q caddy 2>/dev/null | grep -q .; then
    warn "80 / 443 端口已被其他程序占用（nginx / apache？）。Caddy 需要这两个端口：先停掉它们，或改用它们做反向代理（docs/DEPLOY.md 2.4）。"
  fi
}

open_firewall() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw allow 443/udp >/dev/null && say "ufw：已放行 80 / 443"
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-service=http --add-service=https >/dev/null && firewall-cmd --reload >/dev/null && say "firewalld：已放行 http / https"
  fi
}

# ---- summary -------------------------------------------------------------------------------------------------------

print_summary() {
  print_access
  echo "  云服务器的安全组 / 防火墙要放行 TCP 80、443（以及 UDP 443）。证书由 Caddy 自动申请，第一次访问可能要等几十秒。"
}

# ---- commands ------------------------------------------------------------------------------------------------------

cmd_install() {
  local users=() domain= email= auth= pack= extra=() set_extra=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --domain) domain=${2:-}; shift 2 ;;
      --domain=*) domain=${1#*=}; shift ;;
      --email) email=${2:-}; shift 2 ;;
      --email=*) email=${1#*=}; shift ;;
      --auth) auth=${2:-}; shift 2 ;;
      --auth=*) auth=${1#*=}; shift ;;
      --user) users+=("${2:-}"); shift 2 ;;
      --user=*) users+=("${1#*=}"); shift ;;
      --pack) pack=${2:-}; shift 2 ;;
      --pack=*) pack=${1#*=}; shift ;;
      --asset-url) extra+=("${2:-}"); set_extra=1; shift 2 ;;
      --asset-url=*) extra+=("${1#*=}"); set_extra=1; shift ;;
      -y|--yes) YES=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "未知参数：$1（scripts/deploy.sh --help）" ;;
    esac
  done
  load_env
  [ -n "$domain" ] && SP_DOMAIN=$domain
  [ -n "$email" ] && SP_EMAIL=$email
  [ -n "$auth" ] && SP_AUTH=$auth
  [ -n "$pack" ] && SP_PACK=$pack
  [ "$set_extra" = 1 ] && SP_EXTRA_URLS="${extra[*]}"
  if [ -z "$SP_DOMAIN" ] && [ -t 0 ] && [ "$YES" != 1 ]; then read -r -p "域名（已解析到本机，例如 game.example.com）：" SP_DOMAIN; fi
  [ -n "$SP_DOMAIN" ] || die "需要 --domain（指向本服务器的域名）"
  [[ "$SP_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "域名格式不对：$SP_DOMAIN"
  [ -z "$SP_EMAIL" ] || [[ "$SP_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] || die "邮箱格式不对：$SP_EMAIL"
  SP_AUTH=${SP_AUTH:-basic}
  SP_PACK=${SP_PACK:-build}
  case "$SP_AUTH" in basic|link|none) ;; *) die "--auth 只能是 basic、link 或 none" ;; esac

  ensure_docker
  check_dns
  mkdir -p "$DEPLOY" "$PACK_DIR"
  save_env

  case "$SP_AUTH" in
    basic)
      if [ ${#users[@]} -eq 0 ] && [ ! -s "$USERS_FILE" ]; then users=(friend); fi
      for u in ${users[@]+"${users[@]}"}; do [ -n "$u" ] && { add_user "$u" >/dev/null; say "已创建登录 $u"; }; done ;;
    link) [ -n "$SP_LINK_KEY" ] || SP_LINK_KEY=$(randhex 16) ;;
    none) ask "不设登录，任何知道地址的人都能进入。确定吗？" n || die "已取消（用 --auth basic 或 --auth link）" ;;
  esac

  prepare_pack
  save_env
  write_caddyfile
  check_ports
  open_firewall
  say "构建并启动服务…"
  compose up -d --build
  reload_caddy
  say "完成。"
  print_summary
}

cmd_update() {
  load_env; [ -n "$SP_DOMAIN" ] || die "还没有安装：先运行 scripts/deploy.sh --domain …"
  ensure_docker
  if [ "${1:-}" = "--pack" ] && [ "${2:-}" = "build" ]; then FORCE_PACK=1; SP_PACK=build; fi
  if [ -d "$ROOT/.git" ]; then say "git pull…"; git -C "$ROOT" pull --ff-only || warn "git pull 失败（本地有改动？），继续用当前代码构建"; fi
  prepare_pack; save_env; write_caddyfile
  compose up -d --build
  reload_caddy
  say "已更新（重启会结束正在进行的对局）。"
}

cmd_pack() {
  load_env; [ -n "$SP_DOMAIN" ] || die "还没有安装：先运行 scripts/deploy.sh --domain …"
  ensure_docker
  FORCE_PACK=1; SP_PACK=build
  prepare_pack; save_env
  compose up -d >/dev/null
  compose up -d --force-recreate game >/dev/null  # new SP_ASSET_URL
  say "素材包已更新。玩家在游戏「设置 → 素材包」里重新导入即可（版本不同时会有提示）。"
}

cmd_add_user() {
  [ -n "${1:-}" ] || die "用法：scripts/deploy.sh add-user 名字"
  load_env; [ "$SP_AUTH" = basic ] || die "当前登录方式是 ${SP_AUTH:-未安装}，add-user 只用于 basic"
  ensure_docker
  local pw; pw=$(add_user "$1")
  write_caddyfile
  reload_caddy
  echo "用户 $1 的密码：$pw （也记录在 $CRED_FILE）"
}

cmd_del_user() {
  [ -n "${1:-}" ] || die "用法：scripts/deploy.sh del-user 名字"
  load_env; [ "$SP_AUTH" = basic ] || die "当前登录方式不是 basic"
  ensure_docker
  grep -q "^$1 " "$USERS_FILE" 2>/dev/null || die "没有用户 $1"
  del_user_quiet "$1"
  write_caddyfile
  reload_caddy
  say "已删除 $1（已登录的浏览器下次请求时会被要求重新登录）"
}

cmd_new_link() {
  load_env; [ "$SP_AUTH" = link ] || die "当前登录方式不是 link"
  ensure_docker
  SP_LINK_KEY=$(randhex 16); save_env; write_caddyfile
  reload_caddy
  say "新的邀请链接：https://$SP_DOMAIN/join/$SP_LINK_KEY （旧链接和旧 Cookie 都已失效）"
}

main() {
  local cmd=${1:-install}
  case "$cmd" in
    help|-h|--help) usage ;;
    install) shift || true; cmd_install "$@" ;;
    -*) cmd_install "$@" ;;
    update) shift; cmd_update "$@" ;;
    pack) cmd_pack ;;
    add-user) cmd_add_user "${2:-}" ;;
    del-user) cmd_del_user "${2:-}" ;;
    new-link) cmd_new_link ;;
    users) load_env; print_summary ;;
    status) load_env; ensure_docker; compose ps ;;
    logs) load_env; ensure_docker; compose logs -f --tail=200 ;;
    down) load_env; ensure_docker; compose down; say "已停止（数据和素材包都还在 deploy/ 里，重新运行即可启动）" ;;
    *) die "未知命令：$cmd（scripts/deploy.sh --help）" ;;
  esac
}

main "$@"
