import { createHash } from "node:crypto";

export function idempotencyKey(parts: string[]) {
  return createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 32);
}

export function demoCaseCode(caseId: string) {
  return String(createHash("sha256").update(caseId).digest().readUInt32BE(0) % 1_000_000).padStart(6, "0");
}
