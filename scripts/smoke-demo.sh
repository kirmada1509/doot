#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:4000}"

ready="$(curl -fsS "$API_URL/health/ready")"
auth_context="$(curl -fsS "$API_URL/v1/auth/context")"
printf '%s\n' "$auth_context" | node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => { const auth = JSON.parse(data); if (auth.role !== 'operator' || auth.authMode !== 'demo-header') process.exit(1); });"

resolve="$(curl -fsS "$API_URL/v1/telephony/exotel/resolve?callSid=exo_smoke_1&language=en")"
printf '%s\n' "$resolve" | node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => { const body = JSON.parse(data); if (!body.sessionToken || !String(body.sessionUrl).includes('/v1/telephony/exotel/stream/') || String(body.sessionUrl).includes(':4000/')) process.exit(1); });"

curl -fsS -X POST "$API_URL/v1/demo/reset" >/dev/null
cases="$(curl -fsS "$API_URL/v1/ops/cases")"
printf '%s' "$cases" | node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => { const body=JSON.parse(data); if (body.cases.some(c => 'callerPhoneBlindIndex' in c || 'existingReference' in c)) process.exit(1); });"

wrong_existing_status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API_URL/v1/cases" \
  -H 'content-type: application/json' \
  -d '{"callerPhoneBlindIndex":"wrong","utterance":"existing case","existingReference":"D-8842","consentAccepted":true,"recordingAccepted":false,"accessibilityNeeds":[]}')"
if [[ "$wrong_existing_status" != "404" ]]; then
  printf 'Expected mismatched existing-case intake to fail closed, got %s\n' "$wrong_existing_status" >&2
  exit 1
fi

existing="$(curl -fsS -X POST "$API_URL/v1/cases" \
  -H 'content-type: application/json' \
  -d '{"callerPhoneBlindIndex":"blind_existing_8842","utterance":"existing case","existingReference":"D-8842","consentAccepted":true,"recordingAccepted":false,"accessibilityNeeds":[]}')"
printf '%s' "$existing" | node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => { const body=JSON.parse(data); if (body.case.id !== 'case_demo_existing_003' || !body.case.callerVerifiedAt || body.workflow.resumed !== true || 'callerPhoneBlindIndex' in body.case) process.exit(1); });"
artifact_id="$(curl -fsS "$API_URL/v1/audit/artifacts" | node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => console.log(JSON.parse(data).artifacts[0].id));")"

operator_access_status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API_URL/v1/audit/artifacts/$artifact_id/access" \
  -H 'content-type: application/json' \
  -d '{"reason":"smoke test denied"}')"
if [[ "$operator_access_status" != "403" ]]; then
  printf 'Expected operator artifact access to be denied, got %s\n' "$operator_access_status" >&2
  exit 1
fi

artifact_access="$(curl -fsS -X POST "$API_URL/v1/audit/artifacts/$artifact_id/access" \
  -H 'content-type: application/json' \
  -H 'x-doot-role: auditor' \
  -d '{"reason":"smoke test auditor access"}')"
printf '%s' "$artifact_access" | node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => { const body=JSON.parse(data); const decrypted=JSON.parse(Buffer.from(body.contentBase64, 'base64').toString('utf8')); if (!body.allowed || decrypted.fixture !== true) process.exit(1); });"

first_webhook="$(curl -fsS -X POST "$API_URL/v1/webhooks/call-e" \
  -H 'content-type: application/json' \
  -H 'CALL-E-Event-Id: evt_smoke_001' \
  -d '{"id":"evt_smoke_001","status":"completed"}')"
replayed_webhook="$(curl -fsS -X POST "$API_URL/v1/webhooks/call-e" \
  -H 'content-type: application/json' \
  -H 'CALL-E-Event-Id: evt_smoke_001' \
  -d '{"id":"evt_smoke_001","status":"completed"}')"

printf '%s\n%s\n' "$first_webhook" "$replayed_webhook" | node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => { const [first, replay] = data.trim().split('\n').map(JSON.parse); if (!first.accepted || replay.accepted || !replay.duplicate) process.exit(1); });"

case_id="$(printf '%s' "$cases" | node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => console.log(JSON.parse(data).cases[0].id));")"
case_version="$(printf '%s' "$cases" | node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => console.log(JSON.parse(data).cases[0].version));")"
hold_id="$(printf '%s' "$cases" | node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => console.log(JSON.parse(data).cases[0].holds[0].id));")"

decision="$(curl -fsS -X POST "$API_URL/v1/ops/cases/$case_id/actions/decide" \
  -H 'content-type: application/json' \
  -d "{\"caseVersion\":$case_version,\"selectedHoldId\":\"$hold_id\",\"actor\":\"caller\",\"verification\":\"phone_match_and_reference\"}")"

release_id="$(printf '%s' "$decision" | node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => console.log(JSON.parse(data).releasedHoldIds[0] ?? ''));")"

if [[ -n "$release_id" ]]; then
  lease="$(curl -fsS -X POST "$API_URL/v1/ops/outbox/lease")"
  outbox_id="$(printf '%s' "$lease" | node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => console.log(JSON.parse(data).item?.id ?? ''));")"
  if [[ -n "$outbox_id" ]]; then
    curl -fsS -X POST "$API_URL/v1/ops/outbox/$outbox_id/attempt-result" \
      -H 'content-type: application/json' \
      -d '{"status":"sent"}' >/dev/null
  fi
  curl -fsS -X POST "$API_URL/v1/ops/cases/$case_id/actions/release-result" \
    -H 'content-type: application/json' \
    -d "{\"holdId\":\"$release_id\",\"succeeded\":true}" >/dev/null
fi

curl -fsS "$API_URL/v1/diagnostics/cases/$case_id/bundle" >/dev/null
sensitive_bundle="$(curl -fsS "$API_URL/v1/diagnostics/cases/$case_id/bundle?includeSensitive=true&reason=smoke%20diagnostic%20review" -H 'x-doot-role: auditor')"
printf '%s' "$sensitive_bundle" | node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => { const body=JSON.parse(data); if (!body.includeSensitive || !Array.isArray(body.sensitiveArtifacts) || body.sensitiveArtifacts.length === 0 || Buffer.byteLength(data) > 16384) process.exit(1); });"
access_events="$(curl -fsS "$API_URL/v1/audit/access-events" -H 'x-doot-role: auditor')"
printf '%s' "$access_events" | node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => { const body=JSON.parse(data); if (!body.events.some(e => e.reason === 'smoke diagnostic review')) process.exit(1); });"
curl -fsS "$API_URL/metrics" | grep -q "doot_release_pending_holds"
curl -fsS "$API_URL/metrics" | grep -q "doot_voice_dependency_available"
curl -fsS "$API_URL/metrics" | grep -q "doot_callback_deadline_breaches_total"
API_URL="$API_URL" node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify-decision-race.mjs"

printf 'Doot smoke demo passed against %s\n' "$API_URL"
printf 'Readiness: %s\n' "$ready"
