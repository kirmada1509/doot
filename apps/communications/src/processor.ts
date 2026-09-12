import type { DootConfig } from "@doot/config";
import type { CommunicationCommand, DootCase, ProviderCallResult } from "@doot/contracts";
import { ControlApi, DeliveryError } from "./api";
import type { AdapterResult, CommunicationsAdapter } from "./adapters";

export class OutboxProcessor {
  constructor(private readonly api: ControlApi, private readonly adapter: CommunicationsAdapter, private readonly maxAttempts: number) {}
  async processOne(): Promise<boolean> {
    const { item } = await this.api.lease();
    if (!item) return false;
    try {
      if (item.command.kind !== "release_hold_goal") {
        const activeCase = await this.api.getCase(item.command.caseId);
        if (activeCase.state === "safety_handoff") {
          await this.api.record(item.id, {
            status: "sent",
            adapterResponse: { suppressed: true, reason: "CASE_IN_SAFETY_HANDOFF" }
          });
          return true;
        }
      }
      const delivery = await this.adapter.execute(item.command, item.externalRef);
      if (delivery.pending) {
        const timedOut = Date.now() - Date.parse(item.createdAt) > 3 * 60_000;
        await this.api.record(item.id, { status: timedOut ? "dead_lettered" : "pending", externalRef: delivery.externalRef, adapterResponse: delivery.response, countAttempt: false, ...(timedOut ? { error: "CALL-E Goal Run exceeded the three-minute demo deadline" } : {}) });
        return true;
      }
      await this.dispatchResult(item.command, delivery);
      await this.api.record(item.id, { status: "sent", externalRef: delivery.externalRef, adapterResponse: delivery.response });
    } catch (error) {
      const problem = error instanceof DeliveryError ? error : new DeliveryError(error instanceof Error ? error.message : "Unknown delivery error", true);
      const exhausted = item.attempts + 1 >= this.maxAttempts;
      await this.api.record(item.id, { status: problem.retryable && !exhausted ? "pending" : "dead_lettered", error: problem.message, ...(problem.externalRef ? { externalRef: problem.externalRef } : {}), ...(problem.adapterResponse !== undefined ? { adapterResponse: problem.adapterResponse } : {}) });
    }
    return true;
  }
  async processWebhookOne(): Promise<boolean> {
    const { entries } = await this.api.listInbox();
    const entry = entries.find((candidate) => candidate.source === "call-e" && candidate.processedAt === null);
    if (!entry) return false;
    const externalRef = webhookResourceId(entry.payload);
    if (!externalRef) {
      await this.api.markInboxProcessed(entry.id);
      return true;
    }
    const { items } = await this.api.listOutbox();
    const item = items.find((candidate) => candidate.externalRef === externalRef);
    if (!item) return false;
    if (item.status === "sent") {
      await this.api.markInboxProcessed(entry.id);
      return true;
    }
    try {
      const delivery = await this.adapter.execute(item.command, externalRef);
      if (delivery.pending) return true;
      await this.dispatchResult(item.command, delivery);
      await this.api.record(item.id, { status: "sent", externalRef: delivery.externalRef, adapterResponse: delivery.response });
      await this.api.markInboxProcessed(entry.id);
    } catch (error) {
      const problem = error instanceof DeliveryError ? error : new DeliveryError(error instanceof Error ? error.message : "Unknown webhook recovery error", true);
      if (!problem.retryable) {
        await this.api.record(item.id, { status: "dead_lettered", error: problem.message, externalRef });
        await this.api.markInboxProcessed(entry.id);
      }
    }
    return true;
  }
  private async dispatchResult(command: CommunicationCommand, delivery: AdapterResult): Promise<void> {
    if (command.kind === "provider_hold_goal") return void await this.api.signalProvider(command.workflowId, delivery.result as ProviderCallResult);
    if (command.kind === "release_hold_goal") return void await this.api.signalRelease(command.workflowId, { holdId: command.target.holdId, succeeded: readSucceeded(delivery.result) });
    if (command.kind === "caller_decision_callback") {
      const activeCase = await this.api.getCase(command.caseId);
      await this.api.signalDecision(command.workflowId, decisionFromResult(activeCase, delivery.result, command.goal.input.case_version));
    }
  }
}

export async function runProcessor(config: DootConfig, api: ControlApi, adapter: CommunicationsAdapter, signal?: AbortSignal) {
  const processor = new OutboxProcessor(api, adapter, config.COMMUNICATION_MAX_ATTEMPTS);
  while (!signal?.aborted) {
    try {
      const outboxWorked = await processor.processOne();
      const webhookWorked = await processor.processWebhookOne();
      await sleep(config.COMMUNICATION_POLL_MS, signal);
    } catch {
      await sleep(config.COMMUNICATION_POLL_MS, signal);
    }
  }
}
function decisionFromResult(activeCase: DootCase, result: unknown, callbackCaseVersion?: string) {
  const active = activeCase.holds.filter((hold) => hold.status === "active");
  const wanted = typeof result === "object" && result !== null ? (result as Record<string, unknown>).selected_hold_id : undefined;
  const selected = active.find((hold) => hold.id === wanted);
  if (!selected) throw new DeliveryError("Callback completed without one valid explicit hold selection", false);
  const commandVersion = Number(callbackCaseVersion);
  const caseVersion = Number.isInteger(commandVersion) ? commandVersion : (activeCase.decisionVersion ?? activeCase.version);
  return { caseId: activeCase.id, caseVersion, selectedHoldId: selected.id, actor: "caller", verification: "phone_match_and_reference" };
}
function readSucceeded(result: unknown): boolean {
  const released = typeof result === "object" && result !== null ? (result as Record<string, unknown>).released : undefined;
  if (typeof released !== "boolean") {
    throw new DeliveryError("Release result omitted explicit provider confirmation", false);
  }
  return released;
}
function webhookResourceId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const data = typeof record.data === "object" && record.data !== null ? record.data as Record<string, unknown> : null;
  for (const value of [data?.id, data?.goal_run_id, record.goal_run_id, record.run_id]) if (typeof value === "string") return value;
  return null;
}
function sleep(ms: number, signal?: AbortSignal) { return new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); }); }
