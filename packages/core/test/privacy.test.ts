import { describe, expect, it } from "vitest";
import {
  blindIndex,
  createAuditArtifact,
  decideAuditAccess,
  encryptForCase,
  markArtifactDeleted,
  planArtifactDeletion,
  redactTelemetryAttributes
} from "../src/index";

describe("privacy and audit policy", () => {
  it("creates stable blind indexes without retaining plaintext", () => {
    expect(blindIndex("+91 98765 43210")).toBe(blindIndex(" +91 98765 43210 "));
    expect(blindIndex("+91 98765 43210")).not.toContain("98765");
  });

  it("creates envelope encryption metadata for a case", () => {
    const encrypted = encryptForCase("case_1", "+91 98765 43210");
    expect(encrypted.keyId).toBe("vault:transit:case/case_1");
    expect(encrypted.ciphertext).toMatch(/^demoenc:/);
    expect(encrypted.blindIndex).toHaveLength(32);
  });

  it("keeps artifacts until retention expires and then schedules deletion", () => {
    const artifact = createAuditArtifact({
      id: "artifact_1",
      caseId: "case_1",
      artifactType: "transcript",
      objectUri: "case_1/transcript.json",
      now: new Date("2026-09-11T00:00:00.000Z")
    });

    expect(planArtifactDeletion(artifact, new Date("2027-01-01T00:00:00.000Z")).deletionStatus).toBe("retained");
    expect(planArtifactDeletion(artifact, new Date("2027-09-12T00:00:00.000Z")).deletionStatus).toBe("delete_scheduled");
  });

  it("blocks deletion while legal hold is active", () => {
    const artifact = createAuditArtifact({
      id: "artifact_2",
      caseId: "case_1",
      artifactType: "recording",
      objectUri: "case_1/audio.wav",
      legalHold: true
    });

    expect(planArtifactDeletion(artifact, new Date("2030-01-01T00:00:00.000Z")).deletionStatus).toBe("legal_hold_blocked");
    expect(markArtifactDeleted(artifact).deletionStatus).toBe("legal_hold_blocked");
  });

  it("requires auditor role and reason for sensitive artifact access", () => {
    expect(decideAuditAccess({ artifactId: "artifact", actorRole: "operator", reason: "support follow-up" }).allowed).toBe(false);
    expect(decideAuditAccess({ artifactId: "artifact", actorRole: "auditor", reason: "formal audit check" }).allowed).toBe(true);
  });

  it("redacts sensitive telemetry attributes", () => {
    expect(redactTelemetryAttributes({
      trace_id: "trace",
      case_id: "case",
      caller_phone: "+91...",
      transcript_text: "private",
      service_name: "control-api"
    })).toEqual({
      trace_id: "trace",
      case_id: "case",
      service_name: "control-api"
    });
  });
});
