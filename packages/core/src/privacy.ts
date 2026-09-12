import { createHash, createHmac, randomBytes } from "node:crypto";
import type { AuditAccessDecision, AuditAccessRequest, AuditArtifact, EnvelopeEncryptionResult } from "@doot/contracts";

const retentionDays = 365;

export function blindIndex(value: string, secret = "doot-demo-blind-index-key") {
  return createHmac("sha256", secret).update(normalize(value)).digest("hex").slice(0, 32);
}

/**
 * Demo-scoped envelope encryption.
 * Production will replace `keyMaterial` with Vault Transit encrypt/decrypt; the
 * ciphertext prefix and keyId already encode the intended transit path so swaps
 * stay localized. Artifacts are addressed under the MinIO audit bucket URI scheme.
 */
export function encryptForCase(caseId: string, plaintext: string, keyMaterial = "doot-demo-vault-transit-key"): EnvelopeEncryptionResult {
  const keyId = `vault:transit:case/${caseId}`;
  const nonce = randomBytes(12).toString("hex");
  const digest = createHash("sha256").update(`${keyMaterial}:${caseId}:${nonce}:${plaintext}`).digest("base64url");
  return {
    caseId,
    keyId,
    ciphertext: `demoenc:${nonce}:${digest}`,
    blindIndex: blindIndex(plaintext)
  };
}

export function createAuditArtifact(input: {
  id: string;
  caseId: string;
  artifactType: AuditArtifact["artifactType"];
  objectUri: string;
  now?: Date;
  legalHold?: boolean;
}): AuditArtifact {
  const now = input.now ?? new Date();
  return {
    id: input.id,
    caseId: input.caseId,
    artifactType: input.artifactType,
    encryptedObjectUri: `minio://doot-audit/${input.objectUri}`,
    retentionUntil: new Date(now.getTime() + retentionDays * 24 * 60 * 60_000).toISOString(),
    legalHold: input.legalHold ?? false,
    deletionStatus: "retained",
    createdAt: now.toISOString()
  };
}

export function planArtifactDeletion(artifact: AuditArtifact, now = new Date()): AuditArtifact {
  if (artifact.legalHold) return { ...artifact, deletionStatus: "legal_hold_blocked" };
  if (new Date(artifact.retentionUntil).getTime() > now.getTime()) return artifact;
  return { ...artifact, deletionStatus: "delete_scheduled" };
}

export function markArtifactDeleted(artifact: AuditArtifact): AuditArtifact {
  if (artifact.legalHold) return { ...artifact, deletionStatus: "legal_hold_blocked" };
  return { ...artifact, deletionStatus: "deleted", encryptedObjectUri: "deleted://non-identifying-proof" };
}

export function decideAuditAccess(request: AuditAccessRequest): AuditAccessDecision {
  if (request.actorRole !== "auditor") {
    return {
      allowed: false,
      reason: "Sensitive artifacts require the auditor role.",
      immutableEventTitle: "Sensitive artifact access denied"
    };
  }
  return {
    allowed: true,
    reason: "Auditor supplied an access reason.",
    immutableEventTitle: "Sensitive artifact access granted"
  };
}

export function redactTelemetryAttributes(attributes: Record<string, string | number | boolean | undefined>) {
  const denied = ["phone", "caller", "transcript", "prompt", "audio", "location", "person_name", "full_name"];
  return Object.fromEntries(
    Object.entries(attributes).filter(([key, value]) => value !== undefined && !denied.some((item) => key.toLowerCase().includes(item)))
  );
}

function normalize(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
