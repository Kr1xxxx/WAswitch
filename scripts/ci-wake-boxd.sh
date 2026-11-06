#!/usr/bin/env bash
# Wakes every boxd machine that hosts our CI runners (label `boxd`; same machines as 来财 CI, D-095 there). The machines pause after 30 minutes
# without inbound traffic and a runner's own polling of GitHub does not wake them; a command run through boxd is an
# inbound connection, so it wakes the machine and restarts its idle timer. Runs on a GitHub machine before the jobs
# that need a boxd runner; those jobs simply wait in the queue until a runner is back online.
# Needs BOXD_API_KEY (repository secret). The key belongs to one boxd org, so every CI machine must be in that org.
set -euo pipefail
if [ -z "${BOXD_API_KEY:-}" ]; then
  echo '::error::BOXD_API_KEY is not set: the boxd machines cannot be woken and the tests wait until they wake up on their own'
  exit 1
fi
dir=${RUNNER_TEMP:-$(mktemp -d)}
manifest=$(curl -fsSL https://boxd.sh/downloads/cli/latest-linux-amd64.json)
url=$(node -e 'console.log(JSON.parse(process.argv[1]).url)' "$manifest")
sum=$(node -e 'console.log(JSON.parse(process.argv[1]).sha256)' "$manifest")
curl -fsSL "$url" -o "$dir/boxd"
echo "$sum  $dir/boxd" | sha256sum -c
chmod +x "$dir/boxd"
BOXD_TOKEN=$(curl -fsS -X POST https://app.boxd.sh/api/v1/auth/token -H 'Content-Type: application/json' \
  -d "$(node -e 'console.log(JSON.stringify({api_key: process.env.BOXD_API_KEY}))')" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.token||j.access_token||"")})')
[ -n "$BOXD_TOKEN" ] || { echo '::error::boxd did not accept BOXD_API_KEY'; exit 1; }
echo "::add-mask::$BOXD_TOKEN"
export BOXD_TOKEN
"$dir/boxd" machine list --json --region all \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const a=Array.isArray(j)?j:(j.machines||j.vms||[]);for(const m of a)console.log(m.name+" "+(m.region||m.region_id||""))})' \
  > "$dir/machines"
cat "$dir/machines"
[ -s "$dir/machines" ] || { echo '::error::boxd lists no machines for this key'; exit 1; }
while read -r name region; do
  "$dir/boxd" machine exec ${region:+--region "$region"} "$name" -- true
done < "$dir/machines"
