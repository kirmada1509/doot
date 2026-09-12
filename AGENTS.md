# Doot Agent Guide

Doot is a hotline-first coordination system for scarce, perishable options. The core promise is:

`discover -> validate -> hold -> one human decision -> commit -> release alternatives`

## Non-negotiables

- Callers interact by voice and SMS only. The console is internal.
- Doot is not an emergency service. Safety handoff language is spoken before ordinary intake and monitored mid-call.
- Never invent provider facts. Provider-stated evidence is evidence; model inference is not confirmation.
- Only mark `hold_secured` when there is a provider reference and a future expiry.
- Commit exactly one active hold. Release all other active holds as compensating actions.
- Never silently fall back to the caller's second choice after a failed commit.
- Keep phone numbers, transcripts, prompts, and raw audio out of logs, traces, Temporal search attributes, and ordinary diagnostics.

## Repo Map

- `apps/console` internal Next.js operations console.
- `apps/control-api` Bun/Elysia API for cases, webhooks, and operations.
- `apps/communications` CALL-E and Exotel command adapter boundary.
- `apps/worker` Temporal-oriented orchestration entrypoint and local workflow simulation.
- `apps/voice-runtime` FastAPI voice intake boundary.
- `packages/contracts` shared TypeScript contracts and schemas.
- `packages/core` deterministic state machine and demo data.
- `rules` durable engineering and product constraints for agents.
- `skills` repo-local task playbooks.

## Working Style

Prefer deterministic policy code around safety, eligibility, expiry, commit, release, and authorization. Use agents for classification, language, synthesis, and negotiation plans only where policy code can verify the result.
