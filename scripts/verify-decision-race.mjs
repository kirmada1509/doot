const apiUrl = process.env.API_URL ?? "http://localhost:4000";

await request("/v1/demo/reset", { method: "POST" });
const queue = await request("/v1/ops/cases");
const current = queue.cases.find((item) => item.mode === "urgent");
if (!current) throw new Error("Urgent case missing from race fixture");

const body = JSON.stringify({
  caseVersion: current.version,
  selectedHoldId: current.holds[0].id,
  actor: "caller",
  verification: "phone_match_and_reference"
});
const options = { method: "POST", headers: { "content-type": "application/json" }, body };
const responses = await Promise.all([
  fetch(`${apiUrl}/v1/ops/cases/${current.id}/actions/decide`, options),
  fetch(`${apiUrl}/v1/ops/cases/${current.id}/actions/decide`, options)
]);
const statuses = responses.map((response) => response.status).sort();
if (statuses[0] !== 200 || statuses[1] !== 409) {
  throw new Error(`Expected one committed decision and one conflict, got ${statuses.join(", ")}`);
}

const persisted = await request(`/v1/ops/cases/${current.id}`);
if (persisted.holds.filter((hold) => hold.status === "committed").length !== 1) {
  throw new Error("Decision race did not leave exactly one committed hold");
}
const outbox = await request("/v1/ops/outbox");
const commands = outbox.items.map((item) => item.command.kind);
if (commands.filter((kind) => kind === "release_hold_goal").length !== 1 || commands.filter((kind) => kind === "comparison_sms").length !== 1) {
  throw new Error("Decision race created duplicate or missing release/SMS commands");
}

await request("/v1/demo/reset", { method: "POST" });

async function request(path, options) {
  const response = await fetch(`${apiUrl}${path}`, options);
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  return response.json();
}
