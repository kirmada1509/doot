import { describe, expect, it, vi } from "vitest";
import { OutboxProcessor } from "../src/processor";
import { MockAdapter } from "../src/adapters";

describe("webhook recovery", () => {
  it("polls an asynchronous Goal Run without consuming failure retries or signaling a hold", async () => {
    const command = {
      id: "cmd_hold", caseId: "case_1", kind: "provider_hold_goal", channel: "call_e_goal_run",
      idempotencyKey: "stable-key", traceId: "trace", requestId: "request", workflowId: "workflow",
      language: "en", target: { providerId: "provider_lotus" },
      goal: { name: "Hold", objective: "Hold", script: "Hold", input: {} },
      metadata: { caseId: "case_1", workflowId: "workflow", traceId: "trace", requestId: "request" }
    } as const;
    const item = { id: "outbox_1", caseId: "case_1", command, status: "leased", attempts: 0,
      leaseUntil: null, externalRef: null, adapterResponse: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null } as const;
    const api = {
      lease: vi.fn(async () => ({ item })), getCase: vi.fn(async () => ({ state: "searching" })),
      record: vi.fn(async () => ({ item })), signalProvider: vi.fn()
    };
    const adapter = { execute: vi.fn(async () => ({ externalRef: "run_1", response: { id: "run_1", status: "queued" }, pending: true })) };
    expect(await new OutboxProcessor(api as never, adapter, 5).processOne()).toBe(true);
    expect(api.record).toHaveBeenCalledWith("outbox_1", expect.objectContaining({ status: "pending", externalRef: "run_1", countAttempt: false }));
    expect(api.signalProvider).not.toHaveBeenCalled();
  });

  it("refetches a correlated run and marks its event processed", async () => {
    const command = {
      id: "cmd_release", caseId: "case_1", kind: "release_hold_goal", channel: "call_e_goal_run",
      idempotencyKey: "stable-key", traceId: "trace", requestId: "request", workflowId: "workflow",
      language: "en", target: { holdId: "hold_1", providerId: "provider_1" },
      goal: { name: "Release", objective: "Release", script: "Release", input: {} },
      metadata: { caseId: "case_1", workflowId: "workflow", traceId: "trace", requestId: "request" }
    } as const;
    const item = {
      id: "outbox_1", caseId: "case_1", command, status: "pending", attempts: 1,
      leaseUntil: null, externalRef: "run_1", adapterResponse: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null
    } as const;
    const api = {
      listInbox: vi.fn(async () => ({ entries: [{ id: "inbox_1", source: "call-e", externalEventId: "event_1", receivedAt: new Date().toISOString(), processedAt: null, duplicate: false, payload: { data: { id: "run_1" } } }] })),
      listOutbox: vi.fn(async () => ({ items: [item] })),
      markInboxProcessed: vi.fn(async () => ({ processed: true })),
      record: vi.fn(async () => ({ item })),
      signalRelease: vi.fn(async () => ({ signalled: true }))
    };
    const processor = new OutboxProcessor(api as never, new MockAdapter(), 5);
    expect(await processor.processWebhookOne()).toBe(true);
    expect(api.signalRelease).toHaveBeenCalledWith("workflow", { holdId: "hold_1", succeeded: true });
    expect(api.record).toHaveBeenCalledWith("outbox_1", expect.objectContaining({ status: "sent", externalRef: expect.stringMatching(/^mock_/) }));
    expect(api.markInboxProcessed).toHaveBeenCalledWith("inbox_1");
  });
});
