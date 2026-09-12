import { describe, expect, it } from "vitest";
import {
  acceptWebhook,
  buildComparisonSmsCommand,
  createDemoCase,
  enqueueCommand,
  leaseNextOutboxItem,
  markWebhookProcessed,
  recordOutboxAttempt
} from "../src/index";

describe("inbox and outbox helpers", () => {
  it("accepts a webhook once and reports duplicate replays", () => {
    const first = acceptWebhook([], {
      source: "call-e",
      externalEventId: "evt_1",
      payload: { id: "evt_1" },
      receivedAt: new Date("2026-09-11T08:00:00.000Z")
    });
    const replay = acceptWebhook(first.inbox, {
      source: "call-e",
      externalEventId: "evt_1",
      payload: { id: "evt_1" },
      receivedAt: new Date("2026-09-11T08:01:00.000Z")
    });

    expect(first.accepted).toBe(true);
    expect(replay.accepted).toBe(false);
    expect(replay.entry.duplicate).toBe(true);
    expect(replay.inbox).toHaveLength(1);
  });

  it("marks accepted webhook entries as processed", () => {
    const first = acceptWebhook([], {
      source: "exotel",
      externalEventId: "msg_1",
      payload: { id: "msg_1" }
    });

    const processed = markWebhookProcessed(first.inbox, first.entry.id, new Date("2026-09-11T08:02:00.000Z"));
    expect(processed[0]?.processedAt).toBe("2026-09-11T08:02:00.000Z");
  });

  it("deduplicates, leases, and records outbox command attempts", () => {
    const command = buildComparisonSmsCommand(createDemoCase());
    const first = enqueueCommand([], command, new Date("2026-09-11T08:00:00.000Z"));
    const replay = enqueueCommand(first.outbox, command, new Date("2026-09-11T08:01:00.000Z"));
    const leased = leaseNextOutboxItem(replay.outbox, new Date("2026-09-11T08:02:00.000Z"));
    const sent = recordOutboxAttempt(leased.outbox, leased.item!.id, { status: "sent" }, new Date("2026-09-11T08:03:00.000Z"));

    expect(first.enqueued).toBe(true);
    expect(replay.enqueued).toBe(false);
    expect(leased.item?.status).toBe("leased");
    expect(sent[0]?.status).toBe("sent");
    expect(sent[0]?.attempts).toBe(1);
  });
});
