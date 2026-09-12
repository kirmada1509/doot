import postgres from "postgres";
import type { RehearsalRecord } from "./call-e-rehearsal";
import type { DootConfig } from "@doot/config";
import {
  AuditArtifactSchema,
  DootCaseSchema,
  OutboxItemSchema,
  WebhookInboxEntrySchema,
  type AccessRole,
  type AuditArtifact,
  type CommunicationCommand,
  type DecisionSignal,
  type DootCase,
  type OutboxItem,
  type WebhookInboxEntry
} from "@doot/contracts";
import {
  acceptWebhook as acceptWebhookInMemory,
  blindIndex,
  createAuditArtifact,
  createDemoCases,
  demoProviders,
  enqueueCommand,
  leaseNextOutboxItem,
  recordOutboxAttempt
} from "@doot/core";

type Queryable = postgres.Sql | postgres.TransactionSql;

export type CaseMutation<T> = {
  case: DootCase;
  commands?: CommunicationCommand[];
  decision?: DecisionSignal;
  result: T;
};

export type AuditAccessEvent = {
  id: string;
  artifactId: string;
  actorSubject: string;
  actorRole: AccessRole;
  reason: string;
  allowed: boolean;
  occurredAt: string;
};

export interface StateStore {
  readonly kind: "memory" | "postgres";
  ready(): Promise<boolean>;
  listCases(): Promise<DootCase[]>;
  getCase(caseId: string): Promise<DootCase | null>;
  createCase(value: DootCase): Promise<DootCase>;
  mutateCase<T>(caseId: string, expectedVersion: number | null, mutate: (current: DootCase) => CaseMutation<T>): Promise<T>;
  acceptWebhook(input: { source: WebhookInboxEntry["source"]; externalEventId: string; payload: unknown }): Promise<{ entry: WebhookInboxEntry; accepted: boolean }>;
  listInbox(): Promise<WebhookInboxEntry[]>;
  markInboxProcessed(entryId: string): Promise<WebhookInboxEntry | null>;
  listOutbox(): Promise<OutboxItem[]>;
  leaseOutbox(): Promise<OutboxItem | null>;
  recordOutboxAttempt(itemId: string, result: OutboxAttemptResult): Promise<OutboxItem | null>;
  listArtifacts(): Promise<AuditArtifact[]>;
  putArtifact(artifact: AuditArtifact): Promise<void>;
  replaceArtifacts(artifacts: AuditArtifact[]): Promise<void>;
  recordAuditAccess(event: AuditAccessEvent): Promise<void>;
  listAuditAccess(): Promise<AuditAccessEvent[]>;
  getRehearsal(caseId: string): Promise<RehearsalRecord | null>;
  createRehearsal(record: RehearsalRecord): Promise<RehearsalRecord>;
  updateRehearsal(record: RehearsalRecord): Promise<void>;
  reset(seedCases?: DootCase[]): Promise<DootCase[]>;
  close(): Promise<void>;
}

export type OutboxAttemptResult = {
  status: "pending" | "sent" | "failed" | "dead_lettered";
  error?: string;
  externalRef?: string;
  adapterResponse?: unknown;
  countAttempt?: boolean;
};

export class StoreConflictError extends Error {
  constructor(readonly code: "CASE_NOT_FOUND" | "STALE_CASE_VERSION") {
    super(code === "CASE_NOT_FOUND" ? "Case not found." : "Case version changed before the transaction committed.");
  }
}

export async function createStateStore(config: DootConfig): Promise<StateStore> {
  const store: StateStore = config.DATA_STORE === "postgres"
    ? new PostgresStateStore(config.DATABASE_URL)
    : new MemoryStateStore();
  if (!(await store.ready())) throw new Error(`${store.kind} state store is unavailable`);
  if (config.SEED_DEMO_DATA && (await store.listCases()).length === 0) await store.reset();
  return store;
}

