#!/usr/bin/env bash
# 在 boxd 上开一台 Linux 机器，装 GitHub Actions runner，给 ci.yml 的 checks 用。
#
# 在自己电脑上跑（先装好 boxd 并 boxd auth login）：
#   bash scripts/boxd-runner.sh
# 它会问注册码：https://github.com/Kr1xxxx/WAswitch/settings/actions/runners/new?arch=x64&os=linux
# 页面里 ./config.sh 那行 --token 后面那串，一小时内有效。注册码不进命令行和 shell 历史。
#
# 机器是 isolated 的：checks 会跑 PR 里的代码，不能让它碰到组织里别的机器、boxd 登录和 gh 凭据。
#
# 装好后在仓库的 Actions 变量里加 CHECKS_RUNNER = ["self-hosted","boxd"]，checks 就换到这台机器；
# 删掉这个变量就回到 GitHub 自带的机器。
set -euo pipefail

MACHINE=${BOXD_MACHINE:-waswitch-ci}
REPO_URL=https://github.com/Kr1xxxx/WAswitch
RUNNER_DIR=actions-runner  # 在机器用户的家目录下

inside() {
  # 普通机器里带着已登录的 boxd 命令行；isolated 机器里没有
  if command -v boxd >/dev/null; then
    echo "这台机器不是 isolated 的，删掉它（boxd machine remove $MACHINE）再跑一遍" >&2; exit 1
  fi
  RUNNER_TOKEN=$(cat ~/.runner-token 2>/dev/null || true); rm -f ~/.runner-token
  local apt="sudo DEBIAN_FRONTEND=noninteractive apt-get"
  $apt update -q
  # 和 GitHub 的 ubuntu-latest 一样的东西：xvfb、字体、Electron（Chromium）要的系统库，XTest 用的 python3
  $apt install -y -q curl git tar xvfb xauth python3 \
    fonts-dejavu-core fonts-dejavu-mono \
    libnss3 libdrm2 libgbm1 libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 \
    libxrandr2 libxss1 libxtst6 libpango-1.0-0 libcairo2 libsecret-1-0 libnotify4
  # 24.04 起这几个包名带 t64
  $apt install -y -q libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libcups2t64 libgtk-3-0t64 \
    || $apt install -y -q libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libgtk-3-0

  cd ~ && mkdir -p "$RUNNER_DIR" && cd "$RUNNER_DIR"
  if [ ! -f .runner ]; then
    [ -n "$RUNNER_TOKEN" ] || { echo "缺注册码" >&2; exit 1; }
    # releases/latest 跳到 .../tag/v2.x.y，取版本号（不走 API，免得撞匿名限流）
    ver=$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/actions/runner/releases/latest | sed 's#.*/v##')
    curl -fsSL "https://github.com/actions/runner/releases/download/v${ver}/actions-runner-linux-x64-${ver}.tar.gz" | tar xz
    sudo ./bin/installdependencies.sh
    ./config.sh --unattended --url "$REPO_URL" --token "$RUNNER_TOKEN" \
      --name "$MACHINE" --labels boxd --work _work --replace
    # GitHub 的机器是 UTC、C.UTF-8
    printf 'LANG=C.UTF-8\nTZ=UTC\n' >> .env
  fi
  [ -f .service ] || sudo ./svc.sh install "$(id -un)"
  sudo ./svc.sh start
  sudo ./svc.sh status | head -5
}

if [ "${1:-}" = "--inside" ]; then inside; exit; fi

command -v boxd >/dev/null || { echo "先装 boxd：curl -fsSL https://boxd.sh/downloads/install.sh | sh"; exit 1; }
read -rsp "注册码（已经装过就直接回车）：" TOKEN; echo
# 4 核 16G；runner 一直连着 GitHub，不让它休眠，不然检查会一直排队
boxd machine get "$MACHINE" >/dev/null 2>&1 \
  || boxd machine new "$MACHINE" --isolated --vcpu 4 --auto-hibernate-timeout=0 --auto-suspend-timeout=0
boxd machine cp "$0" "$MACHINE:boxd-runner.sh"
[ -z "$TOKEN" ] || printf '%s' "$TOKEN" | boxd machine cp - "$MACHINE:.runner-token"
boxd machine exec "$MACHINE" --timeout 900 -e BOXD_MACHINE="$MACHINE" -- bash boxd-runner.sh --inside
echo "装好了。去 $REPO_URL/settings/actions/runners 看 $MACHINE 是不是 Idle。"
