#!/usr/bin/env bash
# 发版后不带任何登录，从公开仓库下载 latest.yml、latest-mac.yml、MCP 文件和 yml 里写的安装包，
# 确认都是 200 而且版本号对。已装的软件就是靠这几个地址更新的。最多重试 5 分钟（刚发布时文件可能还没生效）。
#   scripts/verify-public-release.sh v1.0.5 [仓库，默认 Kr1xxxx/WAswitch]
set -euo pipefail

TAG="${1:?用法: verify-public-release.sh v1.2.3 [owner/repo]}"
REPO="${2:-Kr1xxxx/WAswitch}"
VERSION="${TAG#v}"
BASE="${VERIFY_BASE:-https://github.com/${REPO}/releases/download/${TAG}}"
WORK="$(mktemp -d)"

# 下载一个文件（不带 Authorization），成功返回 0
fetch() { curl -sSL --fail --max-time 60 -o "$2" "${BASE}/$1" 2>/dev/null; }
# 只要第一个字节，确认大文件能下
probe() {
  local code
  code="$(curl -sSL --max-time 60 -r 0-0 -o /dev/null -w '%{http_code}' "${BASE}/$1" 2>/dev/null || true)"
  [ "$code" = 200 ] || [ "$code" = 206 ]
}

check_once() {
  local f
  for f in latest.yml latest-mac.yml; do
    fetch "$f" "$WORK/$f" || { echo "还不能下载 $f"; return 1; }
    grep -qE "^version: ${VERSION}\$" "$WORK/$f" || { echo "$f 里的版本号不是 ${VERSION}"; return 1; }
    # yml 里写的安装包文件名（path: 和 files 里的 url:）
    local names
    names="$(sed -nE 's/^[[:space:]-]*(path|url):[[:space:]]*(.+)$/\2/p' "$WORK/$f" | tr -d "'\"" | sort -u)"
    [ -n "$names" ] || { echo "$f 里找不到安装包文件名"; return 1; }
    local n
    while IFS= read -r n; do
      probe "$n" || { echo "还不能下载 $n"; return 1; }
    done <<<"$names"
  done
  probe "waswitch-mcp-${VERSION}.js" || { echo "还不能下载 waswitch-mcp-${VERSION}.js"; return 1; }
  return 0
}

for i in $(seq 1 30); do
  if out="$(check_once)"; then
    echo "不登录可以下载 ${REPO} ${TAG} 的 latest.yml、latest-mac.yml、安装包和 MCP 文件，版本号 ${VERSION}"
    exit 0
  fi
  echo "第 ${i} 次：${out}"
  sleep 10
done
echo "5 分钟后仍然不行：已装的软件会收不到 ${TAG}" >&2
exit 1
