import { describe, expect, it } from "vitest";
import { applyDecision, confirmRelease, createDemoCase, createDemoCases, createExistingDemoCase, normalizeProviderResult } from "../src/index";

describe("Doot case state machine", () => {
  it("commits one active hold and marks alternatives for release", () => {
    const current = createDemoCase();
    const result = applyDecision(current, {
      caseId: current.id,
      caseVersion: current.version,
      selectedHoldId: "hold_lotus_18",
      actor: "caller",
      verification: "phone_match_and_reference"
    }, new Date("2026-09-11T08:02:00.000Z"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.case.holds.find((hold) => hold.id === "hold_lotus_18")?.status).toBe("committed");
    expect(result.case.holds.find((hold) => hold.id === "hold_backup_ashraya")?.status).toBe("release_pending");
    expect(result.releasedHoldIds).toEqual(["hold_backup_ashraya"]);
  });

  it("rejects stale decisions", () => {
    const current = createDemoCase();
    const result = applyDecision(current, {
      caseId: current.id,
      caseVersion: current.version - 1,
      selectedHoldId: "hold_lotus_18",
      actor: "caller",
      verification: "phone_match_and_reference"
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("STALE_CASE_VERSION");
  });

  it("accepts the stable decision version after an unrelated hold expires", () => {
    const current = { ...createDemoCase(), decisionVersion: 3, version: 4 };
    const result = applyDecision(current, {
      caseId: current.id,
      caseVersion: 3,
      selectedHoldId: "hold_lotus_18",
      actor: "caller",
      verification: "phone_match_and_reference"
    }, new Date("2026-09-11T08:02:00.000Z"));

    expect(result.ok).toBe(true);
  });

  it("prevents commits after expiry", () => {
    const current = createDemoCase();
    const result = applyDecision(current, {
      caseId: current.id,
      caseVersion: current.version,
      selectedHoldId: "hold_lotus_18",
      actor: "caller",
      verification: "phone_match_and_reference"
    }, new Date("2026-09-11T08:20:00.000Z"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("HOLD_EXPIRED");
    expect(result.case.holds.find((hold) => hold.id === "hold_lotus_18")?.status).toBe("expired");
    expect(result.case.holds.find((hold) => hold.id === "hold_backup_ashraya")?.status).toBe("active");
    expect(result.case.state).toBe("awaiting_decision");
  });

  it("rejects existing-case decisions until phone and reference are verified", () => {
    const current = createExistingDemoCase();
    const result = applyDecision(current, {
      caseId: current.id,
      caseVersion: current.version,
      selectedHoldId: "hold_existing_lotus_22",
      actor: "caller",
      verification: "phone_match_and_reference"
    }, new Date("2026-09-11T10:02:00.000Z"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("EXISTING_CASE_UNVERIFIED");
  });

  it("downgrades invalid holds to availability only", () => {
    const normalized = normalizeProviderResult({
      caseId: "case",
      providerId: "provider",
      externalCallId: "call",
      outcome: "hold_secured",
      eligibility: { status: "eligible", criteria: ["accessible"] },
      hold: { reference: "OLD", expiresAt: "2026-09-11T07:00:00.000Z", constraints: [] },
      evidenceSummary: "Provider said maybe.",
      confidence: "medium"
    }, new Date("2026-09-11T08:00:00.000Z"));

    expect(normalized.outcome).toBe("availability_only");
    expect(normalized.hold).toBeNull();
  });

  it("keeps failed releases visible for manual review", () => {
    const current = createDemoCase();
    const decision = applyDecision(current, {
      caseId: current.id,
      caseVersion: current.version,
      selectedHoldId: "hold_lotus_18",
      actor: "caller",
      verification: "phone_match_and_reference"
    }, new Date("2026-09-11T08:02:00.000Z"));
    if (!decision.ok) throw new Error("decision failed");

    const released = confirmRelease(decision.case, "hold_backup_ashraya", false);
    expect(released.state).toBe("manual_review");
    expect(released.holds.find((hold) => hold.id === "hold_backup_ashraya")?.status).toBe("release_failed");
  });

  it("creates demo coverage for urgent, planning, and existing modes", () => {
    const cases = createDemoCases(new Date("2026-09-11T08:00:00.000Z"));
    expect(cases.map((item) => item.mode)).toEqual(["urgent", "planning", "existing"]);
    expect(cases[1]?.holds).toHaveLength(0);
    expect(cases[2]?.callerLabel).toContain("Verified");
  });
});
