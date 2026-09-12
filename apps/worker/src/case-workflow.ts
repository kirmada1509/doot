import type { CommunicationCommand, DootCase, Provider } from "@doot/contracts";
import {
  buildCallerDecisionCallbackCommand,
  buildProviderHoldGoalCommand,
  buildReleaseHoldCommand,
  demoProviders,
  idempotencyKey
} from "@doot/core";

export const CASE_WORKFLOW_TASK_QUEUE = "doot-case-workflows";

export const caseWorkflowSignals = {
  providerResult: "providerResult",
  decision: "decision",
  manualIntervention: "manualIntervention",
  cancel: "cancel"
} as const;

export type CaseWorkflowSignalName = (typeof caseWorkflowSignals)[keyof typeof caseWorkflowSignals];

export type PlannedChildWorkflow = {
  id: string;
  type: "provider_goal" | "caller_callback" | "release_hold" | "hold_expiry_timer";
  commandId: string | null;
  idempotencyKey: string;
  timeoutSeconds: number;
};

export type CaseWorkflowPlan = {
  workflowId: string;
  taskQueue: string;
  caseId: string;
  caseDeadlineAt: string;
  signals: CaseWorkflowSignalName[];
  childWorkflows: PlannedChildWorkflow[];
  commands: CommunicationCommand[];
};

export function createCaseWorkflowPlan(current: DootCase, providers: Provider[] = demoProviders.slice(0, 3)): CaseWorkflowPlan {
  const providerCommands = providers.map((provider) => buildProviderHoldGoalCommand(current, provider));
  const callbackCommand = buildCallerDecisionCallbackCommand(current);
  const releaseCommands = current.holds
    .filter((hold) => hold.status === "release_pending")
    .map((hold) => buildReleaseHoldCommand(current, hold));
  const commands = [...providerCommands, callbackCommand, ...releaseCommands];

  return {
    workflowId: current.workflowId,
    taskQueue: CASE_WORKFLOW_TASK_QUEUE,
    caseId: current.id,
    caseDeadlineAt: current.callbackDeadlineAt,
    signals: Object.values(caseWorkflowSignals),
    childWorkflows: [
      ...providerCommands.map((command): PlannedChildWorkflow => ({
        id: `child_${command.id}`,
        type: "provider_goal",
        commandId: command.id,
        idempotencyKey: command.idempotencyKey,
        timeoutSeconds: current.mode === "urgent" ? 90 : 300
      })),
      {
        id: `child_${callbackCommand.id}`,
        type: "caller_callback",
        commandId: callbackCommand.id,
        idempotencyKey: callbackCommand.idempotencyKey,
        timeoutSeconds: 180
      },
      ...current.holds.map((hold): PlannedChildWorkflow => ({
        id: `timer_${hold.id}`,
        type: "hold_expiry_timer",
        commandId: null,
        idempotencyKey: idempotencyKey([current.id, hold.id, "hold_expiry_timer"]),
        timeoutSeconds: Math.max(0, Math.ceil((new Date(hold.expiresAt).getTime() - Date.now()) / 1_000))
      })),
      ...releaseCommands.map((command): PlannedChildWorkflow => ({
        id: `child_${command.id}`,
        type: "release_hold",
        commandId: command.id,
        idempotencyKey: command.idempotencyKey,
        timeoutSeconds: 120
      }))
    ],
    commands
  };
}
