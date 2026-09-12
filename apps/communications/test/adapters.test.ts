import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "@doot/config";
import { buildProviderHoldGoalCommand, createDemoCase, createPlanningDemoCase, demoProviders } from "@doot/core";
import { createAdapter, MockAdapter, verifyPublishedGoals } from "../src/adapters";
import { DeliveryError } from "../src/api";

describe("communications adapters", () => {
  it("returns stable mock references for replayed commands", async () => {
    const command = buildProviderHoldGoalCommand(createDemoCase(), demoProviders[0]!);
    const adapter = new MockAdapter();
    const first = await adapter.execute(command, null);
    const replay = await adapter.execute(command, first.externalRef);
    expect(replay.externalRef).toBe(first.externalRef);
    expect(replay.result).toMatchObject({ caseId: command.caseId, providerId: command.target.providerId, outcome: "hold_secured" });
  });

  it("returns availability without reserving capacity in planning mode", async () => {
    const command = buildProviderHoldGoalCommand(createPlanningDemoCase(), demoProviders[0]!);
    const delivery = await new MockAdapter().execute(command, null);
    expect(delivery.result).toMatchObject({ outcome: "availability_only", hold: null });
  });

  it("reuses the command key and persists a non-terminal CALL-E run for refetch", async () => {
    const command = buildProviderHoldGoalCommand(createDemoCase(), demoProviders[0]!);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "run_123", status: "queued", result: null }), { status: 201 })) as unknown as typeof fetch;
    const adapter = createAdapter(loadConfig({
      COMMUNICATION_MODE: "live",
      CALL_E_API_KEY: "test-key", CALL_E_PROVIDER_GOAL_ID: "goal-provider", CALL_E_RELEASE_GOAL_ID: "goal-release",
      PROVIDER_PHONE_MAP_JSON: JSON.stringify({ provider_lotus: "+14155550123", provider_ashraya: "+14155550124" })
    } as NodeJS.ProcessEnv), fetcher);
    await expect(adapter.execute(command, null)).resolves.toMatchObject({ pending: true, externalRef: "run_123" });
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/runs"), expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "idempotency-key": command.idempotencyKey })
    }));
  });

  it("refetches an accepted Goal Run instead of creating another", async () => {
    const command = buildProviderHoldGoalCommand(createDemoCase(), demoProviders[0]!);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "run_123", status: "in_progress", result: null }), { status: 200 })) as unknown as typeof fetch;
    const adapter = createAdapter(loadConfig({ COMMUNICATION_MODE: "live", CALL_E_API_KEY: "test-key", CALL_E_PROVIDER_GOAL_ID: "goal-provider", CALL_E_RELEASE_GOAL_ID: "goal-release", PROVIDER_PHONE_MAP_JSON: JSON.stringify({ provider_lotus: "+14155550123", provider_ashraya: "+14155550124" }) } as NodeJS.ProcessEnv), fetcher);
    await expect(adapter.execute(command, "run_123")).resolves.toMatchObject({ pending: true, externalRef: "run_123" });
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/runs/run_123"), expect.objectContaining({ method: "GET" }));
  });

  it("keeps polling completed without result and does not signal a hold", async () => {
    const command = buildProviderHoldGoalCommand(createDemoCase(), demoProviders[0]!);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "run_123", status: "completed", result: null }), { status: 200 })) as unknown as typeof fetch;
    const adapter = createAdapter(loadConfig({ COMMUNICATION_MODE: "live", CALL_E_API_KEY: "test-key", CALL_E_PROVIDER_GOAL_ID: "goal-provider", CALL_E_RELEASE_GOAL_ID: "goal-release", PROVIDER_PHONE_MAP_JSON: JSON.stringify({ provider_lotus: "+14155550123", provider_ashraya: "+14155550124" }) } as NodeJS.ProcessEnv), fetcher);
    await expect(adapter.execute(command, "run_123")).resolves.toMatchObject({ pending: true, externalRef: "run_123" });
  });

  it("rejects a published Goal interface that cannot accept the case code", async () => {
    const config = loadConfig({ COMMUNICATION_MODE: "live", CALL_E_API_KEY: "test-key", CALL_E_PROVIDER_GOAL_ID: "goal-provider", CALL_E_RELEASE_GOAL_ID: "goal-release" } as NodeJS.ProcessEnv);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "goal-provider", status: "active", published_run_spec: {
      input_schema: { additionalProperties: false, properties: { provider_id: { type: "string" } }, required: [] },
      result_schema: { properties: {} }
    } }), { status: 200 })) as unknown as typeof fetch;
    await expect(verifyPublishedGoals(config, fetcher)).rejects.toThrow("schemas do not match");
  });

  it("rejects a schema-valid CALL-E hold absent from the provider ledger", async () => {
    const command = buildProviderHoldGoalCommand(createDemoCase(), demoProviders[0]!);
    const expiry = new Date(Date.now() + 10 * 60_000).toISOString();
    const result = {
      case_id: command.caseId, provider_id: command.target.providerId, external_call_id: "call_1",
      outcome: "hold_secured", eligibility_status: "eligible", eligibility_criteria: [],
      hold_reference: "LOTUS-123456", hold_expires_at: expiry, hold_constraints: [],
      evidence_summary: "Provider said yes", confidence: "high", transcript_artifact_id: ""
    };
    const fetcher = vi.fn(async (url: string | URL) => String(url).includes("provider-holds/verify")
      ? new Response(JSON.stringify({ status: "missing", expiresAt: null }))
      : new Response(JSON.stringify({ id: "run_1", status: "completed", result }))) as unknown as typeof fetch;
    const adapter = createAdapter(loadConfig({ COMMUNICATION_MODE: "live", CALL_E_API_KEY: "test-key", CALL_E_PROVIDER_GOAL_ID: "goal-provider", CALL_E_RELEASE_GOAL_ID: "goal-release", PROVIDER_PHONE_MAP_JSON: JSON.stringify({ provider_lotus: "+14155550123", provider_ashraya: "+14155550124" }) } as NodeJS.ProcessEnv), fetcher);
    await expect(adapter.execute(command, "run_1")).rejects.toThrow("not confirmed in the provider demo ledger");
  });
});