export function initialArtifacts(cases: DootCase[], now = new Date()): AuditArtifact[] {
  return cases.flatMap((item) => [
    createAuditArtifact({ id: `artifact_${item.id}_consent`, caseId: item.id, artifactType: "consent_segment", objectUri: `${item.id}/consent.wav`, now }),
    createAuditArtifact({ id: `artifact_${item.id}_transcript`, caseId: item.id, artifactType: "transcript", objectUri: `${item.id}/transcript.json`, now })
  ]);
}

class MemoryStateStore implements StateStore {
  readonly kind = "memory" as const;
  private cases: DootCase[] = [];
  private inbox: WebhookInboxEntry[] = [];
  private outbox: OutboxItem[] = [];
  private artifacts: AuditArtifact[] = [];
  private auditAccess: AuditAccessEvent[] = [];
  private rehearsals = new Map<string, RehearsalRecord>();

  async ready() { return true; }
  async listCases() { return structuredClone(this.cases); }
  async getCase(caseId: string) { return structuredClone(this.cases.find((item) => item.id === caseId) ?? null); }
  async createCase(value: DootCase) {
    if (this.cases.some((item) => item.id === value.id)) throw new StoreConflictError("STALE_CASE_VERSION");
    this.cases.push(structuredClone(value));
    this.artifacts.push(...initialArtifacts([value]));
    return structuredClone(value);
  }

  async mutateCase<T>(caseId: string, expectedVersion: number | null, mutate: (current: DootCase) => CaseMutation<T>) {
    const index = this.cases.findIndex((item) => item.id === caseId);
    if (index < 0) throw new StoreConflictError("CASE_NOT_FOUND");
    const current = this.cases[index]!;
    if (expectedVersion !== null && current.version !== expectedVersion) throw new StoreConflictError("STALE_CASE_VERSION");
    const mutation = mutate(structuredClone(current));
    this.cases[index] = structuredClone(mutation.case);
    for (const command of mutation.commands ?? []) this.outbox = enqueueCommand(this.outbox, command).outbox;
    return mutation.result;
  }

  async acceptWebhook(input: { source: WebhookInboxEntry["source"]; externalEventId: string; payload: unknown }) {
    const accepted = acceptWebhookInMemory(this.inbox, input);
    this.inbox = accepted.inbox;
    return { entry: accepted.entry, accepted: accepted.accepted };
  }
  async listInbox() { return structuredClone(this.inbox); }
  async markInboxProcessed(entryId: string) {
    this.inbox = this.inbox.map((entry) => entry.id === entryId ? { ...entry, processedAt: new Date().toISOString() } : entry);
    return structuredClone(this.inbox.find((entry) => entry.id === entryId) ?? null);
  }
  async listOutbox() { return structuredClone(this.outbox); }
  async leaseOutbox() {
    const leased = leaseNextOutboxItem(this.outbox);
    this.outbox = leased.outbox;
    return structuredClone(leased.item);
  }
  async recordOutboxAttempt(itemId: string, result: OutboxAttemptResult) {
    this.outbox = recordOutboxAttempt(this.outbox, itemId, result);
    return structuredClone(this.outbox.find((item) => item.id === itemId) ?? null);
  }
  async listArtifacts() { return structuredClone(this.artifacts); }
  async putArtifact(artifact: AuditArtifact) {
    this.artifacts = [...this.artifacts.filter((item) => item.id !== artifact.id), structuredClone(artifact)];
  }
  async replaceArtifacts(artifacts: AuditArtifact[]) { this.artifacts = structuredClone(artifacts); }
  async recordAuditAccess(event: AuditAccessEvent) { this.auditAccess.push(structuredClone(event)); }
  async listAuditAccess() { return structuredClone(this.auditAccess); }
  async getRehearsal(caseId: string) { return structuredClone(this.rehearsals.get(caseId) ?? null); }
  async createRehearsal(record: RehearsalRecord) {
    const existing = this.rehearsals.get(record.caseId);
    if (existing) return structuredClone(existing);
    this.rehearsals.set(record.caseId, structuredClone(record));
    return structuredClone(record);
  }
  async updateRehearsal(record: RehearsalRecord) { this.rehearsals.set(record.caseId, structuredClone(record)); }
  async reset(seedCases = createDemoCases(new Date())) {
    this.cases = structuredClone(seedCases);
    this.inbox = [];
    this.outbox = [];
    this.artifacts = initialArtifacts(seedCases);
    this.auditAccess = [];
    this.rehearsals.clear();
    return this.listCases();
  }
  async close() {}
}

