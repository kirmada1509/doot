#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose -f "$ROOT/infra/compose/docker-compose.yml")
ISSUER="${OIDC_ISSUER:-http://localhost:8080/realms/doot}"
API_PORT="${OIDC_TEST_API_PORT:-4015}"
API_PID=""

cleanup() {
  if [[ -n "$API_PID" ]]; then kill "$API_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

"${COMPOSE[@]}" --profile data up -d keycloak >/dev/null
for _ in $(seq 1 60); do
  curl -fsS "$ISSUER/.well-known/openid-configuration" >/dev/null 2>&1 && break
  sleep 2
done

token_for() {
  curl -fsS -X POST "$ISSUER/protocol/openid-connect/token" \
    -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode client_id=doot-console \
    --data-urlencode grant_type=password \
    --data-urlencode "username=$1" \
    --data-urlencode password=doot-demo | jq -er .access_token
}

OPERATOR_TOKEN="$(token_for demo-operator)"
AUDITOR_TOKEN="$(token_for demo-auditor)"
(
  cd "$ROOT"
  AUTH_MODE=oidc OIDC_ISSUER="$ISSUER" PORT="$API_PORT" \
    pnpm --filter @doot/control-api exec bun src/server.ts >/tmp/doot-oidc-api.log 2>&1
) &
API_PID=$!
for _ in $(seq 1 30); do
  curl -fsS "http://localhost:$API_PORT/health/live" >/dev/null 2>&1 && break
  sleep 1
done

status() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }
[[ "$(status "http://localhost:$API_PORT/v1/ops/cases")" == "401" ]]
[[ "$(status -H "authorization: Bearer $OPERATOR_TOKEN" "http://localhost:$API_PORT/v1/ops/cases")" == "200" ]]

CASE_ID="$(curl -fsS -H "authorization: Bearer $AUDITOR_TOKEN" "http://localhost:$API_PORT/v1/ops/cases" | jq -er '.cases[0].id')"
SENSITIVE_URL="http://localhost:$API_PORT/v1/diagnostics/cases/$CASE_ID/bundle?includeSensitive=true&reason=oidc-regression"
[[ "$(status -H "authorization: Bearer $OPERATOR_TOKEN" "$SENSITIVE_URL")" == "403" ]]
[[ "$(status -H "authorization: Bearer $AUDITOR_TOKEN" "$SENSITIVE_URL")" == "200" ]]

echo "OIDC role and sensitive-access checks passed."
