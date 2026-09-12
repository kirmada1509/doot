import { expect, test } from "@playwright/test";

const localApi = process.env.DOOT_ACCEPTANCE_API_URL ?? "http://127.0.0.1:4300";

test("caller can dial, consent, and submit an explicitly labeled fixture request", async ({ page, request }) => {
  if (process.env.DOOT_ACCEPTANCE_EXTERNAL !== "1") await request.post(`${localApi}/v1/demo/reset`);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Call Doot" })).toBeVisible();
  await page.getByRole("button", { name: "Dial 4" }).first().focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Dial 0" }).first().click();
  await page.getByRole("button", { name: "Dial 4" }).first().click();
  await page.getByRole("button", { name: "Dial 0" }).first().click();
  await expect(page.getByLabel("Doot demo line")).toHaveValue("4040");
  await page.getByRole("button", { name: "Call demo line" }).click();
  await expect(page.getByText("Consent needed")).toBeVisible();
  await expect(page.getByText(/AI coordination agent/)).toBeVisible();
  await page.getByRole("button", { name: "I agree and continue" }).click();
  await page.getByRole("button", { name: "Use fixture spoken request" }).click();
  await expect(page.getByText("I need a wheelchair accessible shelter tonight")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Finding your options" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dial 9" })).toHaveCount(0);
  await page.screenshot({ path: "output/playwright/doot-caller-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Finding your options" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});

test("microphone denial keeps consent visible and does not create a case", async ({ page, context, request }) => {
  if (process.env.DOOT_ACCEPTANCE_EXTERNAL !== "1") await request.post(`${localApi}/v1/demo/reset`);
  await context.clearPermissions();
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => { throw new DOMException("denied", "NotAllowedError"); } });
  });
  await page.goto("/");
  await page.getByLabel("Doot demo line").fill("4040");
  await page.getByRole("button", { name: "Call demo line" }).click();
  await expect(page.getByText("Consent needed")).toBeVisible();
  await page.getByRole("button", { name: "I agree and continue" }).click();
  await expect(page.locator(".caller-error")).toContainText("Microphone access is required");
  await expect(page.getByRole("heading", { name: "Ready when you are" })).toBeVisible();
});

test("provider failure and timeout leave the caller without a claimed reservation", async ({ page }) => {
  await page.route(/\/api\/control\/v1\/caller\/sessions\/vs_[^/]+$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ json: {
      case: { id: "case_no_options", state: "no_options", holds: [], version: 1 },
      calls: [
        { id: "lotus", kind: "provider_hold_goal", providerName: "Lotus", source: "fixture", status: "failed", goalRunId: null, outcome: null, error: "Provider failed" },
        { id: "ashraya", kind: "provider_hold_goal", providerName: "Ashraya", source: "fixture", status: "failed", goalRunId: null, outcome: null, error: "Provider timed out" }
      ],
      service: "shelter"
    } });
  });
  await page.goto("/");
  await page.getByLabel("Doot demo line").fill("4040");
  await page.getByRole("button", { name: "Call demo line" }).click();
  await expect(page.getByRole("heading", { name: "No option confirmed" })).toBeVisible();
  await expect(page.getByText("Provider timed out")).toBeVisible();
  await expect(page.getByText("No demo reservation was made.", { exact: false })).toBeVisible();
  await expect(page.locator(".caller-options button")).toHaveCount(0);
});

