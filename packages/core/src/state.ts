import type {
  CompactDiagnostics,
  DecisionSignal,
  DootCase,
  Hold,
  ProviderCallResult,
  TimelineEvent
} from "@doot/contracts";
import { ProviderCallResultSchema } from "@doot/contracts";

export type TransitionResult =
  | { ok: true; case: DootCase; releasedHoldIds: string[] }
  | { ok: false; code: string; message: string; case: DootCase };

const iso = (date: Date) => date.toISOString();

const minutesFrom = (base: Date, minutes: number) =>
  iso(new Date(base.getTime() + minutes * 60_000));

export const isFuture = (dateIso: string, now = new Date()) =>
  new Date(dateIso).getTime() > now.getTime();

export function normalizeProviderResult(result: ProviderCallResult, now = new Date()): ProviderCallResult {
  const parsed = ProviderCallResultSchema.parse(result);
  if (parsed.outcome !== "hold_secured") return { ...parsed, hold: null };
  if (!parsed.hold || !isFuture(parsed.hold.expiresAt, now)) {
    return {
      ...parsed,
      outcome: "availability_only",
      hold: null,
      evidenceSummary: `${parsed.evidenceSummary} Hold was downgraded because the reference or future expiry was invalid.`
    };
  }
  return parsed;
}

export function createDemoCase(now = new Date("2026-09-11T08:00:00.000Z")): DootCase {
  const caseId = "case_demo_urgent_001";
  return {
    id: caseId,
    version: 3,
    mode: "urgent",
    state: "awaiting_decision",
    callerLabel: "Caller ending 0427",
    needSummary: "Wheelchair-accessible women-only shelter bed for tonight near Indiranagar.",
    language: "hinglish",
    createdAt: iso(now),
    callbackDeadlineAt: minutesFrom(now, 2),
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    requestId: "01994b76-demo-7cc9-a0a1-7e7f15f63c40",
    workflowId: `case-${caseId}`,
    safety: {
      initialScreenClear: true,
      midCallEscalation: false,
      handoffScript: "If this is life-threatening, call 112 or 108 now. Doot is a coordination line, not emergency dispatch."
    },
    attempts: [
      {
        id: "attempt_lotus",
        caseId,
        providerId: "provider_lotus",
        providerName: "Lotus Night Shelter",
        externalCallId: "calle_goal_lotus_001",
        outcome: "hold_secured",
        eligibilityStatus: "eligible",
        evidenceSummary: "Provider confirmed accessible bed and a hold until 08:14 UTC with reference LOTUS-18.",
        confidence: "high",
        durationSeconds: 52
      },
      {
        id: "attempt_civic",
        caseId,
        providerId: "provider_civic",
        providerName: "Civic Respite Desk",
        externalCallId: "calle_goal_civic_001",
        outcome: "availability_only",
        eligibilityStatus: "eligible",
        evidenceSummary: "Desk reported likely availability but would not reserve without in-person intake.",
        confidence: "medium",
        durationSeconds: 65
      },
      {
        id: "attempt_northstar",
        caseId,
        providerId: "provider_northstar",
        providerName: "Northstar Hostel",
        externalCallId: "calle_goal_northstar_001",
        outcome: "ineligible",
        eligibilityStatus: "ineligible",
        evidenceSummary: "Provider has stairs-only access tonight, so it fails the accessibility requirement.",
        confidence: "high",
        durationSeconds: 34
      }
    ],
    holds: [
      {
        id: "hold_lotus_18",
        caseId,
        providerId: "provider_lotus",
        reference: "LOTUS-18",
        expiresAt: minutesFrom(now, 14),
        status: "active",
        constraints: ["Arrive before 22:00 local time", "Bring any photo ID if available"]
      },
      {
        id: "hold_backup_ashraya",
        caseId,
        providerId: "provider_ashraya",
        reference: "ASHRAYA-7",
        expiresAt: minutesFrom(now, 11),
        status: "active",
        constraints: ["Ground-floor mat space", "Hindi-speaking intake volunteer available"]
      }
    ],
    timeline: [
      event("evt_intake", now, "Intake captured", "AI disclosure, recording notice, deletion instructions, and safety boundary spoken.", "intake"),
      event("evt_safety", new Date(now.getTime() + 10_000), "Safety screen clear", "Caller denied immediate life-threatening danger; ordinary coordination continued.", "safety"),
      event("evt_fanout", new Date(now.getTime() + 20_000), "Fixture provider fan-out", "Three synthetic provider activities are represented in this seeded case; no telephone calls were placed.", "provider"),
      event("evt_holds", new Date(now.getTime() + 75_000), "Two fixture holds", "A synthetic accessible bed and backup hold await one caller decision; neither is a real reservation.", "provider")
    ],
    smsReceiptQueued: true,
    confirmationCallScheduled: false
  };
}

