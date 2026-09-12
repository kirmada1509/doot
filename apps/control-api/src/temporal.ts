import { Client, Connection } from "@temporalio/client";
import type { DootConfig } from "@doot/config";
import type { DecisionSignal, DootCase, ProviderCallResult } from "@doot/contracts";

export class TemporalGateway {
  private connection: Connection | null = null;
  private client: Client | null = null;

  constructor(private readonly config: DootConfig) {}

  async ready() {
    if (!this.config.TEMPORAL_ENABLED) return true;
    try {
      await this.getClient();
      return true;
    } catch {
      return false;
    }
  }

  async startCase(current: DootCase, providerIds: string[]) {
    if (!this.config.TEMPORAL_ENABLED) return { started: false, workflowId: current.workflowId };
    const client = await this.getClient();
    const handle = await client.workflow.start("caseWorkflow", {
      taskQueue: "doot-case-workflows",
      workflowId: current.workflowId,
      args: [{
        caseId: current.id,
        workflowId: current.workflowId,
        providerIds,
        callbackDeadlineAt: current.callbackDeadlineAt
      }]
    });
    return { started: true, workflowId: handle.workflowId, firstExecutionRunId: handle.firstExecutionRunId };
  }

  async signalProviderResult(workflowId: string, result: ProviderCallResult) {
    if (!this.config.TEMPORAL_ENABLED) return false;
    const client = await this.getClient();
    await client.workflow.getHandle(`${workflowId}/provider/${result.providerId}`).signal("providerResult", result);
    return true;
  }

  async signalDecision(workflowId: string, signal: DecisionSignal) {
    if (!this.config.TEMPORAL_ENABLED) return false;
    const client = await this.getClient();
    await client.workflow.getHandle(workflowId).signal("decision", signal);
    return true;
  }

  async signalReleaseResult(workflowId: string, result: { holdId: string; succeeded: boolean }) {
    if (!this.config.TEMPORAL_ENABLED) return false;
    const client = await this.getClient();
    await client.workflow.getHandle(workflowId).signal("releaseResult", result);
    return true;
  }

  async signalSafetyHandoff(workflowId: string) {
    if (!this.config.TEMPORAL_ENABLED) return false;
    const client = await this.getClient();
    await client.workflow.getHandle(workflowId).signal("safetyHandoff");
    return true;
  }

  async queryStatus(workflowId: string) {
    if (!this.config.TEMPORAL_ENABLED) return null;
    try {
      const client = await this.getClient();
      return await client.workflow.getHandle(workflowId).query("status");
    } catch {
      return null;
    }
  }

  async close() {
    await this.connection?.close();
  }

  private async getClient() {
    if (this.client) return this.client;
    this.connection = await Connection.connect({ address: this.config.TEMPORAL_ADDRESS });
    this.client = new Client({ connection: this.connection, namespace: this.config.TEMPORAL_NAMESPACE });
    return this.client;
  }
}
