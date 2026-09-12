import { createServer } from "node:http";

const port = Number(process.env.MOCK_CALLE_PORT ?? 4499);
const caseCode = process.env.MOCK_CASE_CODE ?? "000000";
let created = 0;

createServer(async (request, response) => {
  const send = (status, body) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (request.url === "/__count") return send(200, { created });
  if (request.url === "/v1/calls" && request.method === "POST") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (request.headers.authorization !== "Bearer integration-test-key" ||
        !request.headers["idempotency-key"]?.startsWith("doot_rehearsal_") ||
        body.recipients?.[0]?.phones?.[0] !== "+14155550123" ||
        !body.task?.includes(caseCode)) return send(400, { code: "INVALID_TEST_REQUEST" });
    created++;
    return send(201, { id: "call_integration_1", status: "queued" });
  }
  if (request.url === "/v1/calls/call_integration_1" && request.method === "GET") {
    if (request.headers.authorization !== "Bearer integration-test-key") return send(401, {});
    return send(200, {
      id: "call_integration_1", status: "completed", task_completed: true,
      structured_result: { case_code_confirmed: "yes", synthetic_availability: "yes" },
      completed_at: new Date().toISOString(),
      recipients: [{ attempts: [{ transcript_turns: [
        { speaker: "bot", text: `Please repeat code ${caseCode}.`, offset_seconds: 0 },
        { speaker: "user", text: `My demo code is ${caseCode}. Fictional availability is yes.`, offset_seconds: 4 }
      ] }] }]
    });
  }
  send(404, {});
}).listen(port, "127.0.0.1");
