import { createHash } from "node:crypto";
import type { DootConfig } from "@doot/config";
import { CalleProviderGoalResultSchema, type CommunicationCommand, type ProviderCallResult } from "@doot/contracts";
import { providerResultFromCalleGoal } from "@doot/core";
import { DeliveryError } from "./api";
import { SpanStatusCode, trace } from "@opentelemetry/api";

export type AdapterResult = { externalRef: string; response: unknown; result?: unknown; pending?: boolean };
export interface CommunicationsAdapter { execute(command: CommunicationCommand, externalRef: string | null): Promise<AdapterResult>; }

export function createAdapter(config: DootConfig, fetcher: typeof fetch = fetch): CommunicationsAdapter {
  if (config.COMMUNICATION_MODE !== "live") return new MockAdapter();
  if ([config.CALL_E_API_KEY, config.CALL_E_PROVIDER_GOAL_ID, config.CALL_E_RELEASE_GOAL_ID]
    .some((value) => value.startsWith("demo-") || value === "replace-me")) {
    throw new Error("Live CALL-E mode requires a real API key and published provider/release Goal IDs.");
  }
  const phones = parsePhoneMap(config.PROVIDER_PHONE_MAP_JSON, "PROVIDER_PHONE_MAP_JSON");
  for (const providerId of ["provider_lotus", "provider_ashraya"]) {
    if (!/^\+[1-9]\d{7,14}$/.test(phones[providerId] ?? "")) {
      throw new Error(`Live CALL-E mode requires an authorized E.164 number for ${providerId}.`);
    }
  }
  return new LiveAdapter(config, fetcher);
}

