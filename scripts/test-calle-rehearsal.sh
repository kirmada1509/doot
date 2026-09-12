#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ISSUER="${OIDC_ISSUER:-http://localhost:8080/realms/doot}"
API_PORT="${REHEARSAL_TEST_API_PORT:-4016}"
MOCK_PORT="${MOCK_CALLE_PORT:-4499}"
CASE_ID="case_demo_urgent_001"
CASE_CODE="$(node -e "const {createHash}=require('node:crypto'); console.log(String(createHash('sha256').update('$CASE_ID').digest().readUInt32BE(0)%1000000).padStart(6,'0'))")"
API_PID=""
MOCK_PID=""

cleanup() {
  [[ -z "$API_PID" ]] || kill "$API_PID" 2>/dev/null || true
  [[ -z "$MOCK_PID" ]] || kill "$MOCK_PID" 2>/dev/null || true
}
trap cleanup EXIT

docker compose -f "$ROOT/infra/compose/docker-compose.yml" --profile data up -d keycloak >/dev/null
for _ in $(seq 1 60); do
  curl -fsS "$ISSUER/.well-known/openid-configuration" >/dev/null 2>&1 && break
  sleep 2
done

MOCK_CASE_CODE="$CASE_CODE" MOCK_CALLE_PORT="$MOCK_PORT" node "$ROOT/scripts/mock-calle-api.mjs" >/tmp/doot-calle-mock.log 2>&1 &
MOCK_PID=$!
(
  cd "$ROOT"
  AUTH_MODE=oidc DATA_STORE=memory SEED_DEMO_DATA=true PRIVACY_MODE=local TEMPORAL_ENABLED=false \
    CALL_E_API_KEY=integration-test-key CALL_E_DEMO_TARGET_E164=+14155550123 CALL_E_BASE_URL="http://127.0.0.1:$MOCK_PORT" \
    PORT="$API_PORT" pnpm --filter @doot/control-api exec bun src/server.ts >/tmp/doot-calle-rehearsal-api.log 2>&1
) &
API_PID=$!
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$API_PORT/health/live" >/dev/null 2>&1 && break
  sleep 1
done

token_for() {
  curl -fsS -X POST "$ISSUER/protocol/openid-connect/token" -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode client_id=doot-console --data-urlencode grant_type=password \
    --data-urlencode "username=$1" --data-urlencode password=doot-demo | jq -er .access_token
}
OPERATOR_TOKEN="$(token_for demo-operator)"
AUDITOR_TOKEN="$(token_for demo-auditor)"
URL="http://127.0.0.1:$API_PORT/v1/ops/cases/$CASE_ID/call-e-rehearsal"
BODY='{"confirmed":true,"service":"shelter"}'
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -H "authorization: Bearer $AUDITOR_TOKEN" -H 'content-type: application/json' --data "$BODY" "$URL")" == "403" ]]
FIRST="$(curl -fsS -H "authorization: Bearer $OPERATOR_TOKEN" -H 'content-type: application/json' --data "$BODY" "$URL")"
[[ "$(jq -r .callId <<<"$FIRST")" == "call_integration_1" ]]
SECOND="$(curl -fsS -H "authorization: Bearer $OPERATOR_TOKEN" -H 'content-type: application/json' --data "$BODY" "$URL")"
[[ "$(jq -r .callId <<<"$SECOND")" == "call_integration_1" ]]
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -H "authorization: Bearer $OPERATOR_TOKEN" -H 'content-type: application/json' --data '{"confirmed":true,"service":"respite"}' "$URL")" == "409" ]]
[[ "$(curl -fsS "http://127.0.0.1:$MOCK_PORT/__count" | jq -r .created)" == "1" ]]
RESULT="$(curl -fsS -H "authorization: Bearer $OPERATOR_TOKEN" "$URL")"
[[ "$(jq -r '.rehearsal.verifiedConversation' <<<"$RESULT")" == "true" ]]
[[ "$(jq -r '.rehearsal.availability' <<<"$RESULT")" == "yes" ]]
[[ "$(jq -r '.rehearsal.transcriptAvailable' <<<"$RESULT")" == "true" ]]
TRANSCRIPT="$(curl -fsS -H "authorization: Bearer $OPERATOR_TOKEN" "$URL/transcript")"
[[ "$(jq -r '.turns[1].text' <<<"$TRANSCRIPT")" == *"$CASE_CODE"* ]]
echo "OIDC, single-call idempotency, terminal proof, and audited transcript integration passed (mock CALL-E only)."
