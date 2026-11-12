#!/usr/bin/env bash
# 把安装包仓库（公开的 Kr1xxxx/WAswitch）里的说明文件同步成源码仓库里的版本。
# 公开仓库只放安装包和下载说明，不放源码。内容没变就不提交。
#   GH_TOKEN=<有公开仓库写权限的令牌> scripts/sync-public-repo.sh [目标仓库，默认 Kr1xxxx/WAswitch]
set -euo pipefail

REPO="${1:-Kr1xxxx/WAswitch}"
BRANCH=main
cd "$(dirname "$0")/.."

# 源文件:公开仓库里的路径
FILES=(
  "build/public-repo/README.md:README.md"
  "docs/clash.md:docs/clash.md"
)

for pair in "${FILES[@]}"; do
  src="${pair%%:*}"
  dest="${pair#*:}"
  want="$(base64 -w0 < "$src")"

  # 读公开仓库里现有的这个文件（不存在就当新建）
  have=""
  sha=""
  if body="$(gh api "repos/${REPO}/contents/${dest}?ref=${BRANCH}" 2>/tmp/sync-err)"; then
    have="$(jq -r '.content' <<<"$body" | tr -d '\n')"
    sha="$(jq -r '.sha' <<<"$body")"
  elif ! grep -q 'HTTP 404' /tmp/sync-err; then
    cat /tmp/sync-err >&2
    echo "读 ${REPO}/${dest} 失败" >&2
    exit 1
  fi

  if [ "$have" = "$want" ]; then
    echo "${dest}：没有变化"
    continue
  fi

  args=(-X PUT "repos/${REPO}/contents/${dest}"
    -f "message=同步 ${dest}" -f "content=${want}" -f "branch=${BRANCH}")
  [ -n "$sha" ] && args+=(-f "sha=${sha}")
  gh api "${args[@]}" --jq '.commit.sha' >/dev/null
  echo "${dest}：已更新"
done