class PostgresStateStore implements StateStore {
  readonly kind = "postgres" as const;
  private readonly sql: postgres.Sql;

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 10 });
  }

  async ready() {
    try {
      await this.sql`select 1`;
      await this.sql`select aggregate from cases limit 1`;
      return true;
    } catch {
      return false;
    }
  }

  async listCases() {
    const rows = await this.sql<{ aggregate: unknown }[]>`select aggregate from cases order by created_at asc`;
    return rows.map((row) => DootCaseSchema.parse(row.aggregate));
  }

  async getCase(caseId: string) {
    const rows = await this.sql<{ aggregate: unknown }[]>`select aggregate from cases where id = ${caseId}`;
    return rows[0] ? DootCaseSchema.parse(rows[0].aggregate) : null;
  }

  async createCase(value: DootCase) {
    await this.sql.begin(async (transaction) => {
      await persistCase(transaction, value, true);
      for (const artifact of initialArtifacts([value])) await persistArtifact(transaction, artifact);
    });
    return value;
  }

  async mutateCase<T>(caseId: string, expectedVersion: number | null, mutate: (current: DootCase) => CaseMutation<T>) {
    return this.sql.begin(async (transaction) => {
      const rows = await transaction<{ aggregate: unknown }[]>`select aggregate from cases where id = ${caseId} for update`;
      if (!rows[0]) throw new StoreConflictError("CASE_NOT_FOUND");
      const current = DootCaseSchema.parse(rows[0].aggregate);
      if (expectedVersion !== null && current.version !== expectedVersion) throw new StoreConflictError("STALE_CASE_VERSION");
      const mutation = mutate(current);
      await persistCase(transaction, mutation.case);
      if (mutation.decision) {
        const decision = mutation.decision;
        await transaction`
          insert into decisions (id, case_id, case_version, selected_hold_id, actor, verification)
          values (${`decision_${decision.caseId}_${decision.caseVersion}`}, ${decision.caseId}, ${decision.caseVersion}, ${decision.selectedHoldId}, ${decision.actor}, ${decision.verification})
          on conflict (case_id, case_version) do nothing
        `;
      }
      for (const command of mutation.commands ?? []) await enqueuePostgres(transaction, command);
      return mutation.result;
    }) as Promise<T>;
  }

  async acceptWebhook(input: { source: WebhookInboxEntry["source"]; externalEventId: string; payload: unknown }) {
    const entry = acceptWebhookInMemory([], input).entry;
    const inserted = await this.sql`
      insert into webhook_inbox (id, source, external_event_id, payload, received_at)
      values (${entry.id}, ${entry.source}, ${entry.externalEventId}, ${this.sql.json(entry.payload as never)}, ${entry.receivedAt})
      on conflict (source, external_event_id) do nothing
      returning id
    `;
    if (inserted.length > 0) return { entry, accepted: true };
    const rows = await this.sql`select * from webhook_inbox where source = ${input.source} and external_event_id = ${input.externalEventId}`;
    return { entry: { ...mapInbox(rows[0]!), duplicate: true }, accepted: false };
  }

  async listInbox() {
    const rows = await this.sql`select * from webhook_inbox order by received_at desc`;
    return rows.map(mapInbox);
  }

  async markInboxProcessed(entryId: string) {
    const rows = await this.sql`update webhook_inbox set processed_at = coalesce(processed_at, now()) where id = ${entryId} returning *`;
    return rows[0] ? mapInbox(rows[0]) : null;
  }

  async listOutbox() {
    const rows = await this.sql`select * from outbox_items order by created_at asc`;
    return rows.map(mapOutbox);
  }

  async leaseOutbox() {
    return this.sql.begin(async (transaction) => {
      const rows = await transaction`
        select id from outbox_items
        where status = 'pending' or (status = 'leased' and lease_until < now())
        order by created_at asc for update skip locked limit 1
      `;
      if (!rows[0]) return null;
      const updated = await transaction`
        update outbox_items set status = 'leased', lease_until = now() + interval '30 seconds', updated_at = now() where id = ${rows[0].id} returning *
      `;
      return mapOutbox(updated[0]!);
    });
  }

  async recordOutboxAttempt(itemId: string, result: OutboxAttemptResult) {
    const rows = await this.sql`
      update outbox_items
      set status = ${result.status}, attempts = attempts + ${result.countAttempt === false ? 0 : 1}, last_error = ${result.error ?? null},
          lease_until = null, external_ref = coalesce(${result.externalRef ?? null}, external_ref),
          adapter_response = coalesce(${result.adapterResponse === undefined ? null : this.sql.json(result.adapterResponse as never)}, adapter_response),
          updated_at = now()
      where id = ${itemId}
      returning *
    `;
    return rows[0] ? mapOutbox(rows[0]) : null;
  }

  async listArtifacts() {
    const rows = await this.sql`select * from audit_artifacts order by created_at asc`;
    return rows.map(mapArtifact);
  }

  async putArtifact(artifact: AuditArtifact) {
    await persistArtifact(this.sql, artifact);
  }

  async replaceArtifacts(artifacts: AuditArtifact[]) {
    await this.sql.begin(async (transaction) => {
      for (const artifact of artifacts) await persistArtifact(transaction, artifact);
    });
  }

  async recordAuditAccess(event: AuditAccessEvent) {
    await this.sql`
      insert into audit_access_events (id, artifact_id, actor_subject, actor_role, reason, allowed, occurred_at)
      values (${event.id}, ${event.artifactId}, ${event.actorSubject}, ${event.actorRole}, ${event.reason}, ${event.allowed}, ${event.occurredAt})
      on conflict (id) do nothing
    `;
  }

  async listAuditAccess() {
    const rows = await this.sql`select * from audit_access_events order by occurred_at desc`;
    return rows.map((row) => ({
      id: String(row.id),
      artifactId: String(row.artifact_id),
      actorSubject: String(row.actor_subject),
      actorRole: String(row.actor_role) as AccessRole,
      reason: String(row.reason),
      allowed: Boolean(row.allowed),
      occurredAt: new Date(row.occurred_at).toISOString()
    }));
  }

  async getRehearsal(caseId: string) {
    const rows = await this.sql`select * from call_e_rehearsals where case_id = ${caseId}`;
    return rows[0] ? mapRehearsal(rows[0]) : null;
  }

  async createRehearsal(record: RehearsalRecord) {
    await this.sql`
      insert into call_e_rehearsals (case_id, idempotency_key, actor_subject, service, status, created_at, updated_at)
      values (${record.caseId}, ${record.idempotencyKey}, ${record.actorSubject}, ${record.service}, ${record.status}, ${record.createdAt}, ${record.updatedAt})
      on conflict (case_id) do nothing
    `;
    return (await this.getRehearsal(record.caseId))!;
  }

  async updateRehearsal(record: RehearsalRecord) {
    await this.sql`
      update call_e_rehearsals set call_id = coalesce(${record.callId}, call_id), status = ${record.status},
        availability = ${record.availability}, case_code_confirmed = ${record.caseCodeConfirmed}, answered = ${record.answered}, case_code_spoken = ${record.caseCodeSpoken},
        task_completed = ${record.taskCompleted}, transcript_artifact_id = coalesce(${record.transcriptArtifactId}, transcript_artifact_id),
        error_code = ${record.errorCode}, updated_at = ${record.updatedAt}, completed_at = ${record.completedAt}
      where case_id = ${record.caseId}
    `;
  }

  async reset(seedCases = createDemoCases(new Date())) {
    await this.sql.begin(async (transaction) => {
      await transaction`truncate call_e_rehearsals, audit_access_events, audit_artifacts, outbox_items, webhook_inbox, decisions, timeline_events, holds, provider_attempts, providers, cases cascade`;
      for (const provider of demoProviders) {
        await transaction`
          insert into providers (id, name, service_tags, location_tags, accessibility_tags, languages, accepts_holds, active, reliability_score, reliability)
          values (${provider.id}, ${provider.name}, ${provider.serviceTags}, ${provider.locationTags}, ${provider.accessibilityTags}, ${provider.languages}, ${provider.acceptsHolds}, ${provider.active}, ${reliabilityScore(provider.reliability)}, ${transaction.json(provider.reliability)})
        `;
      }
      for (const attempt of seedCases.flatMap((item) => item.attempts)) {
        await transaction`
          insert into providers (id, name, service_tags, location_tags, accessibility_tags, languages, accepts_holds, active, reliability_score, reliability)
          values (${attempt.providerId}, ${attempt.providerName}, ${["shelter"]}, ${[]}, ${[]}, ${["en"]}, ${false}, ${true}, ${0.5}, ${transaction.json({ answeredCallRate: 0.5, holdHonourRate: 0.5, orphanHoldRate: 0, averageResponseSeconds: attempt.durationSeconds })})
          on conflict (id) do nothing
        `;
      }
      for (const item of seedCases) await persistCase(transaction, item, true);
      for (const artifact of initialArtifacts(seedCases)) await persistArtifact(transaction, artifact);
    });
    return this.listCases();
  }

  async close() { await this.sql.end(); }
}

