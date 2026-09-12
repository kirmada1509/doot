import { randomUUID } from "node:crypto";

export type VoiceSessionRecord = {
  token: string;
  callSid: string;
  language: "en" | "hi" | "hinglish";
  expiresAt: string;
  callerPhoneBlindIndex: string;
  channel: "browser" | "phone";
  service: "shelter" | "respite";
  caseId: string | null;
};

const sessions = new Map<string, VoiceSessionRecord>();

export function createVoiceSession(input: {
  callSid: string;
  language?: "en" | "hi" | "hinglish";
  callerPhoneBlindIndex?: string;
  ttlMs?: number;
  channel?: "browser" | "phone";
  service?: "shelter" | "respite";
}): VoiceSessionRecord {
  pruneExpiredSessions();
  const token = `vs_${randomUUID().replaceAll("-", "")}`;
  const record: VoiceSessionRecord = {
    token,
    callSid: input.callSid,
    language: input.language ?? "hinglish",
    expiresAt: new Date(Date.now() + (input.ttlMs ?? 5 * 60_000)).toISOString(),
    callerPhoneBlindIndex: input.callerPhoneBlindIndex ?? `blind_${input.callSid}`,
    channel: input.channel ?? "phone",
    service: input.service ?? "shelter",
    caseId: null
  };
  sessions.set(token, record);
  return record;
}

export function bindVoiceSessionCase(token: string, caseId: string): boolean {
  const session = getVoiceSession(token);
  if (!session || session.caseId !== null) return false;
  session.caseId = caseId;
  return true;
}

export function getVoiceSession(token: string): VoiceSessionRecord | null {
  pruneExpiredSessions();
  const record = sessions.get(token);
  if (!record) return null;
  if (new Date(record.expiresAt).getTime() <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return record;
}

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [token, record] of sessions) {
    if (new Date(record.expiresAt).getTime() <= now) sessions.delete(token);
  }
}
