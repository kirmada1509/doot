import type { DecisionSignal, DootCase, ProviderCallResult } from "@doot/contracts";
import { loadConfig } from "@doot/config";

const config = loadConfig();

export async function requestProviderGoal(input: { caseId: string; providerId: string }): Promise<void> {
  await controlRequest(`/v1/internal/cases/${input.caseId}/provider-goals`, { method: "POST", body: JSON.stringify({ providerId: input.providerId }) });
}

export async function recordProviderResult(result: ProviderCallResult): Promise<void> {
  await controlRequest(`/v1/internal/cases/${result.caseId}/provider-results`, { method: "POST", body: JSON.stringify(result) });
}

export async function requestCallerCallback(caseId: string): Promise<DootCase> {
  return controlRequest(`/v1/internal/cases/${caseId}/callback`, { method: "POST" });
}

export async function commitDecision(signal: DecisionSignal): Promise<DootCase> {
  const result = await controlRequest<{ ok: boolean; case: DootCase; code?: string }>(`/v1/ops/cases/${signal.caseId}/actions/decide`, {
    method: "POST",
    headers: { "x-doot-role": "supervisor" },
    body: JSON.stringify({
      caseVersion: signal.caseVersion,
      selectedHoldId: signal.selectedHoldId,
      actor: signal.actor,
      verification: signal.verification
    })
  });
  if (!result.ok) throw new Error(`Decision rejected: ${result.code ?? "UNKNOWN"}`);
  return result.case;
}

export async function recordReleaseResult(input: { caseId: string; holdId: string; succeeded: boolean }): Promise<DootCase> {
  return controlRequest(`/v1/ops/cases/${input.caseId}/actions/release-result`, {
    method: "POST",
    headers: { "x-doot-role": "supervisor" },
    body: JSON.stringify({ holdId: input.holdId, succeeded: input.succeeded })
  });
}

export async function expireCase(caseId: string): Promise<DootCase> {
  return controlRequest(`/v1/internal/cases/${caseId}/expire`, { method: "POST" });
}

export async function expireHold(input: { caseId: string; holdId: string }): Promise<DootCase> {
  return controlRequest(`/v1/internal/cases/${input.caseId}/holds/${input.holdId}/expire`, { method: "POST" });
}

export async function pauseForManualReview(caseId: string): Promise<DootCase> {
  return controlRequest(`/v1/ops/cases/${caseId}/actions/pause`, { method: "POST", headers: { "x-doot-role": "supervisor" } });
}

async function controlRequest<T = unknown>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${config.CONTROL_API_URL}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${config.INTERNAL_SERVICE_TOKEN}`, "content-type": "application/json", ...init.headers }
  });
  if (!response.ok) throw new Error(`Control API ${path} returned ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}