export function createPlanningDemoCase(now = new Date("2026-09-11T09:00:00.000Z")): DootCase {
  const caseId = "case_demo_planning_002";
  return {
    id: caseId,
    version: 2,
    mode: "planning",
    state: "resolved",
    callerLabel: "Caller ending 1180",
    needSummary: "Planning ahead for Hindi-speaking respite options next week.",
    language: "hi",
    createdAt: iso(now),
    callbackDeadlineAt: minutesFrom(now, 480),
    traceId: "7d4c9f89f1f84f4db8a6617a44ef2d31",
    requestId: "01994b76-demo-planning-7e7f15f63c40",
    workflowId: `case-${caseId}`,
    safety: {
      initialScreenClear: true,
      midCallEscalation: false,
      handoffScript: "If this becomes urgent or life-threatening, call 112 or 108 now. Doot is not emergency dispatch."
    },
    attempts: [
      {
        id: "attempt_savera",
        caseId,
        providerId: "provider_savera",
        providerName: "Savera Respite Centre",
        externalCallId: "calle_goal_savera_001",
        outcome: "availability_only",
        eligibilityStatus: "eligible",
        evidenceSummary: "Provider has likely next-week availability and asked for a same-day confirmation call.",
        confidence: "medium",
        durationSeconds: 72
      },
      {
        id: "attempt_asha",
        caseId,
        providerId: "provider_asha",
        providerName: "Asha Community Desk",
        externalCallId: "calle_goal_asha_001",
        outcome: "availability_only",
        eligibilityStatus: "unknown",
        evidenceSummary: "Provider can discuss options after document review; no hold requested because the case is planning mode.",
        confidence: "medium",
        durationSeconds: 58
      }
    ],
    holds: [],
    timeline: [
      event("evt_planning_intake", now, "Planning intake captured", "Caller asked for next-week options; no scarce same-day hold was requested.", "intake"),
      event("evt_planning_safety", new Date(now.getTime() + 8_000), "Safety screen clear", "No immediate danger or mid-call escalation cues were detected.", "safety"),
      event("evt_planning_calls", new Date(now.getTime() + 46_000), "Information calls completed", "Two providers returned availability-only guidance for later follow-up.", "provider"),
      event("evt_planning_sms", new Date(now.getTime() + 62_000), "SMS summary queued", "Caller receives provider comparison as a reference, not as a committed hold.", "commit")
    ],
    smsReceiptQueued: true,
    confirmationCallScheduled: false
  };
}

export function createExistingDemoCase(now = new Date("2026-09-11T10:00:00.000Z")): DootCase {
  const caseId = "case_demo_existing_003";
  return {
    id: caseId,
    version: 5,
    mode: "existing",
    state: "awaiting_decision",
    callerLabel: "Verified caller ending 8842",
    callerPhoneBlindIndex: "blind_existing_8842",
    existingReference: "D-8842",
    callerVerifiedAt: null,
    needSummary: "Returning caller with reference D-8842 wants to confirm or release a live hold.",
    language: "en",
    createdAt: iso(now),
    callbackDeadlineAt: minutesFrom(now, 1),
    traceId: "af3f4f2f05cc4acaa54bece5a703a40d",
    requestId: "01994b76-demo-existing-7e7f15f63c40",
    workflowId: `case-${caseId}`,
    safety: {
      initialScreenClear: true,
      midCallEscalation: false,
      handoffScript: "If this is life-threatening, call 112 or 108 now. Doot is a coordination line, not emergency dispatch."
    },
    attempts: [
      {
        id: "attempt_returning_lotus",
        caseId,
        providerId: "provider_lotus",
        providerName: "Lotus Night Shelter",
        externalCallId: "calle_goal_lotus_existing_001",
        outcome: "hold_secured",
        eligibilityStatus: "eligible",
        evidenceSummary: "Existing reference was verified by phone match and spoken code before modification.",
        confidence: "high",
        durationSeconds: 29
      }
    ],
    holds: [
      {
        id: "hold_existing_lotus_22",
        caseId,
        providerId: "provider_lotus",
        reference: "LOTUS-22",
        expiresAt: minutesFrom(now, 9),
        status: "active",
        constraints: ["Reference D-8842 verified", "Confirm arrival by phone if delayed"]
      }
    ],
    timeline: [
      event("evt_existing_lookup", now, "Existing case found", "Caller matched by phone blind index and spoken reference code.", "audit"),
      event("evt_existing_safety", new Date(now.getTime() + 7_000), "Safety screen clear", "No emergency handoff needed before case management.", "safety"),
      event("evt_existing_prompt", new Date(now.getTime() + 20_000), "Live hold presented", "Caller can confirm, release, or ask Doot to search again.", "decision")
    ],
    smsReceiptQueued: true,
    confirmationCallScheduled: false
  };
}