export async function verifyPublishedGoals(config: DootConfig, fetcher: typeof fetch = fetch) {
  if (config.COMMUNICATION_MODE !== "live") return;
  const interfaces = [
    {
      id: config.CALL_E_PROVIDER_GOAL_ID,
      input: ["case_id", "demo_case_code", "provider_id", "provider_name", "need_summary", "accepts_holds", "allow_hold", "language"],
      result: { case_id: "string", provider_id: "string", external_call_id: "string", outcome: "string", eligibility_status: "string", eligibility_criteria: "array", hold_reference: "string", hold_expires_at: "string", hold_constraints: "array", evidence_summary: "string", confidence: "string", transcript_artifact_id: "string" }
    },
    {
      id: config.CALL_E_RELEASE_GOAL_ID,
      input: ["case_id", "demo_case_code", "provider_id", "hold_id", "hold_reference", "hold_expires_at"],
      result: { released: "boolean" }
    }
  ];
  for (const goal of interfaces) {
    const response = await fetcher(`${config.CALL_E_BASE_URL}/v1/goals/${encodeURIComponent(goal.id)}`, {
      headers: { authorization: `Bearer ${config.CALL_E_API_KEY}` }
    });
    if (!response.ok) throw new Error(`CALL-E Goal preflight failed for ${goal.id}: HTTP ${response.status}`);
    const document = await response.json() as Record<string, unknown>;
    const published = document.published_run_spec as Record<string, unknown> | undefined;
    const input = published?.input_schema as Record<string, unknown> | undefined;
    const result = published?.result_schema as Record<string, unknown> | undefined;
    const inputProperties = (input?.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    const requiredInputs = Array.isArray(input?.required) ? input.required : [];
    const resultProperties = (result?.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    const requiredResults = Array.isArray(result?.required) ? result.required : [];
    if (document.id !== goal.id || document.status !== "active" || !published ||
        goal.input.some((key) => inputProperties[key]?.type !== "string") ||
        requiredInputs.some((key) => !goal.input.includes(String(key))) ||
        Object.entries(goal.result).some(([key, type]) => resultProperties[key]?.type !== type || !requiredResults.includes(key))) {
      throw new Error(`CALL-E Goal ${goal.id} published schemas do not match Doot's hold/release contract`);
    }
  }
}

export class MockAdapter implements CommunicationsAdapter {
  async execute(command: CommunicationCommand): Promise<AdapterResult> {
    const suffix = createHash("sha256").update(command.idempotencyKey).digest("hex").slice(0, 10);
    const externalRef = `mock_${suffix}`;
    if (command.kind === "provider_hold_goal") {
      const providerId = required(command.target.providerId, "provider id");
      const allowsHold = command.goal.input.allow_hold !== "false";
      const raw = {
        case_id: command.caseId, provider_id: providerId, external_call_id: externalRef,
        outcome: allowsHold ? "hold_secured" as const : "availability_only" as const, eligibility_status: "eligible" as const,
        eligibility_criteria: ["authorized mock adapter fixture"], hold_reference: allowsHold ? `MOCK-${suffix.toUpperCase()}` : "",
        hold_expires_at: allowsHold ? new Date(Date.now() + 10 * 60_000).toISOString() : "", hold_constraints: allowsHold ? ["Reversible ten-minute test hold"] : [],
        evidence_summary: allowsHold ? "Mock provider confirmed eligibility, availability, and a temporary hold." : "Mock provider returned non-binding planning availability.", confidence: "high" as const,
        transcript_artifact_id: ""
      };
      return { externalRef, response: { status: "completed", result: raw }, result: providerResultFromCalleGoal(raw) };
    }
    if (command.kind === "caller_decision_callback") {
      const selectedHoldId = command.goal.input.choice_ids?.split(",").find(Boolean);
      if (!selectedHoldId) throw new DeliveryError("Mock callback had no explicit choice to select", false);
      const result = { selected_hold_id: selectedHoldId };
      return { externalRef, response: { status: "completed", result }, result };
    }
    if (command.kind === "release_hold_goal") {
      const result = { released: true };
      return { externalRef, response: { status: "completed", result }, result };
    }
    return { externalRef, response: { status: "completed", commandKind: command.kind }, result: { acknowledged: true } };
  }
}

class LiveAdapter implements CommunicationsAdapter {
  private readonly providerPhones: Record<string, string>;
  private readonly callerPhones: Record<string, string>;
  constructor(private readonly config: DootConfig, private readonly fetcher: typeof fetch) {
    this.providerPhones = parsePhoneMap(config.PROVIDER_PHONE_MAP_JSON, "PROVIDER_PHONE_MAP_JSON");
    this.callerPhones = parsePhoneMap(config.CALLER_PHONE_MAP_JSON, "CALLER_PHONE_MAP_JSON");
  }
  async execute(command: CommunicationCommand, externalRef: string | null): Promise<AdapterResult> {
    if (this.config.CALLER_CONTACT_MODE !== "live" && (command.kind === "caller_decision_callback" || command.kind === "comparison_sms")) {
      throw new DeliveryError("Caller PSTN contact is disabled for this stack", false);
    }
    return trace.getTracer("doot-communications").startActiveSpan(
      `provider.${command.channel}`,
      {
        attributes: {
          "doot.case_id": command.caseId,
          "doot.request_id": command.requestId,
          "doot.trace_id": command.traceId,
          "doot.command_kind": command.kind,
          "doot.retry_lookup": Boolean(externalRef)
        }
      },
      async (span) => {
        try {
          return await (command.channel === "exotel_sms" ? this.sendSms(command) : this.runCalleGoal(command, externalRef));
        } catch (error) {
          span.recordException(error instanceof Error ? error : new Error("Provider boundary failed"));
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      }
    );
  }
  private async runCalleGoal(command: CommunicationCommand, externalRef: string | null): Promise<AdapterResult> {
    const base = `${this.config.CALL_E_BASE_URL}/v1/goals/${encodeURIComponent(goalIdFor(this.config, command.kind))}/runs`;
    const response = await this.fetcher(externalRef ? `${base}/${encodeURIComponent(externalRef)}` : base, {
      method: externalRef ? "GET" : "POST",
      headers: { authorization: `Bearer ${this.config.CALL_E_API_KEY}`, "content-type": "application/json", "idempotency-key": command.idempotencyKey },
      ...(externalRef ? {} : { body: JSON.stringify({ phone: this.phoneFor(command), variables: command.goal.input }) })
    });
    const body = await safeJson(response);
    if (!response.ok) throw new DeliveryError(`CALL-E returned ${response.status}`, response.status >= 500 || response.status === 429, externalRef ?? undefined, body);
    const ref = readString(body, "id") ?? readString(body, "run_id");
    if (!ref) throw new DeliveryError("CALL-E response omitted the Goal Run id", false, undefined, body);
    const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
    const status = readString(body, "status");
    if (status === "failed" || status === "canceled") {
      throw new DeliveryError(`CALL-E Goal Run ${status}`, false, ref, body);
    }
    if (record.error !== null && record.error !== undefined) {
      throw new DeliveryError("CALL-E Goal Run ended with an error", false, ref, body);
    }
    const result = record.result;
    if (result === null || result === undefined) {
      if (status !== "queued" && status !== "in_progress" && status !== "completed") throw new DeliveryError("CALL-E returned an unknown Goal Run status", false, ref, body);
      return { externalRef: ref, response: body, pending: true };
    }
    if (status !== "completed") throw new DeliveryError("CALL-E returned a result before completion", false, ref, body);
    const normalized = normalizeLiveResult(command, result);
    if (command.kind === "provider_hold_goal") {
      const providerResult = normalized as ProviderCallResult;
      if (providerResult.caseId !== command.caseId || providerResult.providerId !== command.target.providerId) {
        throw new DeliveryError("CALL-E result does not match the requested case and provider", false, ref, body);
      }
      if (providerResult.hold) {
        const ledger = await this.verifyLedger(command, providerResult.hold.reference);
        if (ledger.status !== "active" || !ledger.expiresAt || Math.abs(Date.parse(ledger.expiresAt) - Date.parse(providerResult.hold.expiresAt)) > 2000) {
          throw new DeliveryError("CALL-E hold is not confirmed in the provider demo ledger", false, ref, body);
        }
      }
    }
    if (command.kind === "release_hold_goal" && typeof normalized === "object" && normalized !== null &&
        (normalized as Record<string, unknown>).released === true) {
      const ledger = await this.verifyLedger(command, required(command.target.holdReference, "hold reference"));
      if (ledger.status !== "released") throw new DeliveryError("CALL-E release is not confirmed in the provider demo ledger", false, ref, body);
    }
    return { externalRef: ref, response: body, result: normalized };
  }
  private async verifyLedger(command: CommunicationCommand, reference: string): Promise<{ status: string; expiresAt: string | null }> {
    const url = new URL("/v1/internal/provider-holds/verify", this.config.VOICE_RUNTIME_HTTP_URL);
    url.searchParams.set("providerId", required(command.target.providerId, "provider id"));
    url.searchParams.set("caseCode", required(command.goal.input.demo_case_code, "demo case code"));
    url.searchParams.set("reference", reference);
    const response = await this.fetcher(url, { headers: { authorization: `Bearer ${this.config.INTERNAL_SERVICE_TOKEN}` } });
    if (!response.ok) throw new DeliveryError("Provider demo ledger could not be verified", response.status >= 500, undefined, { status: response.status });
    return response.json() as Promise<{ status: string; expiresAt: string | null }>;
  }
  private async sendSms(command: CommunicationCommand): Promise<AdapterResult> {
    const url = `https://${this.config.EXOTEL_SUBDOMAIN}/v1/Accounts/${encodeURIComponent(this.config.EXOTEL_ACCOUNT_SID)}/Sms/send.json`;
    const form = new URLSearchParams({ From: this.config.EXOTEL_SMS_FROM, To: this.phoneFor(command), Body: command.goal.input.options ?? command.goal.objective });
    const response = await this.fetcher(url, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${this.config.EXOTEL_API_KEY}:${this.config.EXOTEL_API_TOKEN}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded", "x-doot-idempotency-key": command.idempotencyKey },
      body: form
    });
    const body = await safeJson(response);
    if (!response.ok) throw new DeliveryError(`Exotel returned ${response.status}`, response.status >= 500 || response.status === 429, undefined, body);
    const ref = findNestedString(body, ["SMSMessage", "Sid"]) ?? readString(body, "sid") ?? `exotel_${command.idempotencyKey}`;
    return { externalRef: ref, response: body };
  }
  private phoneFor(command: CommunicationCommand): string {
    const key = command.target.providerId ?? command.target.callerPhoneBlindIndex;
    const phone = key ? (command.target.providerId ? this.providerPhones : this.callerPhones)[key] : undefined;
    if (!phone || !/^\+[1-9]\d{7,14}$/.test(phone)) throw new DeliveryError(`No valid E.164 destination configured for ${command.kind}`, false);
    return phone;
  }
}

function normalizeLiveResult(command: CommunicationCommand, value: unknown): ProviderCallResult | unknown {
  return command.kind === "provider_hold_goal" ? providerResultFromCalleGoal(CalleProviderGoalResultSchema.parse(value)) : value;
}
function goalIdFor(config: DootConfig, kind: CommunicationCommand["kind"]): string {
  if (kind === "provider_hold_goal") return config.CALL_E_PROVIDER_GOAL_ID;
  if (kind === "caller_decision_callback") return config.CALL_E_CALLBACK_GOAL_ID;
  if (kind === "release_hold_goal") return config.CALL_E_RELEASE_GOAL_ID;
  return config.CALL_E_CONFIRMATION_GOAL_ID;
}
function parsePhoneMap(raw: string, name: string): Record<string, string> {
  try { const value = JSON.parse(raw) as unknown; if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(); return value as Record<string, string>; }
  catch { throw new Error(`${name} must be a JSON object`); }
}
function required(value: string | undefined, label: string): string { if (!value) throw new DeliveryError(`Command omitted ${label}`, false); return value; }
async function safeJson(response: Response): Promise<unknown> { const text = await response.text(); if (!text) return {}; try { return JSON.parse(text) as unknown; } catch { return { raw: text.slice(0, 1_000) }; } }
function readString(value: unknown, key: string): string | null { if (typeof value !== "object" || value === null) return null; const candidate = (value as Record<string, unknown>)[key]; return typeof candidate === "string" ? candidate : null; }
function findNestedString(value: unknown, path: string[]): string | null { let current: unknown = value; for (const part of path) { if (typeof current !== "object" || current === null) return null; current = (current as Record<string, unknown>)[part]; } return typeof current === "string" ? current : null; }
