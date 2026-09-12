import type { DootCase, WorkflowLedgerEvent, WorkflowRunResult } from "@doot/contracts";
import { idempotencyKey } from "./ids";
import { applyDecision, confirmRelease, event, normalizeProviderResult } from "./state";

export function appendLedger(
  ledger: WorkflowLedgerEvent[],
  input: Omit<WorkflowLedgerEvent, "id" | "at" | "idempotencyKey"> & { idempotencyParts: string[]; at?: Date }
): WorkflowLedgerEvent[] {
  const idempotency = idempotencyKey(input.idempotencyParts);
  if (ledger.some((item) => item.idempotencyKey === idempotency)) return ledger;
  return [
    ...ledger,
    {
      id: `ledger_${ledger.length + 1}`,
      caseId: input.caseId,
      at: (input.at ?? new Date()).toISOString(),
      type: input.type,
      idempotencyKey: idempotency,
      summary: input.summary
    }
  ];
}

export function simulateCaseWorkflow(current: DootCase, now = new Date()): WorkflowRunResult {
  let ledger: WorkflowLedgerEvent[] = [];
  ledger = appendLedger(ledger, {
    caseId: current.id,
    type: "case.started",
    idempotencyParts: [current.id, "case.started"],
    summary: `Started ${current.workflowId}.`,
    at: now
  });

  for (const attempt of current.attempts.slice(0, 3)) {
    ledger = appendLedger(ledger, {
      caseId: current.id,
      type: "provider.goal_requested",
      idempotencyParts: [current.id, attempt.providerId, "provider.goal_requested"],
      summary: `Requested provider goal run for ${attempt.providerName}.`,
      at: now
    });

    const normalized = normalizeProviderResult({
      caseId: current.id,
      providerId: attempt.providerId,
      externalCallId: attempt.externalCallId,
      outcome: attempt.outcome,
      eligibility: { status: attempt.eligibilityStatus, criteria: [] },
      hold: current.holds.find((hold) => hold.providerId === attempt.providerId)
        ? {
            reference: current.holds.find((hold) => hold.providerId === attempt.providerId)!.reference,
            expiresAt: current.holds.find((hold) => hold.providerId === attempt.providerId)!.expiresAt,
            constraints: current.holds.find((hold) => hold.providerId === attempt.providerId)!.constraints
          }
        : null,
      evidenceSummary: attempt.evidenceSummary,
      confidence: attempt.confidence
    }, now);

    ledger = appendLedger(ledger, {
      caseId: current.id,
      type: "provider.result_recorded",
      idempotencyParts: [current.id, attempt.providerId, attempt.externalCallId, "provider.result_recorded"],
      summary: `${attempt.providerName} returned ${normalized.outcome}.`,
      at: now
    });
  }

  ledger = appendLedger(ledger, {
    caseId: current.id,
    type: "caller.callback_requested",
    idempotencyParts: [current.id, "caller.callback_requested", String(current.version)],
    summary: "Caller callback requested with no more than three choices.",
    at: now
  });

  const selected = current.holds.find((hold) => hold.status === "active");
  const decision = selected
    ? applyDecision(current, {
        caseId: current.id,
        caseVersion: current.version,
        selectedHoldId: selected.id,
        actor: "caller",
        verification: "phone_match_and_reference"
      }, now)
    : { ok: false as const, code: "NO_ACTIVE_HOLD", message: "No active hold to decide.", case: current };

  ledger = appendLedger(ledger, {
    caseId: current.id,
    type: selected ? "decision.received" : "workflow.manual_review",
    idempotencyParts: [current.id, "decision", selected?.id ?? "none", String(current.version)],
    summary: selected ? `Decision received for ${selected.reference}.` : "No active hold was available for decision.",
    at: now
  });

  const afterDecision = decision.ok ? decision.case : decision.case;
  if (decision.ok) {
    for (const holdId of decision.releasedHoldIds) {
      const hold = afterDecision.holds.find((item) => item.id === holdId);
      ledger = appendLedger(ledger, {
        caseId: current.id,
        type: "hold.release_requested",
        idempotencyParts: [current.id, holdId, "hold.release_requested"],
        summary: `Release requested for ${hold?.reference ?? holdId}.`,
        at: now
      });
    }
  }

  const releaseTarget = decision.ok ? decision.releasedHoldIds[0] : undefined;
  const finalCase = releaseTarget ? confirmRelease(afterDecision, releaseTarget, true, now) : afterDecision;

  if (releaseTarget) {
    ledger = appendLedger(ledger, {
      caseId: current.id,
      type: "hold.release_confirmed",
      idempotencyParts: [current.id, releaseTarget, "hold.release_confirmed"],
      summary: `${releaseTarget} release confirmed.`,
      at: now
    });
  }

  if (finalCase.confirmationCallScheduled) {
    ledger = appendLedger(ledger, {
      caseId: current.id,
      type: "confirmation.requested",
      idempotencyParts: [current.id, "confirmation.requested"],
      summary: "Post-commit confirmation requested.",
      at: now
    });
  }

  ledger = appendLedger(ledger, {
    caseId: current.id,
    type: finalCase.state === "resolved" ? "workflow.completed" : "workflow.manual_review",
    idempotencyParts: [current.id, "workflow.terminal", finalCase.state],
    summary: `Workflow finished in ${finalCase.state}.`,
    at: now
  });

  return {
    caseId: finalCase.id,
    workflowId: finalCase.workflowId,
    state: finalCase.state,
    ledger,
    activeHoldCount: finalCase.holds.filter((hold) => hold.status === "active").length,
    releaseDebtCount: finalCase.holds.filter((hold) => hold.status === "release_pending" || hold.status === "release_failed").length
  };
}

export function attachWorkflowEvent(current: DootCase, ledgerEvent: WorkflowLedgerEvent): DootCase {
  return {
    ...current,
    timeline: [
      ...current.timeline,
      event(
        `timeline_${ledgerEvent.id}`,
        new Date(ledgerEvent.at),
        ledgerEvent.type.replaceAll(".", " "),
        ledgerEvent.summary,
        ledgerEvent.type.includes("release") ? "release" : ledgerEvent.type.includes("decision") ? "decision" : "diagnostic"
      )
    ]
  };
}
