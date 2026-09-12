import { describe, expect, it } from "vitest";
import { providerResultFromCalleGoal } from "../src/index";

const base = {
  case_id: "case_1",
  provider_id: "provider_1",
  external_call_id: "call_1",
  eligibility_status: "eligible" as const,
  eligibility_criteria: ["provider-stated eligibility"],
  hold_reference: "REF-1",
  hold_expires_at: "2026-09-11T08:30:00.000Z",
  hold_constraints: ["Bring reference"],
  evidence_summary: "Provider gave a reference and expiry.",
  confidence: "high" as const,
  transcript_artifact_id: "artifact_1"
};

describe("CALL-E goal result adapter", () => {
  it("maps a flat hold result into the internal provider result", () => {
    const result = providerResultFromCalleGoal(
      {
        ...base,
        outcome: "hold_secured"
      },
      new Date("2026-09-11T08:00:00.000Z")
    );

    expect(result.outcome).toBe("hold_secured");
    expect(result.hold?.reference).toBe("REF-1");
    expect(result.eligibility.criteria).toEqual(["provider-stated eligibility"]);
  });

  it("downgrades hold_secured when the flat result lacks a usable future hold", () => {
    const result = providerResultFromCalleGoal(
      {
        ...base,
        outcome: "hold_secured",
        hold_reference: "",
        hold_expires_at: ""
      },
      new Date("2026-09-11T08:00:00.000Z")
    );

    expect(result.outcome).toBe("availability_only");
    expect(result.hold).toBeNull();
  });

  it("keeps non-held outcomes as availability only without hold data", () => {
    const result = providerResultFromCalleGoal(
      {
        ...base,
        outcome: "availability_only",
        hold_reference: "SHOULD-NOT-BE-USED"
      },
      new Date("2026-09-11T08:00:00.000Z")
    );

    expect(result.outcome).toBe("availability_only");
    expect(result.hold).toBeNull();
  });
});
