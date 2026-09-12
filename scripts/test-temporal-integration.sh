#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/compose/docker-compose.yml"
API_PORT="${TEMPORAL_TEST_API_PORT:-4020}"
CONTROL_API_URL="http://localhost:$API_PORT"
API_LOG="${TEMPORAL_TEST_API_LOG:-/tmp/doot-temporal-api.log}"
WORKER_LOG="${TEMPORAL_TEST_WORKER_LOG:-/tmp/doot-temporal-worker.log}"
COMMUNICATIONS_LOG="${TEMPORAL_TEST_COMMUNICATIONS_LOG:-/tmp/doot-temporal-communications.log}"
api_pid=""
worker_pid=""
communications_pid=""

cleanup() {
  [[ -n "$worker_pid" ]] && kill "$worker_pid" >/dev/null 2>&1 || true
  [[ -n "$communications_pid" ]] && kill "$communications_pid" >/dev/null 2>&1 || true
  [[ -n "$api_pid" ]] && kill "$api_pid" >/dev/null 2>&1 || true
  [[ -n "$worker_pid" ]] && wait "$worker_pid" >/dev/null 2>&1 || true
  [[ -n "$communications_pid" ]] && wait "$communications_pid" >/dev/null 2>&1 || true
  [[ -n "$api_pid" ]] && wait "$api_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker compose -f "$COMPOSE_FILE" --profile data --profile workflow up -d --wait postgres temporal
cd "$ROOT_DIR"
pnpm db:migrate
PORT="$API_PORT" DATA_STORE=postgres TEMPORAL_ENABLED=true pnpm --filter @doot/control-api exec bun run src/server.ts >"$API_LOG" 2>&1 &
api_pid="$!"
CONTROL_API_URL="$CONTROL_API_URL" pnpm --filter @doot/worker dev >"$WORKER_LOG" 2>&1 &
worker_pid="$!"
for _ in $(seq 1 120); do
  if curl -fsS "$CONTROL_API_URL/health/ready" >/dev/null 2>&1; then
    CONTROL_API_URL="$CONTROL_API_URL" COMMUNICATION_MODE=mock pnpm --filter @doot/communications dev >"$COMMUNICATIONS_LOG" 2>&1 &
    communications_pid="$!"
    if CONTROL_API_URL="$CONTROL_API_URL" pnpm --filter @doot/worker exec tsx test/integration-smoke.ts; then
      exit 0
    fi
    break
  fi
  sleep 1
done

printf 'Temporal integration failed. Control API log:\n' >&2
tail -n 100 "$API_LOG" >&2 || true
printf 'Temporal worker log:\n' >&2
tail -n 140 "$WORKER_LOG" >&2 || true
printf 'Communications worker log:\n' >&2
tail -n 140 "$COMMUNICATIONS_LOG" >&2 || true
exit 1
