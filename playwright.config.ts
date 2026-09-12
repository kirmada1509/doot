import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/acceptance",
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: process.env.DOOT_ACCEPTANCE_BASE_URL ?? "http://127.0.0.1:3300",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    permissions: ["microphone"],
    launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
    ...devices["Desktop Chrome"]
  },
  webServer: process.env.DOOT_ACCEPTANCE_EXTERNAL === "1" ? [] : [
    {
      command: "PORT=4300 DATA_STORE=memory TEMPORAL_ENABLED=false AUTH_MODE=demo CONSOLE_ORIGIN=http://127.0.0.1:3300 VOICE_RUNTIME_PUBLIC_WS_URL=ws://127.0.0.1:4400 pnpm --filter @doot/control-api exec bun src/server.ts",
      url: "http://127.0.0.1:4300/health/live",
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: "cd apps/voice-runtime && CONTROL_API_URL=http://127.0.0.1:4300 .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 4400",
      url: "http://127.0.0.1:4400/health/live",
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: "DOOT_API_INTERNAL_URL=http://127.0.0.1:4300 pnpm --filter @doot/console exec next dev -p 3300",
      url: "http://127.0.0.1:3300",
      reuseExistingServer: false,
      timeout: 60_000
    }
  ]
});
