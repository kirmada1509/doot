import { loadConfig } from "@doot/config";
import { ControlApi } from "./api";
import { createAdapter, verifyPublishedGoals } from "./adapters";
import { runProcessor } from "./processor";

export { ControlApi, DeliveryError } from "./api";
export { createAdapter, MockAdapter, verifyPublishedGoals } from "./adapters";
export { OutboxProcessor, runProcessor } from "./processor";

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  const adapter = createAdapter(config);
  await verifyPublishedGoals(config);
  await runProcessor(config, new ControlApi(config.CONTROL_API_URL, config.INTERNAL_SERVICE_TOKEN), adapter, controller.signal);
}
