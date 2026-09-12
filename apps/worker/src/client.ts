import { Client, Connection } from "@temporalio/client";
import { loadConfig } from "@doot/config";
import type { DecisionSignal, ProviderCallResult } from "@doot/contracts";
import { CASE_WORKFLOW_TASK_QUEUE } from "./case-workflow";
import {
  caseWorkflow,
  decisionSignal,
  providerResultSignal,
  releaseResultSignal,
  type CaseWorkflowInput
} from "./workflows";

export async function createCaseWorkflowClient() {
  const config = loadConfig();
  const connection = await Connection.connect({ address: config.TEMPORAL_ADDRESS });
  const client = new Client({ connection, namespace: config.TEMPORAL_NAMESPACE });
  return {
    start(input: CaseWorkflowInput) {
      return client.workflow.start(caseWorkflow, {
        taskQueue: CASE_WORKFLOW_TASK_QUEUE,
        workflowId: input.workflowId,
        args: [input]
      });
    },
    signalProviderResult(workflowId: string, result: ProviderCallResult) {
      return client.workflow.getHandle(`${workflowId}/provider/${result.providerId}`).signal(providerResultSignal, result);
    },
    signalDecision(workflowId: string, decision: DecisionSignal) {
      return client.workflow.getHandle(workflowId).signal(decisionSignal, decision);
    },
    signalReleaseResult(workflowId: string, result: { holdId: string; succeeded: boolean }) {
      return client.workflow.getHandle(workflowId).signal(releaseResultSignal, result);
    },
    result(workflowId: string) {
      return client.workflow.getHandle(workflowId).result();
    },
    close() {
      return connection.close();
    }
  };
}
