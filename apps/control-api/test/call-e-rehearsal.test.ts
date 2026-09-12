import { describe, expect, it } from "bun:test";
import { loadConfig } from "@doot/config";
import { caseCodeSpoken, createRehearsalCall, parseRehearsalCall, readRehearsalCall, rehearsalConfigured, rehearsalRequest, type RehearsalRecord } from "../src/call-e-rehearsal";

const config = loadConfig({ AUTH_MODE: "oidc", CALL_E_API_KEY: "live-test-key", CALL_E_DEMO_TARGET_E164: "+14155550123" } as NodeJS.ProcessEnv);
const record: RehearsalRecord = {
  caseId: "case_test", idempotencyKey: "doot_rehearsal_test", actorSubject: "operator_1", service: "shelter",
  callId: null, status: "pending", availability: null, caseCodeConfirmed: null, answered: false, caseCodeSpoken: false,
  taskCompleted: null, transcriptArtifactId: null, errorCode: null,
  createdAt: "2026-09-12T00:00:00.000Z", updatedAt: "2026-09-12T00:00:00.000Z", completedAt: null
};

describe("authorized CALL-E rehearsal", () => {
  it("requires a real-looking key and E.164 destination", () => {
    expect(rehearsalConfigured(config)).toBe(true);
    expect(rehearsalConfigured(loadConfig({ CALL_E_DEMO_TARGET_E164: "4040" } as NodeJS.ProcessEnv))).toBe(false);
    expect(rehearsalConfigured(loadConfig({ CALL_E_DEMO_TARGET_E164: "+14155550123" } as NodeJS.ProcessEnv))).toBe(false);
    expect(rehearsalConfigured(loadConfig({ AUTH_MODE: "demo", CALL_E_API_KEY: "live-test-key", CALL_E_DEMO_TARGET_E164: "+14155550123" } as NodeJS.ProcessEnv))).toBe(false);
  });

  it("keeps the call task synthetic and out of the hold workflow", () => {
    const request = rehearsalRequest("+14155550123", "123456", "respite", "case_test");
    expect(request.recipients[0]?.phones).toEqual(["+14155550123"]);
    expect(request.task).toContain("not an emergency or real booking");
    expect(request.task).toContain("Do not promise or place a hold");
    expect(request.result_schema.properties.synthetic_availability.enum).toEqual(["yes", "no", "unknown"]);
  });

  it("sends a stable idempotency key and rejects acceptance without a call id", async () => {
    const requests: RequestInit[] = [];
    const fetcher = (async (_url: string, init?: RequestInit) => {
      requests.push(init!);
      return Response.json({ id: "call_123", status: "queued" }, { status: 201 });
    }) as typeof fetch;
    expect(await createRehearsalCall(config, record, "123456", fetcher)).toBe("call_123");
    expect(await createRehearsalCall(config, record, "123456", fetcher)).toBe("call_123");
    expect(requests.map((item) => (item.headers as Record<string, string>)["idempotency-key"])).toEqual([record.idempotencyKey, record.idempotencyKey]);
    const missing = (async () => Response.json({ status: "queued" }, { status: 201 })) as typeof fetch;
    expect(createRehearsalCall(config, record, "123456", missing)).rejects.toThrow("CALL_E_CALL_ID_MISSING");
  });

  it("does not count acceptance or completion without an answering turn as conversation proof", () => {
    const empty = parseRehearsalCall({ id: "call_123", status: "completed", task_completed: true, structured_result: { case_code_confirmed: "yes", synthetic_availability: "yes" }, recipients: [] }, "call_123");
    expect(empty.answered).toBe(false);
    expect(empty.turns).toEqual([]);
    expect(parseRehearsalCall({ id: "call_123", status: "queued" }, "call_123").availability).toBeNull();
  });

  it("reads authenticated terminal results and a provider response transcript", async () => {
    const fetcher = (async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer live-test-key");
      return Response.json({
        id: "call_123", status: "completed", task_completed: true, completed_at: "2026-09-12T00:01:00Z",
        structured_result: { case_code_confirmed: "yes", synthetic_availability: "unknown" },
        recipients: [{ attempts: [{ transcript_turns: [
          { speaker: "bot", text: "Please repeat 123456.", offset_seconds: 0 },
          { speaker: "user", text: "123456", offset_seconds: 4 }
        ] }] }]
      });
    }) as typeof fetch;
    const result = await readRehearsalCall(config, "call_123", fetcher);
    expect(result.answered).toBe(true);
    expect(result.caseCodeConfirmed).toBe("yes");
    expect(result.availability).toBe("unknown");
    expect(result.turns).toHaveLength(2);
    expect(caseCodeSpoken(result.turns, "123456")).toBe(true);
    expect(caseCodeSpoken(result.turns, "654321")).toBe(false);
  });
});
