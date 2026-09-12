import { describe, expect, it } from "vitest";
import {
  applyDecision,
  buildCallerDecisionCallbackCommand,
  buildComparisonSmsCommand,
  buildPostCommitConfirmationCommand,
  buildProviderHoldGoalCommand,
  buildReleaseHoldCommand,
  createDemoCase,
  createPlanningDemoCase,
  demoProviders,
  idempotencyKey
} from "../src/index";

describe("communication command builders", () => {
  it("builds stable provider hold goal commands with trace metadata", () => {
    const current = createDemoCase();
    const provider = demoProviders[0]!;
    const command = buildProviderHoldGoalCommand(current, provider);

    expect(command.kind).toBe("provider_hold_goal");
    expect(command.channel).toBe("call_e_goal_run");
    expect(command.idempotencyKey).toBe(idempotencyKey([current.id, "provider_hold_goal", provider.id]));
    expect(command.metadata.traceId).toBe(current.traceId);
    expect(command.goal.input.provider_id).toBe(provider.id);
  });

  it("forbids hold requests in planning provider goals", () => {
    const command = buildProviderHoldGoalCommand(createPlanningDemoCase(), demoProviders[0]!);
    expect(command.goal.input.allow_hold).toBe("false");
    expect(command.goal.objective).toContain("non-binding");
  });

  it("limits caller callback choices to three active holds", () => {
    const current = createDemoCase();
    const command = buildCallerDecisionCallbackCommand({
      ...current,
      holds: [
        ...current.holds,
        { ...current.holds[0]!, id: "hold_third", reference: "THIRD" },
        { ...current.holds[0]!, id: "hold_fourth", reference: "FOURTH" }
      ]
    });

    expect(command.goal.input.choices).toContain("1.");
    expect(command.goal.input.choices).toContain("3.");
    expect(command.goal.input.choices).not.toContain("4.");
  });

  it("builds release, confirmation, and SMS commands for committed cases", () => {
    const current = createDemoCase();
    const decision = applyDecision(current, {
      caseId: current.id,
      caseVersion: current.version,
      selectedHoldId: current.holds[0]!.id,
      actor: "caller",
      verification: "phone_match_and_reference"
    }, new Date("2026-09-11T08:02:00.000Z"));

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;

    const release = buildReleaseHoldCommand(decision.case, decision.case.holds.find((hold) => hold.status === "release_pending")!);
    const confirmation = buildPostCommitConfirmationCommand(decision.case);
    const sms = buildComparisonSmsCommand(decision.case);

    expect(release.metadata.holdId).toBe("hold_backup_ashraya");
    expect(confirmation.goal.input.committed_reference).toBe("LOTUS-18");
    expect(sms.channel).toBe("exotel_sms");
  });
});
