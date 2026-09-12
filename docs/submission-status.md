# Submission Status

## Submission Links And Pending Items

- Public test build and fixture setup: [Doot repository](https://github.com/kirmada1509/doot). Judges can run the no-credential fixture stack from its README.
- Required Awesome Phone Call Agents contribution: [open PR #497](https://github.com/CALLE-AI/awesome-phone-call-agents/pull/497), validated with `python3 scripts/validate_repository.py`.
- Public YouTube/Vimeo video under three minutes: **not recorded or uploaded**.
- CALL-E account email for the Devpost form: **provide privately in the submission form, not this repository**.
- One real answered CALL-E rehearsal: **not yet observed**. Configure an authorized personal number, sign in through OIDC, answer the call, and confirm the case code and transcript before recording.
- Public GitHub Actions: **not executed**. GitHub reports that the account is locked due to a billing issue; the `verify` job did not start. Fix the account and rerun CI. Local lint, tests, integration, and browser checks passed.

## Demonstrated In Fixture Mode

- Browser softphone dialpad, consent, microphone handling, fixture spoken request, audible browser-synthesized Doot turns, caller progress, explicit option choice, and a separate `/ops` view.
- PostgreSQL plus Temporal fan-out to two distinct fixture holds, versioned caller choice, selected commit, alternative release, and no browser-mode PSTN callback or SMS. The external-stack Playwright run passed this path.
- Labeled fixture provider rows, durable outbox and timeline proof, Vault/MinIO archive path, OIDC coverage, OpenAPI drift check, and desktop/mobile keyboard accessibility checks.
- Live-path code for Deepgram Flux, Strands/Bedrock, ElevenLabs, Exotel AgentStream answerers, CALL-E Goal Runs, schema preflight, polling, and ledger verification. Code presence is not a live-call claim.

## One-Call CALL-E Rehearsal Gate: Not Yet Passed

The Control API now has a separate, opt-in Calls API path to one server-allowlisted personal phone. Its OIDC, idempotency, terminal proof, and archived transcript path passed an isolated integration test against a **local fake CALL-E server**; this is not a demonstrated telephone call. A live gate requires an authorized owner to answer and authenticated `GET /v1/calls/{id}` to show a terminal result, an answering transcript turn, and a matching demo case code. Its outcome is a nonbinding synthetic availability check. It cannot create a Doot hold or validate the fixture provider calls. Record the real call ID and a redacted transcript excerpt in the `/ops` Proof view only after this gate passes.

## Full AI-Provider Gate: Not Yet Passed

Two authorized Exotel provider DIDs, published CALL-E Goals with matching schemas and spoken instructions, a stable public WSS endpoint, a validated ElevenLabs voice ID, and working sponsor/AWS credentials must be provisioned and tested. The existing `.env` values and E.164-shaped numbers are unverified. Authenticated read-only checks of the configured provider and release Goals returned `404` and `409`, respectively. No actual CALL-E telephone conversation or release Goal Run has been observed in this work. Until the following is captured, the **two-provider coordination remains fixture-backed**:

1. Authenticated `POST` creates two Goal Run IDs to the authorized Lotus and Ashraya AI numbers.
2. Authenticated `GET` reaches non-null, schema-valid results for both; `201`, `call_id`, or `completed` with null result does not prove a hold.
3. Exotel provider-side transcripts archive under the spoken six-digit case code and match the two Goal Runs. The screen labels them **Provider-side transcript**, not CALL-E transcripts.
4. One browser caller selection commits a ledger-backed hold; the release Goal Run is authenticated, terminal, and the other ledger row is `released`.
5. Capture a clean recording and screenshot only after those checks pass.

## Post-Demo Work

- Validate paid-provider timing, Hindi and Hinglish speech quality, barge-in, 8 kHz endpointing, and long/noisy calls with authorized recordings.
- Run the full load targets, prolonged worker crash/restart tests, and multi-replica browser-session persistence.
- Build Kubernetes/Linkerd, TLS ingress and production secret identities, backup/restore drills, and stronger abuse/rate controls.
- Complete legal/provider approvals, recording language review, emergency handoff protocols, and real-world service inventory agreements. Synthetic holds are not real bookings.