async function persistCase(sql: Queryable, item: DootCase, inserting = false) {
  const aggregate = sql.json(item as never);
  if (inserting) {
    await sql`
      insert into cases (id, version, mode, state, caller_blind_index, caller_label, need_summary, language, callback_deadline_at, trace_id, request_id, workflow_id, created_at, updated_at, safety, sms_receipt_queued, confirmation_call_scheduled, aggregate)
      values (${item.id}, ${item.version}, ${item.mode}, ${item.state}, ${item.callerPhoneBlindIndex ?? blindIndex(item.callerLabel)}, ${item.callerLabel}, ${item.needSummary}, ${item.language}, ${item.callbackDeadlineAt}, ${item.traceId}, ${item.requestId}, ${item.workflowId}, ${item.createdAt}, now(), ${sql.json(item.safety)}, ${item.smsReceiptQueued}, ${item.confirmationCallScheduled}, ${aggregate})
    `;
  } else {
    await sql`
      update cases set version = ${item.version}, mode = ${item.mode}, state = ${item.state}, caller_label = ${item.callerLabel}, need_summary = ${item.needSummary}, language = ${item.language}, callback_deadline_at = ${item.callbackDeadlineAt}, updated_at = now(), safety = ${sql.json(item.safety)}, sms_receipt_queued = ${item.smsReceiptQueued}, confirmation_call_scheduled = ${item.confirmationCallScheduled}, aggregate = ${aggregate}
      where id = ${item.id}
    `;
  }

  for (const attempt of item.attempts) {
    await sql`
      insert into provider_attempts (id, case_id, provider_id, external_call_id, outcome, eligibility_status, evidence_summary, confidence, duration_seconds)
      values (${attempt.id}, ${attempt.caseId}, ${attempt.providerId}, ${attempt.externalCallId}, ${attempt.outcome}, ${attempt.eligibilityStatus}, ${attempt.evidenceSummary}, ${attempt.confidence}, ${attempt.durationSeconds})
      on conflict (id) do update set outcome = excluded.outcome, eligibility_status = excluded.eligibility_status, evidence_summary = excluded.evidence_summary, confidence = excluded.confidence, duration_seconds = excluded.duration_seconds
    `;
  }
  for (const hold of item.holds) {
    await sql`
      insert into holds (id, case_id, provider_id, reference, expires_at, status, constraints)
      values (${hold.id}, ${hold.caseId}, ${hold.providerId}, ${hold.reference}, ${hold.expiresAt}, ${hold.status}, ${hold.constraints})
      on conflict (id) do update set expires_at = excluded.expires_at, status = excluded.status, constraints = excluded.constraints, updated_at = now()
    `;
  }
  for (const event of item.timeline) {
    await sql`
      insert into timeline_events (id, case_id, at, title, detail, kind)
      values (${event.id}, ${item.id}, ${event.at}, ${event.title}, ${event.detail}, ${event.kind})
      on conflict (id) do nothing
    `;
  }
}