test("operator uses explicit override and can inspect proof on desktop and mobile", async ({ page, request }) => {
  if (process.env.DOOT_ACCEPTANCE_EXTERNAL === "1") test.skip();
  await request.post(`${localApi}/v1/demo/reset`);
  await page.goto("/ops");
  await expect(page.getByRole("complementary", { name: "Case queue" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Outbound calls" })).toBeVisible();
  const hold = page.locator(".ops-hold").first();
  await hold.locator("input").focus();
  await page.keyboard.press("Space");
  await expect(hold.locator("input")).toBeChecked();
  await page.getByRole("button", { name: "Commit operator override" }).click();
  await expect(page.getByText("Operator override recorded")).toBeVisible();
  await page.getByRole("tab", { name: "Proof and audit" }).click();
  await expect(page.getByRole("heading", { name: "Case timeline" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Command outbox" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});

test("CALL-E rehearsal is opt-in, separate from fixture holds, and shows authenticated proof", async ({ page, request }) => {
  if (process.env.DOOT_ACCEPTANCE_EXTERNAL !== "1") await request.post(`${localApi}/v1/demo/reset`);
  let posted = 0;
  await page.route(/\/api\/control\/v1\/ops\/cases\/[^/]+\/call-e-rehearsal$/, async (route) => {
    if (route.request().method() === "POST") {
      posted++;
      await route.fulfill({ status: 202, json: {
        caseId: "case_demo_urgent_001", service: "shelter", callId: "call_verified_demo", status: "queued",
        availability: null, caseCodeConfirmed: null, answered: false, taskCompleted: null,
        verifiedConversation: false, transcriptAvailable: false, errorCode: null
      } });
      return;
    }
    await route.fulfill({ json: { configured: true, rehearsal: posted ? {
      caseId: "case_demo_urgent_001", service: "shelter", callId: "call_verified_demo", status: "queued",
      availability: null, caseCodeConfirmed: null, answered: false, taskCompleted: null,
      verifiedConversation: false, transcriptAvailable: false, errorCode: null
    } : null } });
  });
  await page.goto("/ops");
  await page.getByRole("tab", { name: "Proof and audit" }).click();
  await expect(page.getByRole("heading", { name: "Live CALL-E rehearsal" })).toBeVisible();
  await expect(page.getByText("Authorized human answerer", { exact: false })).toBeVisible();
  const place = page.getByRole("button", { name: "Place CALL-E rehearsal call" });
  await expect(place).toBeDisabled();
  await page.getByRole("checkbox", { name: /I control the configured number/ }).focus();
  await page.keyboard.press("Space");
  await expect(place).toBeEnabled();
  await place.click();
  await expect(page.locator(".ops-rehearsal-result")).toContainText("call_verified_demo");
  expect(posted).toBe(1);
  await expect(page.locator(".ops-rehearsal-result")).toContainText("Answered conversation Not verified");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});

test("external fixture stack completes two holds, explicit choice, and alternative release", async ({ page }) => {
  if (process.env.DOOT_ACCEPTANCE_EXTERNAL !== "1") test.skip();
  await page.goto("/");
  await page.getByLabel("Doot demo line").fill("4040");
  const sessionResponse = page.waitForResponse((response) => response.url().endsWith("/v1/caller/sessions") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Call demo line" }).click();
  const { sessionToken } = await (await sessionResponse).json() as { sessionToken: string };
  await expect(page.getByText("Consent needed")).toBeVisible();
  await page.getByRole("button", { name: "I agree and continue" }).click();
  await page.getByRole("button", { name: "Use fixture spoken request" }).click();
  await expect(page.locator(".provider-line")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator(".caller-options button")).toHaveCount(2, { timeout: 30_000 });
  await page.locator(".caller-options button").first().focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Choice recorded")).toBeVisible({ timeout: 30_000 });
  const snapshotUrl = `/api/control/v1/caller/sessions/${sessionToken}`;
  await expect.poll(async () => {
    const response = await page.request.get(snapshotUrl);
    const snapshot = await response.json() as { case: { holds: Array<{ status: string }> }; calls: Array<{ kind: string; status: string; source: string }> };
    return snapshot.case.holds.some((hold) => hold.status === "committed") &&
      snapshot.case.holds.some((hold) => hold.status === "released") &&
      snapshot.calls.some((call) => call.kind === "release_hold_goal" && call.status === "completed" && call.source === "fixture");
  }, { timeout: 30_000 }).toBe(true);
  await page.screenshot({ path: "output/playwright/doot-caller-two-holds.png", fullPage: true });
});
