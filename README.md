# Doot

Doot is a caller-first coordination demonstration for scarce, time-sensitive options. A browser softphone takes a consented spoken request, two fixture provider activities produce reversible demo holds, the caller chooses one, and the other is explicitly released. A separate opt-in CALL-E rehearsal can place one real telephone call to an authorized human answerer. The dialpad is **not a cellular call**. A demo hold is a reservation in synthetic inventory, not a real shelter or respite booking. Doot is **not emergency dispatch**; immediate danger is directed to 112 or 108.

## Fixture Judge Stack

Requires Docker Desktop, Node.js 24, pnpm 9, Bun, and Python 3. Fixture mode calls no paid voice or telephone provider. On a machine with free default ports:

```bash
pnpm install
SEED_DEMO_DATA=false COMMUNICATION_MODE=mock VOICE_PROVIDER_MODE=fixture CALLER_CONTACT_MODE=disabled \
  docker compose -p doot-judge -f infra/compose/docker-compose.yml \
  --profile data --profile workflow --profile observability --profile application up -d --build
```

Open the [caller softphone](http://localhost:3000/), dial `4040`, select Shelter or Respite, allow microphone access after the disclosure, and speak. **Use fixture spoken request** is an explicitly labeled deterministic alternative when audio input is impractical for a judge. Fixture speech output uses the browser's speech engine. [Operations](http://localhost:3000/ops) shows cases, provider commands, explicit operator overrides, and audited proof. API readiness is [here](http://localhost:4000/health/ready); Temporal UI is [here](http://localhost:8088/), Grafana [here](http://localhost:3001/), and Jaeger [here](http://localhost:16686/).

The [caller-first evidence screenshot](docs/assets/doot-caller-first.png) is from the integrated fixture run, not a live CALL-E rehearsal.

## One-Call CALL-E Rehearsal

The fixture stack can also place **one separate, opt-in CALL-E Calls API call** to a phone number you own and answer yourself. It is an authorized human rehearsal, not a call to Lotus or Ashraya and not a provider hold. Set `AUTH_MODE=oidc`, `CALL_E_API_KEY`, and `CALL_E_DEMO_TARGET_E164` in a private `.env` file before starting the stack; the number must be an E.164 number you control. Sign in to `/ops` as an operator through Keycloak. Demo-header authentication is deliberately unable to place paid calls. The Control API, not the browser, holds the number and key. Leave `COMMUNICATION_MODE=mock` and `CALLER_CONTACT_MODE=disabled` so the two-provider fixture journey cannot trigger other telephone calls or SMS.

Create a case through `/`, then open its **Proof and audit** view in `/ops`. Choose Shelter or Respite, confirm ownership/authorization, and press **Place CALL-E rehearsal call** once. Answer your phone, repeat the spoken six-digit demo case code, and discuss only fictional availability. The status, CALL-E call ID, structured answer, and audited transcript excerpt appear after authenticated polling. A `201` acceptance or call ID is not conversation proof; the view verifies an answering turn, completed task, and case-code result. The call **never** creates or commits a hold. If acceptance is uncertain, the retry button reuses the same idempotency key. An actual call may consume a CALL-E credit. Do not put private numbers, API keys, or real care details in video footage.

When host ports are occupied, override `CONSOLE_PORT`, `CONTROL_API_PORT`, `VOICE_RUNTIME_PORT`, and `VOICE_RUNTIME_PUBLIC_WS_URL` together. For example, set `CONSOLE_PORT=3310 CONTROL_API_PORT=4316 VOICE_RUNTIME_PORT=4410 VOICE_RUNTIME_PUBLIC_WS_URL=ws://localhost:4410 CONSOLE_ORIGIN=http://localhost:3310`. Compose also accepts `POSTGRES_HOST_PORT`, `MINIO_HOST_PORT`, `MINIO_CONSOLE_HOST_PORT`, `OTEL_GRPC_HOST_PORT`, `OTEL_HTTP_HOST_PORT`, `JAEGER_HOST_PORT`, and `GRAFANA_HOST_PORT`. Keep the public browser WebSocket URL `wss://` when serving over HTTPS.

For OIDC on an alternate console port, add `http://localhost:<port>/api/auth/callback` to the `doot-console` client's valid redirect URIs in the local Keycloak admin console; the bundled demo realm initially permits port `3000`. Keep `CONSOLE_ORIGIN` equal to that browser origin.

The first Docker build can take several minutes and requires registry access. If the registry is unavailable, the data/workflow containers can run from cached images while the application services run locally; this was how the integrated fixture path was rehearsed in this workspace.

## Full AI-Provider Path (Not Yet Demonstrated)

Live CALL-E mode is **not proven by the fixture test**. Before a live judging run:

1. Provision two authorized Exotel numbers answered by Lotus and Ashraya. Route each VoiceBot/AgentStream inbound stream to `wss://<host>/v1/telephony/exotel/provider/<provider_id>/stream?token=<PROVIDER_ANSWERER_TOKEN>` on a stable public TLS endpoint. The provider IDs are `provider_lotus` and `provider_ashraya`. Configure their actual DIDs in `PROVIDER_PHONE_MAP_JSON` and `EXOTEL_ACCOUNT_SID`; confirm Exotel's `start.to` and account SID match.
2. Publish a CALL-E provider Goal and release Goal for those authorized numbers. Their input schemas must accept the variables in `packages/core/src/commands.ts`; their result schemas must expose the fields checked in `apps/communications/src/adapters.ts`. **The published Goals must contain the actual spoken instructions:** the Goal Run request sends `phone` and `variables`, not Doot's locally built script. The communications service fetches and verifies both published interfaces at startup. CALL-E's Voice Target policy must permit the two DIDs. The currently configured provider Goal returned `404` and release Goal `409` in a read-only preflight; replace or repair them before attempting live mode.
3. Set `CALL_E_API_KEY`, both Goal IDs, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, an AWS Bedrock credential source and region, `PROVIDER_ANSWERER_TOKEN`, and the Exotel values. Set `COMMUNICATION_MODE=live VOICE_PROVIDER_MODE=live SEED_DEMO_DATA=false CALLER_CONTACT_MODE=disabled`. Use a fresh Compose project/database; live startup rejects seeded fixture cases. Set `VOICE_RUNTIME_PUBLIC_WS_URL` to the public WSS endpoint.
4. Perform the [live rehearsal gate](docs/submission-status.md): observe two real Goal Run IDs, authenticated terminal results, answerer-side transcript correlation, one chosen hold, and the release Goal Run. Do not describe this as demonstrated until it passes.

Caller PSTN callbacks and SMS are separately disabled by default. Enabling provider calls does not enable caller contact. The provider answerers use an SQLite demo ledger; even a schema-valid CALL-E result cannot create a hold or confirm a release unless that ledger agrees.

## Verification

```bash
pnpm lint
pnpm test
pnpm test:voice
pnpm test:oidc
pnpm test:calle-rehearsal
pnpm test:openapi
pnpm test:infra
pnpm test:temporal
pnpm smoke
pnpm test:acceptance
```

For Playwright against a running full fixture stack, set `DOOT_ACCEPTANCE_EXTERNAL=1`, `DOOT_ACCEPTANCE_BASE_URL`, and `DOOT_ACCEPTANCE_API_URL` before `pnpm test:acceptance`. The external test verifies two fixture holds, a keyboard choice, and release compensation. See the [demo script](docs/demo-script.md), [submission status](docs/submission-status.md), and [architecture and trust boundaries](docs/architecture.md).
