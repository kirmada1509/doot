import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { createDemoCase } from "@doot/core";
import type { ProviderCallResult } from "@doot/contracts";
import {
  caseWorkflow,
  decisionSignal,
  providerResultSignal,
  releaseResultSignal,
  safetyHandoffSignal
} from "../src/workflows";

describe.sequential("Temporal CaseWorkflow", () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal();
  }, 60_000);

  afterAll(async () => {
    await environment?.teardown();
  });

  it("fans out concurrently, commits one decision, and waits for explicit release proof", async () => {
    const current = createDemoCase(new Date());
    const recorded: ProviderCallResult[] = [];
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "workflow-happy-path",
      workflowsPath: new URL("../src/workflows.ts", import.meta.url).pathname,
      activities: {
        requestProviderGoal: async () => undefined,
        recordProviderResult: async (result: ProviderCallResult) => { recorded.push(result); },
        requestCallerCallback: async () => current,
        commitDecision: async () => ({
          ...current,
          holds: current.holds.map((hold, index) => ({ ...hold, status: index === 0 ? "committed" as const : "release_pending" as const }))
        }),
        recordReleaseResult: async () => ({ ...current, state: "resolved" as const }),
        expireCase: async () => ({ ...current, state: "expired" as const }),
        expireHold: async () => current,
        pauseForManualReview: async () => ({ ...current, state: "manual_review" as const })
      }
    });

    const result = await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start(caseWorkflow, {
        taskQueue: "workflow-happy-path",
        workflowId: "case-test-happy",
        args: [{
          caseId: current.id,
          workflowId: "case-test-happy",
          providerIds: ["provider_lotus", "provider_ashraya"],
          callbackDeadlineAt: new Date(Date.now() + 10_000).toISOString(),
          providerTimeoutMs: 5_000,
          releaseTimeoutMs: 5_000
        }]
      });

      await signalEventually("case-test-happy/provider/provider_lotus", providerResult("provider_lotus", current.id));
      await signalEventually("case-test-happy/provider/provider_ashraya", providerResult("provider_ashraya", current.id));
      await handle.signal(decisionSignal, {
        caseId: current.id,
        caseVersion: current.version,
        selectedHoldId: current.holds[0]!.id,
        actor: "caller",
        verification: "phone_match_and_reference"
      });
      await handle.signal(releaseResultSignal, { holdId: current.holds[1]!.id, succeeded: true });
      return handle.result();
    });

    expect(result.finalState).toBe("resolved");
    expect(result.providerResults).toBe(2);
    expect(result.releaseResults).toBe(1);
    expect(recorded).toHaveLength(2);
  }, 30_000);

  it("uses a durable provider timer and closes a case with no options", async () => {
    const current = createDemoCase(new Date());
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "workflow-timeout",
      workflowsPath: new URL("../src/workflows.ts", import.meta.url).pathname,
      activities: {
        requestProviderGoal: async () => undefined,
        recordProviderResult: async () => undefined,
        requestCallerCallback: async () => ({ ...current, state: "no_options" as const, holds: [] }),
        commitDecision: async () => current,
        recordReleaseResult: async () => current,
        expireCase: async () => ({ ...current, state: "expired" as const }),
        expireHold: async () => current,
        pauseForManualReview: async () => ({ ...current, state: "manual_review" as const })
      }
    });
    const result = await worker.runUntil(() => environment.client.workflow.execute(caseWorkflow, {
      taskQueue: "workflow-timeout",
      workflowId: "case-test-timeout",
      args: [{
        caseId: current.id,
        workflowId: "case-test-timeout",
        providerIds: ["provider_lotus"],
        callbackDeadlineAt: new Date(Date.now() + 2_000).toISOString(),
        providerTimeoutMs: 20
      }]
    }));

    expect(result.finalState).toBe("no_options");
    expect(result.providerResults).toBe(1);
  }, 30_000);

  it("replays from history after the worker stops during provider wait", async () => {
    const current = { ...createDemoCase(new Date()), holds: [createDemoCase(new Date()).holds[0]!] };
    let dispatchCount = 0;
    const activities = {
      requestProviderGoal: async () => { dispatchCount += 1; },
      recordProviderResult: async () => undefined,
      requestCallerCallback: async () => current,
      commitDecision: async () => ({ ...current, state: "resolved" as const, holds: current.holds.map((hold) => ({ ...hold, status: "committed" as const })) }),
      recordReleaseResult: async () => current,
      expireCase: async () => ({ ...current, state: "expired" as const }),
      pauseForManualReview: async () => ({ ...current, state: "manual_review" as const }),
      expireHold: async () => current
    };
    const createWorker = () => Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "workflow-recovery",
      workflowsPath: new URL("../src/workflows.ts", import.meta.url).pathname,
      activities
    });
    const firstWorker = await createWorker();
    const running = firstWorker.run();
    const handle = await environment.client.workflow.start(caseWorkflow, {
      taskQueue: "workflow-recovery",
      workflowId: "case-test-recovery",
      args: [{
        caseId: current.id,
        workflowId: "case-test-recovery",
        providerIds: ["provider_lotus"],
        callbackDeadlineAt: new Date(Date.now() + 10_000).toISOString(),
        providerTimeoutMs: 5_000
      }]
    });
    await pollEventually(() => dispatchCount === 1);
    firstWorker.shutdown();
    await running;

    await handle.signal(decisionSignal, {
      caseId: current.id,
      caseVersion: current.version,
      selectedHoldId: current.holds[0]!.id,
      actor: "caller",
      verification: "phone_match_and_reference"
    });
    await environment.client.workflow.getHandle("case-test-recovery/provider/provider_lotus")
      .signal(providerResultSignal, providerResult("provider_lotus", current.id));

    const secondWorker = await createWorker();
    const result = await secondWorker.runUntil(() => handle.result());
    expect(result.finalState).toBe("resolved");
    expect(dispatchCount).toBe(1);
  }, 30_000);

  it("expires active holds with durable timers before a late decision can commit", async () => {
    const now = Date.now();
    const hold = {
      ...createDemoCase(new Date(now)).holds[0]!,
      expiresAt: new Date(now + 80).toISOString()
    };
    const current = {
      ...createDemoCase(new Date(now)),
      holds: [hold]
    };
    const expired: string[] = [];
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "workflow-hold-expiry",
      workflowsPath: new URL("../src/workflows.ts", import.meta.url).pathname,
      activities: {
        requestProviderGoal: async () => undefined,
        recordProviderResult: async () => undefined,
        requestCallerCallback: async () => current,
        commitDecision: async () => current,
        recordReleaseResult: async () => current,
        expireCase: async () => ({ ...current, state: "expired" as const }),
        expireHold: async (input: { holdId: string }) => {
          expired.push(input.holdId);
          return {
            ...current,
            state: "expired" as const,
            holds: current.holds.map((item) => ({ ...item, status: "expired" as const }))
          };
        },
        pauseForManualReview: async () => ({ ...current, state: "manual_review" as const })
      }
    });

    const result = await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start(caseWorkflow, {
        taskQueue: "workflow-hold-expiry",
        workflowId: "case-test-hold-expiry",
        args: [{
          caseId: current.id,
          workflowId: "case-test-hold-expiry",
          providerIds: ["provider_lotus"],
          callbackDeadlineAt: new Date(now + 5_000).toISOString(),
          providerTimeoutMs: 50
        }]
      });
      await signalEventually("case-test-hold-expiry/provider/provider_lotus", providerResult("provider_lotus", current.id));
      return handle.result();
    });

    expect(result.finalState).toBe("expired");
    expect(expired).toContain(hold.id);
  }, 30_000);

  it("cancels provider fanout when a mid-call safety handoff arrives", async () => {
    const current = createDemoCase(new Date());
    let providerRequested = false;
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "workflow-safety-handoff",
      workflowsPath: new URL("../src/workflows.ts", import.meta.url).pathname,
      activities: {
        requestProviderGoal: async () => { providerRequested = true; },
        recordProviderResult: async () => undefined,
        requestCallerCallback: async () => current,
        commitDecision: async () => current,
        recordReleaseResult: async () => current,
        expireCase: async () => ({ ...current, state: "expired" as const }),
        expireHold: async () => current,
        pauseForManualReview: async () => ({ ...current, state: "manual_review" as const })
      }
    });

    const result = await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start(caseWorkflow, {
        taskQueue: "workflow-safety-handoff",
        workflowId: "case-test-safety",
        args: [{
          caseId: current.id,
          workflowId: "case-test-safety",
          providerIds: ["provider_lotus"],
          callbackDeadlineAt: new Date(Date.now() + 10_000).toISOString(),
          providerTimeoutMs: 5_000
        }]
      });
      await pollEventually(() => providerRequested);
      await handle.signal(safetyHandoffSignal);
      return handle.result();
    });

    expect(result.finalState).toBe("safety_handoff");
  }, 30_000);

  async function signalEventually(workflowId: string, result: ProviderCallResult) {
    const handle = environment.client.workflow.getHandle(workflowId);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await handle.signal(providerResultSignal, result);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    throw new Error(`Child workflow ${workflowId} did not start`);
  }

  async function pollEventually(check: () => boolean) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Timed out waiting for workflow progress");
  }
});

function providerResult(providerId: string, caseId: string): ProviderCallResult {
  return {
    caseId,
    providerId,
    externalCallId: `call-${providerId}`,
    outcome: "hold_secured",
    eligibility: { status: "eligible", criteria: ["fixture"] },
    hold: { reference: `REF-${providerId}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), constraints: [] },
    evidenceSummary: "Provider confirmed a bounded test hold.",
    confidence: "high"
  };
}
