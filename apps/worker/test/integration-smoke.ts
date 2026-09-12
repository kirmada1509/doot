import type { DootCase, OutboxItem } from "@doot/contracts";
import { createCaseWorkflowClient } from "../src/client";

const apiUrl = process.env.CONTROL_API_URL ?? "http://localhost:4020";
const authHeaders = { "x-doot-role": "operator" };
await request("/v1/demo/reset", { method: "POST", headers: authHeaders });
const created = await request<{ case: DootCase; workflow: { started: boolean; workflowId: string } }>("/v1/cases", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    callerPhoneBlindIndex: "integration-blind-index",
    callerLabel: "Integration caller",
    utterance: "I need an accessible shelter tonight in Indiranagar",
    consentAccepted: true,
    recordingAccepted: true,
    requestedFor: "self",
    languageHint: "hinglish",
    location: "indiranagar",
    service: "shelter",
    accessibilityNeeds: ["wheelchair"]
  })
});
if (!created.workflow.started) throw new Error("Control API did not start Temporal workflow");

const temporal = await createCaseWorkflowClient();
try {
  const result = await temporal.result(created.workflow.workflowId) as { finalState: string };
  if (result.finalState !== "resolved") throw new Error(`Temporal workflow finished in ${result.finalState}`);
  const finalCase = await request<DootCase>(`/v1/ops/cases/${created.case.id}`, { headers: authHeaders });
  if (finalCase.state !== "resolved" || finalCase.attempts.length !== 2 || finalCase.holds.some((hold) => hold.status === "release_pending")) {
    throw new Error("PostgreSQL case did not persist the complete communications-driven workflow");
  }
  const outbox = await pollValue(async () => {
    const response = await request<{ items: OutboxItem[] }>("/v1/ops/outbox", { headers: authHeaders });
    return response.items.length >= 6 && response.items.every((item) => item.status === "sent") ? response.items : null;
  }, "all communications commands to be delivered");
  const kinds = new Set(outbox.map((item) => item.command.kind));
  for (const required of ["provider_hold_goal", "caller_decision_callback", "release_hold_goal", "comparison_sms", "post_commit_confirmation"]) {
    if (!kinds.has(required as OutboxItem["command"]["kind"])) throw new Error(`Missing delivered ${required} command`);
  }
  console.log(`Communications-driven Temporal integration passed for ${created.workflow.workflowId}`);
} finally {
  await temporal.close();
}

async function pollValue<T>(check: () => Promise<T | null>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = await check();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, init);
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}
