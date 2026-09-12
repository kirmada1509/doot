import type { CommunicationCommand, OutboxItem, WebhookInboxEntry } from "@doot/contracts";
import { idempotencyKey } from "./ids";

type WebhookSource = WebhookInboxEntry["source"];
type OutboxStatus = OutboxItem["status"];

export function acceptWebhook(
  inbox: WebhookInboxEntry[],
  input: { source: WebhookSource; externalEventId: string; payload: unknown; receivedAt?: Date }
) {
  const existing = inbox.find((entry) => entry.source === input.source && entry.externalEventId === input.externalEventId);
  if (existing) {
    const duplicate: WebhookInboxEntry = { ...existing, duplicate: true };
    return { inbox, entry: duplicate, accepted: false };
  }

  const entry: WebhookInboxEntry = {
    id: `inbox_${idempotencyKey([input.source, input.externalEventId])}`,
    source: input.source,
    externalEventId: input.externalEventId,
    receivedAt: (input.receivedAt ?? new Date()).toISOString(),
    processedAt: null,
    duplicate: false,
    payload: input.payload
  };
  return { inbox: [...inbox, entry], entry, accepted: true };
}

export function markWebhookProcessed(inbox: WebhookInboxEntry[], entryId: string, processedAt = new Date()) {
  return inbox.map((entry): WebhookInboxEntry =>
    entry.id === entryId ? { ...entry, processedAt: processedAt.toISOString() } : entry
  );
}

export function enqueueCommand(outbox: OutboxItem[], command: CommunicationCommand, now = new Date()) {
  const existing = outbox.find((item) => item.command.idempotencyKey === command.idempotencyKey);
  if (existing) return { outbox, item: existing, enqueued: false };

  const item: OutboxItem = {
    id: `outbox_${command.idempotencyKey}`,
    caseId: command.caseId,
    command,
    status: "pending",
    attempts: 0,
    leaseUntil: null,
    externalRef: null,
    adapterResponse: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastError: null
  };
  return { outbox: [...outbox, item], item, enqueued: true };
}

export function recordOutboxAttempt(
  outbox: OutboxItem[],
  itemId: string,
  result: {
    status: Extract<OutboxStatus, "pending" | "sent" | "failed" | "dead_lettered">;
    error?: string;
    externalRef?: string;
    adapterResponse?: unknown;
    countAttempt?: boolean;
  },
  now = new Date()
) {
  return outbox.map((item): OutboxItem => {
    if (item.id !== itemId) return item;
    return {
      ...item,
      status: result.status,
      attempts: item.attempts + (result.countAttempt === false ? 0 : 1),
      leaseUntil: null,
      externalRef: result.externalRef ?? item.externalRef,
      adapterResponse: result.adapterResponse ?? item.adapterResponse,
      updatedAt: now.toISOString(),
      lastError: result.error ?? null
    };
  });
}

export function leaseNextOutboxItem(outbox: OutboxItem[], now = new Date(), leaseMs = 30_000) {
  const next = outbox.find((item) => item.status === "pending" || (item.status === "leased" && item.leaseUntil !== null && new Date(item.leaseUntil) <= now));
  if (!next) return { outbox, item: null };
  const leased: OutboxItem = { ...next, status: "leased", leaseUntil: new Date(now.getTime() + leaseMs).toISOString(), updatedAt: now.toISOString() };
  return {
    outbox: outbox.map((item) => (item.id === leased.id ? leased : item)),
    item: leased
  };
}
