import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { loadConfig } from "@doot/config";
import * as activities from "./activities";
import { CASE_WORKFLOW_TASK_QUEUE } from "./case-workflow";

export async function runTemporalWorker() {
  const config = loadConfig();
  const connection = await NativeConnection.connect({ address: config.TEMPORAL_ADDRESS });
  const worker = await Worker.create({
    connection,
    namespace: config.TEMPORAL_NAMESPACE,
    taskQueue: CASE_WORKFLOW_TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    activities
  });
  await worker.run();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTemporalWorker().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