async function enqueuePostgres(sql: Queryable, command: CommunicationCommand) {
  const item = enqueueCommand([], command).item;
  await sql`
    insert into outbox_items (id, case_id, command, idempotency_key, status, attempts, last_error, lease_until, external_ref, adapter_response, created_at, updated_at)
    values (${item.id}, ${item.caseId}, ${sql.json(item.command as never)}, ${item.command.idempotencyKey}, ${item.status}, ${item.attempts}, ${item.lastError}, ${item.leaseUntil}, ${item.externalRef}, null, ${item.createdAt}, ${item.updatedAt})
    on conflict (idempotency_key) do nothing
  `;
}

async function persistArtifact(sql: Queryable, artifact: AuditArtifact) {
  await sql`
    insert into audit_artifacts (id, case_id, artifact_type, object_uri, retention_until, legal_hold, deletion_status, created_at)
    values (${artifact.id}, ${artifact.caseId}, ${artifact.artifactType}, ${artifact.encryptedObjectUri}, ${artifact.retentionUntil}, ${artifact.legalHold}, ${artifact.deletionStatus}, ${artifact.createdAt})
    on conflict (id) do update set object_uri = excluded.object_uri, retention_until = excluded.retention_until, legal_hold = excluded.legal_hold, deletion_status = excluded.deletion_status
  `;
}

