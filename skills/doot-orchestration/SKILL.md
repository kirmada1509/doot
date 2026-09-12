# Doot Orchestration Skill

Use this skill when implementing case flow, provider fan-out, hold expiry, caller decisions, commits, releases, or diagnostics.

## Checklist

1. Start from `packages/core`; keep workflow policy deterministic and testable.
2. Preserve the state machine: `intake -> safety_screened -> searching -> validating -> awaiting_decision -> committing -> releasing -> resolved`.
3. Reject stale decisions using both hold expiry and case version.
4. Commit the selected hold and mark all other active holds for release in one transition.
5. Treat release failure as visible debt, never as success.
6. Add or update tests for expiry, duplicate decisions, invalid holds, and release recovery.
