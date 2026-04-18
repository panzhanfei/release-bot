#!/usr/bin/env bash
# Cursor stop hook: optionally POST /run「发布 全部」到本机 release-bot（后台执行，避免阻塞 IDE）。
set -euo pipefail
cat >/dev/null

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [ ! -f .env ]; then
  exit 0
fi

set -a
# shellcheck disable=SC1090
source .env
set +a

if [ "${RELEASE_AUTO_FULL_RELEASE_ON_AGENT_STOP:-}" != "true" ]; then
  exit 0
fi

PORT="${PORT:-8787}"
LOG="${ROOT}/.cursor/auto-release.log"
BODY="$(
  node -e "
    process.stdout.write(JSON.stringify({
      action: 'release',
      moduleName: 'all',
      confirmToken: process.env.RELEASE_CONFIRM_TOKEN || '',
    }));
  "
)"

(
  echo "=== $(date -Iseconds 2>/dev/null || date) ==="
  curl -fsS -X POST "http://127.0.0.1:${PORT}/run" \
    -H "Content-Type: application/json" \
    -H "x-agent-token: ${AGENT_TOKEN:-}" \
    -d "${BODY}"
  echo
) >>"${LOG}" 2>&1 &

exit 0
