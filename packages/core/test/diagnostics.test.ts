import { describe, expect, it } from "vitest";
import { buildDiagnostics, createDemoCase, markHoldExpired } from "../src/index";

describe("diagnostics and hold expiry helpers", () => {
  it("keeps the compact diagnostics bundle under 16 KB", () => {
    const current = createDemoCase();
    const bloated = {
      ...current,
      timeline: Array.from({ length: 80 }, (_, index) => ({
        id: `evt_${index}`,
        at: current.createdAt,
        title: `Event ${index}`,
        detail: "x".repeat(400),
        kind: "diagnostic" as const
      }))
    };
    const bundle = buildDiagnostics(bloated);
    expect(bundle.byteSize ?? 0).toBeLessThanOrEqual(16 * 1024);
    expect(bundle.truncated).toBe(true);
    expect(bundle.latestEvents.length).toBeLessThan(80);
  });

  it("expires one hold without closing the case while alternatives remain active", () => {
    const current = createDemoCase();
    const next = markHoldExpired(current, "hold_lotus_18", new Date("2026-09-11T08:15:00.000Z"));
    expect(next.holds.find((hold) => hold.id === "hold_lotus_18")?.status).toBe("expired");
    expect(next.holds.find((hold) => hold.id === "hold_backup_ashraya")?.status).toBe("active");
    expect(next.state).toBe("awaiting_decision");
  });

  it("does not expire a future hold or duplicate an expiry event", () => {
    const current = createDemoCase();
    const early = markHoldExpired(current, "hold_lotus_18", new Date("2026-09-11T08:02:00.000Z"));
    expect(early).toBe(current);

    const expired = markHoldExpired(current, "hold_lotus_18", new Date("2026-09-11T08:15:00.000Z"));
    const replayed = markHoldExpired(expired, "hold_lotus_18", new Date("2026-09-11T08:16:00.000Z"));
    expect(replayed).toBe(expired);
  });
});
