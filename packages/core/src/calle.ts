import type { CalleProviderGoalResult, ProviderCallResult } from "@doot/contracts";
import { CalleProviderGoalResultSchema } from "@doot/contracts";
import { normalizeProviderResult } from "./state";

export function providerResultFromCalleGoal(result: CalleProviderGoalResult, now = new Date()): ProviderCallResult {
  const parsed = CalleProviderGoalResultSchema.parse(result);
  const hold =
    parsed.outcome === "hold_secured" && parsed.hold_reference && parsed.hold_expires_at
      ? {
          reference: parsed.hold_reference,
          expiresAt: parsed.hold_expires_at,
          constraints: parsed.hold_constraints
        }
      : null;

  return normalizeProviderResult(
    {
      caseId: parsed.case_id,
      providerId: parsed.provider_id,
      externalCallId: parsed.external_call_id,
      outcome: parsed.outcome,
      eligibility: {
        status: parsed.eligibility_status,
        criteria: parsed.eligibility_criteria
      },
      hold,
      evidenceSummary: parsed.evidence_summary,
      confidence: parsed.confidence,
      transcriptArtifactId: parsed.transcript_artifact_id || undefined
    },
    now
  );
}