function mapInbox(row: Record<string, unknown>): WebhookInboxEntry {
  return WebhookInboxEntrySchema.parse({
    id: row.id,
    source: row.source,
    externalEventId: row.external_event_id,
    receivedAt: dateString(row.received_at),
    processedAt: row.processed_at ? dateString(row.processed_at) : null,
    duplicate: false,
    payload: row.payload
  });
}

function mapOutbox(row: Record<string, unknown>): OutboxItem {
  return OutboxItemSchema.parse({
    id: row.id,
    caseId: row.case_id,
    command: row.command,
    status: row.status,
    attempts: row.attempts,
    leaseUntil: row.lease_until ? dateString(row.lease_until) : null,
    externalRef: row.external_ref,
    adapterResponse: row.adapter_response,
    createdAt: dateString(row.created_at),
    updatedAt: dateString(row.updated_at),
    lastError: row.last_error
  });
}

function mapArtifact(row: Record<string, unknown>): AuditArtifact {
  return AuditArtifactSchema.parse({
    id: row.id,
    caseId: row.case_id,
    artifactType: row.artifact_type,
    encryptedObjectUri: row.object_uri,
    retentionUntil: dateString(row.retention_until),
    legalHold: row.legal_hold,
    deletionStatus: row.deletion_status,
    createdAt: dateString(row.created_at)
  });
}

function mapRehearsal(row: Record<string, unknown>): RehearsalRecord {
  return {
    caseId: String(row.case_id), idempotencyKey: String(row.idempotency_key), actorSubject: String(row.actor_subject), service: String(row.service) as RehearsalRecord["service"],
    callId: row.call_id ? String(row.call_id) : null, status: String(row.status) as RehearsalRecord["status"],
    availability: row.availability as RehearsalRecord["availability"], caseCodeConfirmed: row.case_code_confirmed as RehearsalRecord["caseCodeConfirmed"],
    answered: Boolean(row.answered), caseCodeSpoken: Boolean(row.case_code_spoken), taskCompleted: typeof row.task_completed === "boolean" ? row.task_completed : null,
    transcriptArtifactId: row.transcript_artifact_id ? String(row.transcript_artifact_id) : null,
    errorCode: row.error_code ? String(row.error_code) : null, createdAt: dateString(row.created_at),
    updatedAt: dateString(row.updated_at), completedAt: row.completed_at ? dateString(row.completed_at) : null
  };
}

function dateString(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function reliabilityScore(reliability: { answeredCallRate: number; holdHonourRate: number; orphanHoldRate: number }) {
  return Math.max(0, Math.min(1, reliability.answeredCallRate * 0.3 + reliability.holdHonourRate * 0.6 - reliability.orphanHoldRate * 0.1));
}
