import type { CommunicationCommand, DootCase, Hold, Provider } from "@doot/contracts";
import { CommunicationCommandSchema } from "@doot/contracts";
import { demoCaseCode, idempotencyKey } from "./ids";

type CommandInput = Pick<DootCase, "id" | "mode" | "language" | "needSummary" | "requestId" | "traceId" | "workflowId">;

function baseCommand(current: CommandInput, kind: CommunicationCommand["kind"], parts: string[]) {
  return {
    caseId: current.id,
    kind,
    idempotencyKey: idempotencyKey([current.id, kind, ...parts]),
    traceId: current.traceId,
    requestId: current.requestId,
    workflowId: current.workflowId,
    language: current.language,
    metadata: {
      caseId: current.id,
      workflowId: current.workflowId,
      traceId: current.traceId,
      requestId: current.requestId
    }
  };
}

export function buildProviderHoldGoalCommand(current: CommandInput, provider: Provider): CommunicationCommand {
  const allowsHold = current.mode !== "planning";
  return CommunicationCommandSchema.parse({
    ...baseCommand(current, "provider_hold_goal", [provider.id]),
    id: `cmd_${current.id}_${provider.id}_hold`,
    channel: "call_e_goal_run",
    target: { providerId: provider.id },
    goal: {
      name: allowsHold ? "Secure provider hold" : "Check provider availability",
      objective: allowsHold
        ? "Call the provider, verify eligibility and real-time availability, and request a short-lived reversible hold."
        : "Call the provider, verify eligibility, and gather non-binding planning availability without reserving capacity.",
      script: [
        "Disclose that Doot is an AI coordination agent calling on behalf of a caller. Speak the six-digit Doot demo case code clearly so the provider answerer can correlate this conversation.",
        "Verify the provider can serve the stated need and any accessibility or language constraints.",
        allowsHold
          ? "Only report hold_secured when the provider gives a reference and future expiry."
          : "Do not request or report a hold; return availability_only or another explicit non-hold outcome."
      ].join(" "),
      input: {
        case_id: current.id,
        demo_case_code: demoCaseCode(current.id),
        provider_id: provider.id,
        provider_name: provider.name,
        need_summary: current.needSummary,
        accepts_holds: String(provider.acceptsHolds),
        allow_hold: String(allowsHold),
        language: current.language
      }
    }
  });
}

export function buildCallerDecisionCallbackCommand(current: DootCase): CommunicationCommand {
  const choices = current.holds
    .filter((hold) => hold.status === "active")
    .slice(0, 3)
    .map((hold, index) => `${index + 1}. ${hold.reference}, expires ${hold.expiresAt}, ${hold.constraints.join("; ")}`)
    .join("\n");

  return CommunicationCommandSchema.parse({
    ...baseCommand(current, "caller_decision_callback", [String(current.version)]),
    id: `cmd_${current.id}_callback_v${current.version}`,
    channel: "call_e_goal_run",
    target: { callerPhoneBlindIndex: current.callerPhoneBlindIndex ?? current.callerLabel },
    goal: {
      name: "Collect one caller decision",
      objective: "Call the requester back, present no more than three viable choices, and collect exactly one decision.",
      script: "Restate that Doot is an AI coordination line, read the options clearly, ask for one choice, and do not auto-select backups.",
      input: {
        case_version: String(current.decisionVersion ?? current.version),
        need_summary: current.needSummary,
        choices,
        choice_ids: current.holds.filter((hold) => hold.status === "active").slice(0, 3).map((hold) => hold.id).join(",")
      }
    }
  });
}

export function buildReleaseHoldCommand(current: CommandInput, hold: Hold): CommunicationCommand {
  return CommunicationCommandSchema.parse({
    ...baseCommand(current, "release_hold_goal", [hold.id, hold.reference]),
    id: `cmd_${current.id}_${hold.id}_release`,
    channel: "call_e_goal_run",
    target: { providerId: hold.providerId, holdId: hold.id, holdReference: hold.reference },
    goal: {
      name: "Release unchosen hold",
      objective: "Call the provider and explicitly release the unchosen hold, recording whether the release was confirmed.",
      script: "Disclose Doot, speak the six-digit demo case code and hold reference, state that the caller chose another option, and ask the provider to confirm release.",
      input: {
        case_id: current.id,
        demo_case_code: demoCaseCode(current.id),
        provider_id: hold.providerId,
        hold_id: hold.id,
        hold_reference: hold.reference,
        hold_expires_at: hold.expiresAt
      }
    },
    metadata: {
      caseId: current.id,
      workflowId: current.workflowId,
      traceId: current.traceId,
      requestId: current.requestId,
      holdId: hold.id
    }
  });
}

export function buildPostCommitConfirmationCommand(current: DootCase): CommunicationCommand {
  const committed = current.holds.find((hold) => hold.status === "committed");
  return CommunicationCommandSchema.parse({
    ...baseCommand(current, "post_commit_confirmation", [committed?.id ?? "none"]),
    id: `cmd_${current.id}_confirmation`,
    channel: "call_e_goal_run",
    target: { holdId: committed?.id, holdReference: committed?.reference, providerId: committed?.providerId },
    goal: {
      name: "Post-commit confirmation",
      objective: "Confirm whether the committed provider honoured the hold and whether the caller reached the resource.",
      script: "Ask a brief outcome question, record whether the hold was honoured, and avoid collecting unrelated sensitive detail.",
      input: {
        committed_hold_id: committed?.id ?? "unknown",
        committed_reference: committed?.reference ?? "unknown",
        provider_id: committed?.providerId ?? "unknown"
      }
    }
  });
}

export function buildComparisonSmsCommand(current: DootCase): CommunicationCommand {
  const options = current.holds.length > 0
    ? current.holds.map((hold) => `${hold.reference}: ${hold.status}, expires ${hold.expiresAt}`).join(" | ")
    : current.attempts.map((attempt) => `${attempt.providerName}: ${attempt.outcome}; ${attempt.evidenceSummary}`).join(" | ");
  return CommunicationCommandSchema.parse({
    ...baseCommand(current, "comparison_sms", [String(current.version)]),
    id: `cmd_${current.id}_sms_v${current.version}`,
    channel: "exotel_sms",
    target: { callerPhoneBlindIndex: current.callerPhoneBlindIndex ?? current.callerLabel },
    goal: {
      name: "Send comparison receipt",
      objective: "Send the caller a compact structured receipt for reference after the voice callback.",
      script: "Send only the comparison, committed reference if known, expiry time, and deletion instructions.",
      input: {
        case_version: String(current.version),
        need_summary: current.needSummary,
        options
      }
    }
  });
}
