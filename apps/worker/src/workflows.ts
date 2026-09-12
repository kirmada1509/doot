import { CancellationScope, condition, defineQuery, defineSignal, executeChild, proxyActivities, setHandler, sleep } from "@temporalio/workflow";
import type { DecisionSignal, DootCase, Hold, ProviderCallResult } from "@doot/contracts";
import type * as activities from "./activities";

const activity = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 5, initialInterval: "1 second", maximumInterval: "10 seconds" }
});

export const providerResultSignal = defineSignal<[ProviderCallResult]>("providerResult");
export const decisionSignal = defineSignal<[DecisionSignal]>("decision");
export const releaseResultSignal = defineSignal<[{ holdId: string; succeeded: boolean }]>("releaseResult");
export const manualInterventionSignal = defineSignal("manualIntervention");
export const cancelCaseSignal = defineSignal("cancel");
export const safetyHandoffSignal = defineSignal("safetyHandoff");
export const workflowStatusQuery = defineQuery<CaseWorkflowStatus>("status");

export type CaseWorkflowInput = {
  caseId: string;
  workflowId: string;
  providerIds: string[];
  callbackDeadlineAt: string;
  providerTimeoutMs?: number;
  releaseTimeoutMs?: number;
};

export type CaseWorkflowStatus = {
  phase: "fanout" | "callback" | "releasing" | "resolved" | "no_options" | "expired" | "manual_review" | "cancelled" | "safety_handoff";
  providerResults: number;
  releaseResults: number;
  decisionReceived: boolean;
  expiredHolds: number;
};

export type CaseWorkflowResult = CaseWorkflowStatus & { caseId: string; finalState: DootCase["state"] };

export async function providerGoalWorkflow(input: { caseId: string; providerId: string; timeoutMs: number }): Promise<ProviderCallResult> {
  let result: ProviderCallResult | null = null;
  setHandler(providerResultSignal, (value) => { result = value; });
  await activity.requestProviderGoal({ caseId: input.caseId, providerId: input.providerId });
  const received = await condition(() => result !== null, input.timeoutMs);
  if (received && result) return result;
  return {
    caseId: input.caseId,
    providerId: input.providerId,
    externalCallId: `timeout:${input.caseId}:${input.providerId}`,
    outcome: "failed",
    eligibility: { status: "unknown", criteria: [] },
    hold: null,
    evidenceSummary: "Provider goal exceeded its bounded response deadline.",
    confidence: "low"
  };
}