export function createDemoCases(now = new Date()) {
  return [
    createDemoCase(now),
    createPlanningDemoCase(new Date(now.getTime() + 3 * 60_000)),
    createExistingDemoCase(new Date(now.getTime() + 6 * 60_000))
  ];
}

export function event(
  id: string,
  at: Date,
  title: string,
  detail: string,
  kind: TimelineEvent["kind"]
): TimelineEvent {
  return { id, at: iso(at), title, detail, kind };
}

export function requireExistingCaseVerification(current: DootCase, verification: DecisionSignal["verification"]): TransitionResult | null {
  if (current.mode !== "existing") return null;
  if (verification === "operator_override") return null;
  if (current.callerVerifiedAt) return null;
  return rejected(current, "EXISTING_CASE_UNVERIFIED", "Phone and reference verification is required before modifying an existing case.");
}

export function applyDecision(current: DootCase, signal: DecisionSignal, now = new Date()): TransitionResult {
  if (signal.caseId !== current.id) {
    return rejected(current, "CASE_MISMATCH", "Decision was for a different case.");
  }
  if (signal.caseVersion !== (current.decisionVersion ?? current.version)) {
    return rejected(current, "STALE_CASE_VERSION", "Decision case version is stale.");
  }
  if (current.state !== "awaiting_decision") {
    return rejected(current, "INVALID_STATE", `Cannot decide from ${current.state}.`);
  }
  const verificationGate = requireExistingCaseVerification(current, signal.verification);
  if (verificationGate) return verificationGate;

  const selected = current.holds.find((hold) => hold.id === signal.selectedHoldId);
  if (!selected || selected.status !== "active") {
    return rejected(current, "HOLD_NOT_ACTIVE", "Selected hold is not active.");
  }
  if (!isFuture(selected.expiresAt, now)) {
    return {
      ok: false,
      code: "HOLD_EXPIRED",
      message: "Selected hold expired before the decision could commit.",
      case: expireHold(current, selected.id, now)
    };
  }

  const releasedHoldIds: string[] = [];
  const holds = current.holds.map((hold): Hold => {
    if (hold.id === selected.id) return { ...hold, status: "committed" };
    if (hold.status === "active") {
      releasedHoldIds.push(hold.id);
      return { ...hold, status: "release_pending" };
    }
    return hold;
  });

  const decided = event(
    `evt_decision_${current.version + 1}`,
    now,
    "Caller decision committed",
    `${signal.actor} selected ${selected.reference}; alternatives were marked for release in the same transition.`,
    "decision"
  );
  const release = event(
    `evt_release_${current.version + 1}`,
    now,
    "Alternative release queued",
    releasedHoldIds.length > 0
      ? `${releasedHoldIds.length} unchosen hold(s) are visible until release confirmation.`
      : "No active alternatives needed release.",
    "release"
  );

  return {
    ok: true,
    releasedHoldIds,
    case: {
      ...current,
      version: current.version + 1,
      state: releasedHoldIds.length > 0 ? "releasing" : "resolved",
      holds,
      timeline: [...current.timeline, decided, release],
      confirmationCallScheduled: current.callerChannel !== "browser"
    }
  };
}

export function confirmRelease(current: DootCase, holdId: string, succeeded: boolean, now = new Date()): DootCase {
  const holds = current.holds.map((hold): Hold => {
    if (hold.id !== holdId) return hold;
    return { ...hold, status: succeeded ? "released" : "release_failed" };
  });
  const anyPending = holds.some((hold) => hold.status === "release_pending");
  const anyFailed = holds.some((hold) => hold.status === "release_failed");
  return {
    ...current,
    version: current.version + 1,
    state: current.state === "safety_handoff" ? "safety_handoff" : anyFailed ? "manual_review" : anyPending ? "releasing" : "resolved",
    holds,
    timeline: [
      ...current.timeline,
      event(
        `evt_release_result_${current.version + 1}`,
        now,
        succeeded ? "Release confirmed" : "Release failed",
        succeeded ? `${holdId} was released by the provider.` : `${holdId} needs operator follow-up before closure.`,
        "release"
      )
    ]
  };
}

