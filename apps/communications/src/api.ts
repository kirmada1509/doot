import type { DootCase, OutboxItem, WebhookInboxEntry } from "@doot/contracts";

export class ControlApi {
  constructor(private readonly baseUrl: string, private readonly serviceToken: string, private readonly fetcher: typeof fetch = fetch) {}

  lease(): Promise<{ item: OutboxItem | null }> {
    return this.request("/v1/ops/outbox/lease", { method: "POST", role: "developer" });
  }
  record(itemId: string, result: Record<string, unknown>): Promise<{ item: OutboxItem }> {
    return this.request(`/v1/ops/outbox/${itemId}/attempt-result`, { method: "POST", role: "developer", body: result });
  }
  listOutbox(): Promise<{ items: OutboxItem[] }> {
    return this.request("/v1/ops/outbox", { role: "developer" });
  }
  listInbox(): Promise<{ entries: WebhookInboxEntry[] }> {
    return this.request("/v1/ops/inbox", { role: "developer" });
  }
  markInboxProcessed(entryId: string): Promise<{ processed: boolean; entry: WebhookInboxEntry }> {
    return this.request(`/v1/internal/inbox/${entryId}/processed`, { method: "POST" });
  }
  getCase(caseId: string): Promise<DootCase> {
    return this.request(`/v1/ops/cases/${caseId}`, { role: "operator" });
  }
  signalProvider(workflowId: string, body: unknown) {
    return this.request(`/v1/internal/workflows/${workflowId}/provider-result`, { method: "POST", body });
  }
  signalRelease(workflowId: string, body: unknown) {
    return this.request(`/v1/internal/workflows/${workflowId}/release-result`, { method: "POST", body });
  }
  signalDecision(workflowId: string, body: unknown) {
    return this.request(`/v1/internal/workflows/${workflowId}/decision`, { method: "POST", body });
  }

  private async request<T>(path: string, options: { method?: string; body?: unknown; role?: string } = {}): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: { authorization: `Bearer ${this.serviceToken}`, "content-type": "application/json", ...(options.role ? { "x-doot-role": options.role } : {}) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });
    if (!response.ok) throw new DeliveryError(`Control API ${path} returned ${response.status}`, response.status >= 500 || response.status === 429);
    return response.json() as Promise<T>;
  }
}

export class DeliveryError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly externalRef?: string, readonly adapterResponse?: unknown) {
    super(message);
  }
}