export async function caseWorkflow(input: CaseWorkflowInput): Promise<CaseWorkflowResult> {
  let phase: CaseWorkflowStatus["phase"] = "fanout";
  let decision: DecisionSignal | null = null;
  let manualIntervention = false;
  let cancelled = false;
  let safetyHandoff = false;
  const releaseResults = new Map<string, boolean>();
  const expiredHoldIds = new Set<string>();
  let providerResultCount = 0;
  const status = (): CaseWorkflowStatus => ({
    phase,
    providerResults: providerResultCount,
    releaseResults: releaseResults.size,
    decisionReceived: decision !== null,
    expiredHolds: expiredHoldIds.size
  });

  setHandler(workflowStatusQuery, status);
  setHandler(decisionSignal, (value) => { if (!decision) decision = value; });
  setHandler(releaseResultSignal, (value) => { releaseResults.set(value.holdId, value.succeeded); });
  setHandler(manualInterventionSignal, () => { manualIntervention = true; });
  setHandler(cancelCaseSignal, () => { cancelled = true; });
  setHandler(safetyHandoffSignal, () => { safetyHandoff = true; });

  const caseDeadlineMs = Math.max(0, new Date(input.callbackDeadlineAt).getTime() - Date.now());
  const providerTimeoutMs = Math.min(input.providerTimeoutMs ?? 90_000, caseDeadlineMs);
  const providerScope = new CancellationScope();
  const providerWork = providerScope.run(() => Promise.all(input.providerIds.slice(0, 3).map((providerId) => executeChild(providerGoalWorkflow, {
    workflowId: `${input.workflowId}/provider/${providerId}`,
    args: [{ caseId: input.caseId, providerId, timeoutMs: providerTimeoutMs }]
  }))));
  const providerOutcome = await Promise.race([
    providerWork.then((results) => ({ kind: "completed" as const, results })),
    condition(() => safetyHandoff || manualIntervention || cancelled).then(() => ({ kind: "interrupted" as const }))
  ]);
  if (providerOutcome.kind === "interrupted") {
    providerScope.cancel();
    await providerWork.catch((error) => {
      if (!providerScope.consideredCancelled) throw error;
    });
    phase = safetyHandoff ? "safety_handoff" : cancelled ? "cancelled" : "manual_review";
    if (safetyHandoff) return { ...status(), caseId: input.caseId, finalState: "safety_handoff" };
    const paused = await activity.pauseForManualReview(input.caseId);
    return { ...status(), caseId: input.caseId, finalState: paused.state };
  }
  const providerResults = providerOutcome.results;
  for (const result of providerResults) {
    await activity.recordProviderResult(result);
    providerResultCount += 1;
  }

  if (safetyHandoff || manualIntervention || cancelled) {
    if (safetyHandoff) {
      phase = "safety_handoff";
      return { ...status(), caseId: input.caseId, finalState: "safety_handoff" };
    }
    phase = cancelled ? "cancelled" : "manual_review";
    const paused = await activity.pauseForManualReview(input.caseId);
    return { ...status(), caseId: input.caseId, finalState: paused.state };
  }

  phase = "callback";
  const callbackCase = await activity.requestCallerCallback(input.caseId);
  if (callbackCase.state === "resolved") {
    phase = "resolved";
    return { ...status(), caseId: input.caseId, finalState: "resolved" };
  }
  if (callbackCase.state === "no_options") {
    phase = "no_options";
    return { ...status(), caseId: input.caseId, finalState: "no_options" };
  }

  const activeHolds = callbackCase.holds.filter((hold) => hold.status === "active");
  const expiryScope = new CancellationScope();
  const expiryWatch = expiryScope.run(() => watchHoldExpiries(input.caseId, activeHolds, expiredHoldIds));
  const deadlineMs = Math.max(0, new Date(input.callbackDeadlineAt).getTime() - Date.now());
  const waitOutcome = await Promise.race([
    expiryWatch.then(() => "all_expired" as const),
    condition(() => decision !== null || safetyHandoff || manualIntervention || cancelled, deadlineMs)
      .then((received) => received ? "signal" as const : "deadline" as const)
  ]);
  if (waitOutcome !== "all_expired") {
    expiryScope.cancel();
    await expiryWatch.catch((error) => {
      if (!expiryScope.consideredCancelled) throw error;
    });
  }

  if (safetyHandoff) {
    phase = "safety_handoff";
    return { ...status(), caseId: input.caseId, finalState: "safety_handoff" };
  }

  if (decision) {
    let committed: DootCase;
    try {
      committed = await activity.commitDecision(decision);
    } catch {
      phase = "manual_review";
      const paused = await activity.pauseForManualReview(input.caseId);
      return { ...status(), caseId: input.caseId, finalState: paused.state };
    }
    const pending = committed.holds.filter((hold) => hold.status === "release_pending");
    phase = pending.length > 0 ? "releasing" : "resolved";
    const releaseTimeoutMs = input.releaseTimeoutMs ?? 120_000;
    await Promise.all(pending.map(async (hold) => {
      const received = await condition(() => releaseResults.has(hold.id), releaseTimeoutMs);
      await activity.recordReleaseResult({ caseId: input.caseId, holdId: hold.id, succeeded: received ? releaseResults.get(hold.id)! : false });
    }));
    phase = pending.some((hold) => releaseResults.get(hold.id) !== true) ? "manual_review" : "resolved";
    return { ...status(), caseId: input.caseId, finalState: phase === "resolved" ? "resolved" : "manual_review" };
  }

  if (waitOutcome === "deadline" || manualIntervention || cancelled || expiredHoldIds.size >= activeHolds.length) {
    phase = manualIntervention ? "manual_review" : cancelled ? "cancelled" : "expired";
    const finalCase = manualIntervention || cancelled
      ? await activity.pauseForManualReview(input.caseId)
      : await activity.expireCase(input.caseId);
    return { ...status(), caseId: input.caseId, finalState: finalCase.state };
  }

  phase = "expired";
  const expired = await activity.expireCase(input.caseId);
  return { ...status(), caseId: input.caseId, finalState: expired.state };
}

async function watchHoldExpiries(
  caseId: string,
  holds: Hold[],
  expiredHoldIds: Set<string>
) {
  await Promise.all(holds.map(async (hold) => {
    const delayMs = Math.max(0, new Date(hold.expiresAt).getTime() - Date.now());
    await sleep(delayMs);
    if (expiredHoldIds.has(hold.id)) return;
    const current = await activity.expireHold({ caseId, holdId: hold.id });
    if (current.holds.find((item) => item.id === hold.id)?.status === "expired") expiredHoldIds.add(hold.id);
  }));
}
