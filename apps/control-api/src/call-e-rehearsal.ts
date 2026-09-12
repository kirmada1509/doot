import type { DootConfig } from "@doot/config";

export type RehearsalStatus = "pending" | "queued" | "in_progress" | "completed" | "failed" | "canceled";
export type RehearsalAnswer = "yes" | "no" | "unknown";
export type RehearsalTurn = { speaker: "bot" | "user"; text: string; offsetSeconds: number | null };
export type RehearsalRecord = {
  caseId: string;
  idempotencyKey: string;
  actorSubject: string;
  service: "shelter" | "respite";
  callId: string | null;
  status: RehearsalStatus;
  availability: RehearsalAnswer | null;
  caseCodeConfirmed: RehearsalAnswer | null;
  answered: boolean;
  caseCodeSpoken: boolean;
  taskCompleted: boolean | null;
  transcriptArtifactId: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export class RehearsalApiError extends Error {
  constructor(readonly status: number) { super(`CALL_E_HTTP_${status}`); }
}

export function rehearsalConfigured(config: DootConfig) {
  return Boolean(config.AUTH_MODE === "oidc" && /^\+[1-9]\d{6,14}$/.test(config.CALL_E_DEMO_TARGET_E164)
    && config.CALL_E_API_KEY && !/^(demo-|replace-me)/.test(config.CALL_E_API_KEY));
}

export function rehearsalRequest(phone: string, caseCode: string, service: "shelter" | "respite", caseId: string) {
  const resultSchema = {
    type: "object",
    additionalProperties: false,
    required: ["case_code_confirmed", "synthetic_availability"],
    properties: {
      case_code_confirmed: { type: "string", enum: ["yes", "no", "unknown"], description: "Yes only if the recipient repeated the demo case code aloud." },
      synthetic_availability: { type: "string", enum: ["yes", "no", "unknown"], description: "Availability discussed for a fictional demo slot only. Unknown if unclear." }
    }
  };
  return {
    task: `Call the authorized Doot demo participant. State that you are an AI caller and this is a synthetic coordination rehearsal, not an emergency or real booking. Ask the participant to repeat demo case code ${caseCode} and whether a fictional ${service} slot is available. Do not ask for personal or medical details. Do not promise or place a hold. End politely after obtaining the answers.`,
    recipients: [{ phones: [phone] }],
    result_schema: resultSchema,
    metadata: { doot_case_id: caseId, purpose: "authorized_demo_rehearsal" }
  };
}

export async function createRehearsalCall(config: DootConfig, record: RehearsalRecord, caseCode: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`${config.CALL_E_BASE_URL}/v1/calls`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.CALL_E_API_KEY}`, "content-type": "application/json", "idempotency-key": record.idempotencyKey },
    body: JSON.stringify(rehearsalRequest(config.CALL_E_DEMO_TARGET_E164, caseCode, record.service, record.caseId)),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new RehearsalApiError(response.status);
  const body: unknown = await response.json();
  const callId = isObject(body) && typeof body.id === "string" && /^call_[\w-]+$/.test(body.id) ? body.id : null;
  if (!callId) throw new Error("CALL_E_CALL_ID_MISSING");
  return callId;
}

export async function readRehearsalCall(config: DootConfig, callId: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`${config.CALL_E_BASE_URL}/v1/calls/${encodeURIComponent(callId)}`, {
    headers: { authorization: `Bearer ${config.CALL_E_API_KEY}` }, signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new RehearsalApiError(response.status);
  return parseRehearsalCall(await response.json(), callId);
}

export function parseRehearsalCall(body: unknown, expectedCallId: string) {
  if (!isObject(body) || body.id !== expectedCallId || !isStatus(body.status)) throw new Error("CALL_E_INVALID_CALL_RESULT");
  const structured = isObject(body.structured_result) ? body.structured_result : null;
  const recipients = Array.isArray(body.recipients) ? body.recipients : [];
  const turns: RehearsalTurn[] = [];
  for (const recipient of recipients) {
    if (!isObject(recipient) || !Array.isArray(recipient.attempts)) continue;
    for (const attempt of recipient.attempts) {
      if (!isObject(attempt) || !Array.isArray(attempt.transcript_turns)) continue;
      for (const turn of attempt.transcript_turns) {
        if (!isObject(turn) || (turn.speaker !== "bot" && turn.speaker !== "user") || typeof turn.text !== "string") continue;
        turns.push({ speaker: turn.speaker, text: turn.text.slice(0, 4000), offsetSeconds: typeof turn.offset_seconds === "number" ? turn.offset_seconds : null });
      }
    }
  }
  return {
    status: body.status,
    taskCompleted: typeof body.task_completed === "boolean" ? body.task_completed : null,
    availability: answer(structured?.synthetic_availability),
    caseCodeConfirmed: answer(structured?.case_code_confirmed),
    answered: turns.some((turn) => turn.speaker === "user" && turn.text.trim().length > 0),
    turns,
    completedAt: typeof body.completed_at === "string" ? body.completed_at : null,
    errorCode: body.status === "failed" ? "CALL_E_CALL_FAILED" : null
  };
}

export function caseCodeSpoken(turns: RehearsalTurn[], caseCode: string) {
  return turns.some((turn) => turn.speaker === "user" && turn.text.replace(/\D/g, "").includes(caseCode));
}

function answer(value: unknown): RehearsalAnswer | null {
  return value === "yes" || value === "no" || value === "unknown" ? value : null;
}

function isStatus(value: unknown): value is RehearsalStatus {
  return value === "queued" || value === "in_progress" || value === "completed" || value === "failed" || value === "canceled";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