const DIAGNOSTICS_BYTE_LIMIT = 16 * 1024;

export function buildDiagnostics(
  current: DootCase,
  options: { workflowStatus?: string | null; includeSensitive?: boolean; maxBytes?: number } = {}
): CompactDiagnostics {
  const activeHolds = current.holds.filter((hold) => hold.status === "active" || hold.status === "release_pending");
  const includeSensitive = options.includeSensitive === true;
  const maxBytes = options.maxBytes ?? DIAGNOSTICS_BYTE_LIMIT;
  let latestEvents = current.timeline.slice(-50);
  let truncated = false;
  const base: CompactDiagnostics = {
    caseId: current.id,
    caseState: current.state,
    caseVersion: current.version,
    activeDeadlines: [
      { label: "Caller callback", at: current.callbackDeadlineAt },
      ...activeHolds.map((hold) => ({ label: `${hold.reference} ${hold.status}`, at: hold.expiresAt }))
    ],
    latestEvents,
    providerAttemptSummary: current.attempts.map(
      (attempt) => `${attempt.providerName}: ${attempt.outcome}, eligibility ${attempt.eligibilityStatus}, ${attempt.durationSeconds}s`
    ),
    workflowStatus: options.workflowStatus ?? (current.state === "resolved" ? "completed" : `CaseWorkflow waiting in ${current.state}`),
    firstRelevantError: current.state === "manual_review" ? "A release failed and needs an operator owner." : null,
    links: {
      trace: `http://localhost:16686/trace/${current.traceId}`,
      logs: `http://localhost:3001/explore?trace_id=${current.traceId}`,
      metrics: "http://localhost:3001/d/doot-outcomes"
    },
    nextChecks: [
      "Do not retry with a new CALL-E key if the provider goal run may have been accepted.",
      "Re-fetch terminal CALL-E events before sensitive transitions.",
      "Verify no release_pending hold remains without an alert owner."
    ],
    includeSensitive,
    truncated: false,
    byteSize: 0
  };

  while (true) {
    const encoded = JSON.stringify({ ...base, latestEvents, truncated, byteSize: 0 });
    const byteSize = Buffer.byteLength(encoded, "utf8");
    if (byteSize <= maxBytes || latestEvents.length === 0) {
      return { ...base, latestEvents, truncated, byteSize };
    }
    latestEvents = latestEvents.slice(1);
    truncated = true;
  }
}

export function markHoldExpired(current: DootCase, holdId: string, now = new Date()): DootCase {
  const target = current.holds.find((hold) => hold.id === holdId);
  if (!target || target.status !== "active" || isFuture(target.expiresAt, now)) return current;
  const holds = current.holds.map((hold): Hold => (hold.id === holdId ? { ...hold, status: "expired" } : hold));
  const anyActive = holds.some((hold) => hold.status === "active");
  return {
    ...current,
    version: current.version + 1,
    state: anyActive ? current.state : current.state === "awaiting_decision" ? "expired" : current.state,
    holds,
    timeline: [
      ...current.timeline,
      event(`evt_hold_expired_${current.version + 1}`, now, "Hold expired", `${holdId} expired before commit.`, "commit")
    ]
  };
}

export function outcomeMetrics(cases: DootCase[]) {
  const resolved = cases.filter((item) => item.state === "resolved").length;
  const beforeExpiry = cases.filter((item) =>
    item.holds.some((hold) => hold.status === "committed" && isFuture(hold.expiresAt, new Date(item.createdAt)))
  ).length;
  const orphanHolds = cases.flatMap((item) => item.holds).filter((hold) => hold.status === "release_failed").length;
  const overrides = cases.flatMap((item) => item.timeline).filter((item) => item.detail.includes("operator")).length;
  return {
    totalCases: cases.length,
    resolved,
    eligibleResolvedBeforeExpiry: beforeExpiry,
    orphanHoldRate: cases.length === 0 ? 0 : orphanHolds / cases.length,
    humanOverrideRate: cases.length === 0 ? 0 : overrides / cases.length
  };
}

function expireHold(current: DootCase, holdId: string, now: Date): DootCase {
  return markHoldExpired({ ...current, state: "awaiting_decision" }, holdId, now);
}

function rejected(current: DootCase, code: string, message: string): TransitionResult {
  return { ok: false, code, message, case: current };
}
