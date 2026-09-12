import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { DootConfig } from "@doot/config";
import type { AuditArtifact } from "@doot/contracts";
import { createAuditArtifact } from "@doot/core";

type StoredEnvelope = { ciphertext: string; keyId: string; algorithm: "vault-transit" | "aes-256-gcm" };

export class AuditArchive {
  private readonly localKeys = new Map<string, Buffer>();
  private readonly localObjects = new Map<string, StoredEnvelope>();
  private readonly s3: S3Client;

  constructor(private readonly config: DootConfig) {
    this.s3 = new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY }
    });
  }

  async put(input: { id: string; caseId: string; artifactType: AuditArtifact["artifactType"]; body: Uint8Array; contentType: string; now?: Date }) {
    const now = input.now ?? new Date();
    const objectKey = `${input.caseId}/${input.id}.json`;
    const artifact = createAuditArtifact({ id: input.id, caseId: input.caseId, artifactType: input.artifactType, objectUri: objectKey, now });
    const envelope = this.config.PRIVACY_MODE === "vault-minio"
      ? await this.vaultEncrypt(input.caseId, input.body)
      : this.localEncrypt(input.caseId, input.body);
    if (this.config.PRIVACY_MODE === "vault-minio") {
      await this.s3.send(new PutObjectCommand({
        Bucket: this.config.S3_AUDIT_BUCKET,
        Key: objectKey,
        Body: JSON.stringify(envelope),
        ContentType: input.contentType,
        ObjectLockMode: "GOVERNANCE",
        ObjectLockRetainUntilDate: new Date(artifact.retentionUntil)
      }));
    } else {
      this.localObjects.set(objectKey, envelope);
    }
    return artifact;
  }

  async get(artifact: AuditArtifact): Promise<Uint8Array> {
    const objectKey = objectKeyFromUri(artifact.encryptedObjectUri, this.config.S3_AUDIT_BUCKET);
    const envelope = this.config.PRIVACY_MODE === "vault-minio"
      ? JSON.parse(await streamToString((await this.s3.send(new GetObjectCommand({ Bucket: this.config.S3_AUDIT_BUCKET, Key: objectKey }))).Body)) as StoredEnvelope
      : this.localObjects.get(objectKey);
    if (!envelope) throw new Error("ARCHIVE_OBJECT_NOT_FOUND");
    return envelope.algorithm === "vault-transit"
      ? this.vaultDecrypt(artifact.caseId, envelope)
      : this.localDecrypt(artifact.caseId, envelope);
  }

  async delete(artifact: AuditArtifact) {
    const objectKey = objectKeyFromUri(artifact.encryptedObjectUri, this.config.S3_AUDIT_BUCKET);
    if (this.config.PRIVACY_MODE === "vault-minio") {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.config.S3_AUDIT_BUCKET, Key: objectKey, BypassGovernanceRetention: true }));
    } else {
      this.localObjects.delete(objectKey);
    }
  }

  async destroyCaseKey(caseId: string) {
    if (this.config.PRIVACY_MODE === "vault-minio") {
      await this.vaultRequest(`/v1/transit/keys/${keyName(caseId)}/config`, "POST", { deletion_allowed: true });
      await this.vaultRequest(`/v1/transit/keys/${keyName(caseId)}`, "DELETE");
    } else {
      this.localKeys.delete(caseId);
    }
  }

  private localEncrypt(caseId: string, body: Uint8Array): StoredEnvelope {
    const key = this.localKeys.get(caseId) ?? randomBytes(32);
    this.localKeys.set(caseId, key);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
    return { ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64"), keyId: `local:${keyName(caseId)}`, algorithm: "aes-256-gcm" };
  }

  private localDecrypt(caseId: string, envelope: StoredEnvelope) {
    const key = this.localKeys.get(caseId);
    if (!key) throw new Error("ARCHIVE_KEY_NOT_FOUND");
    const packed = Buffer.from(envelope.ciphertext, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, packed.subarray(0, 12));
    decipher.setAuthTag(packed.subarray(12, 28));
    return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]);
  }

  private async vaultEncrypt(caseId: string, body: Uint8Array): Promise<StoredEnvelope> {
    const name = keyName(caseId);
    await this.vaultRequest(`/v1/transit/keys/${name}`, "POST", { type: "aes256-gcm96" });
    const response = await this.vaultRequest(`/v1/transit/encrypt/${name}`, "POST", { plaintext: Buffer.from(body).toString("base64") });
    return { ciphertext: String(response.data.ciphertext), keyId: `vault:transit:${name}`, algorithm: "vault-transit" };
  }

  private async vaultDecrypt(caseId: string, envelope: StoredEnvelope) {
    const response = await this.vaultRequest(`/v1/transit/decrypt/${keyName(caseId)}`, "POST", { ciphertext: envelope.ciphertext });
    return Buffer.from(String(response.data.plaintext), "base64");
  }

  private async vaultRequest(path: string, method: string, body?: unknown): Promise<any> {
    const response = await fetch(`${this.config.VAULT_ADDR}${path}`, {
      method,
      headers: { "x-vault-token": this.config.VAULT_TOKEN, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) throw new Error(`Vault ${path} returned ${response.status}`);
    return response.status === 204 ? {} : response.json();
  }
}

function keyName(caseId: string) {
  return `doot-case-${createHash("sha256").update(caseId).digest("hex").slice(0, 24)}`;
}

function objectKeyFromUri(uri: string, bucket: string) {
  const prefix = `minio://${bucket}/`;
  if (!uri.startsWith(prefix)) throw new Error("INVALID_ARCHIVE_URI");
  return uri.slice(prefix.length);
}

async function streamToString(body: unknown): Promise<string> {
  if (!body || typeof body !== "object" || !("transformToString" in body)) throw new Error("ARCHIVE_OBJECT_EMPTY");
  return (body as { transformToString(): Promise<string> }).transformToString();
}
