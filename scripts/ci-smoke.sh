#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-4010}"
API_URL="${API_URL:-http://localhost:$PORT}"
LOG_FILE="${LOG_FILE:-/tmp/doot-control-api-smoke.log}"

api_pid=""

cleanup() {
  if [[ -n "$api_pid" ]]; then
    kill "$api_pid" >/dev/null 2>&1 || true
    wait "$api_pid" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

cd "$ROOT_DIR"

PORT="$PORT" pnpm --filter @doot/control-api exec bun run src/server.ts >"$LOG_FILE" 2>&1 &
api_pid="$!"

for _ in $(seq 1 60); do
  if curl -fsS "$API_URL/health/ready" >/dev/null 2>&1; then
    API_URL="$API_URL" bash "$ROOT_DIR/scripts/smoke-demo.sh"
    exit 0
  fi

  if ! kill -0 "$api_pid" >/dev/null 2>&1; then
    printf 'Control API exited before becoming ready. Last log lines:\n' >&2
    tail -n 80 "$LOG_FILE" >&2 || true
    exit 1
  fi

  sleep 1
done

printf 'Timed out waiting for Control API at %s. Last log lines:\n' "$API_URL" >&2
tail -n 80 "$LOG_FILE" >&2 || true
exit 1
