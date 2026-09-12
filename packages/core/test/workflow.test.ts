import { describe, expect, it } from "vitest";
import { createDemoCase, idempotencyKey, simulateCaseWorkflow } from "../src/index";

describe("workflow simulation", () => {
  it("uses stable idempotency keys", () => {
    expect(idempotencyKey(["case", "provider", "goal"])).toBe(idempotencyKey(["case", "provider", "goal"]));
    expect(idempotencyKey(["case", "provider", "goal"])).not.toBe(idempotencyKey(["case", "provider", "other"]));
  });

  it("runs fan-out, decision, release, and confirmation ledger", () => {
    const result = simulateCaseWorkflow(createDemoCase(), new Date("2026-09-11T08:02:00.000Z"));
    expect(result.state).toBe("resolved");
    expect(result.releaseDebtCount).toBe(0);
    expect(result.ledger.map((item) => item.type)).toEqual(expect.arrayContaining([
      "provider.goal_requested",
      "provider.result_recorded",
      "caller.callback_requested",
      "decision.received",
      "hold.release_requested",
      "hold.release_confirmed",
      "confirmation.requested",
      "workflow.completed"
    ]));
  });

  it("deduplicates equivalent ledger events by idempotency key", () => {
    const result = simulateCaseWorkflow(createDemoCase(), new Date("2026-09-11T08:02:00.000Z"));
    const keys = result.ledger.map((item) => item.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
