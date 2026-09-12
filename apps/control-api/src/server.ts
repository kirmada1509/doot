import { randomUUID, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import cors from "@elysiajs/cors";
import { Elysia, t } from "elysia";
import { loadConfig } from "@doot/config";
import {
  applyDecision,
  authorizationProblem,
  buildComparisonSmsCommand,
  buildDiagnostics,
  buildPostCommitConfirmationCommand,
  buildCallerDecisionCallbackCommand,
  buildProviderHoldGoalCommand,
  buildReleaseHoldCommand,
  classifyIntake,
  confirmRelease,
  createDemoAuthContext,
  demoCaseCode,
  decideAuditAccess,
  demoProviders,
  event,
  isAuthorized,
  markArtifactDeleted,
  normalizeProviderResult,
  outcomeMetrics,
  planArtifactDeletion,
  projectReliability,
  redactTelemetryAttributes,
  selectProviders,
  idempotencyKey,
  markHoldExpired,
  verifyExistingCaller
} from "@doot/core";
import { ProviderCallResultSchema, type AccessRole, type AuditArtifact, type AuthContext, type DootCase, type Hold, type ProviderAttempt } from "@doot/contracts";
import { createStateStore, StoreConflictError } from "./persistence";
import { TemporalGateway } from "./temporal";
import { bindVoiceSessionCase, createVoiceSession, getVoiceSession } from "./voice-sessions";
import { AuditArchive } from "./archive";
import { instrumentation } from "./instrumentation";
import { setAttributes } from "@elysiajs/opentelemetry";
import { caseCodeSpoken, createRehearsalCall, readRehearsalCall, rehearsalConfigured, type RehearsalRecord, type RehearsalTurn } from "./call-e-rehearsal";

const config = loadConfig();
if (config.COMMUNICATION_MODE === "live" && config.SEED_DEMO_DATA) {
  throw new Error("Live CALL-E judging requires SEED_DEMO_DATA=false");
}
const store = await createStateStore(config);
if (config.COMMUNICATION_MODE === "live" && (await store.listCases()).some((item) => item.id.startsWith("case_demo_"))) {
  throw new Error("Live CALL-E judging requires a clean database without seeded fixture cases");
}
const temporal = new TemporalGateway(config);
const archive = new AuditArchive(config);
const oidcKeys = createRemoteJWKSet(new URL(config.OIDC_JWKS_URL));
if (config.SEED_DEMO_DATA) await seedDemoArchive();

const withCorrelation = new Elysia({ name: "correlation" }).derive(({ headers }) => {
  return correlationFromHeaders(headers);
});

const app = new Elysia()
  .use(instrumentation)
  .use(cors({ origin: config.CONSOLE_ORIGIN, credentials: true }))
  .use(withCorrelation)
  .onBeforeHandle(({ headers, request }) => {
    const { requestId, traceId } = correlationFromHeaders(headers);
    const caseId = new URL(request.url).pathname.match(/\/cases\/([^/]+)/)?.[1];
    setAttributes({
      "doot.request_id": requestId,
      "doot.trace_id": traceId,
      ...(caseId ? { "doot.case_id": caseId } : {})
    });
  })
  .get("/health/live", () => ({ ok: true, service: "control-api" }))
  .get("/health/ready", async ({ set }) => {
    const [databaseReady, temporalReady] = await Promise.all([store.ready(), temporal.ready()]);
    if (!databaseReady || !temporalReady) set.status = 503;
    return {
      ok: databaseReady && temporalReady,
      dependencies: {
        database: databaseReady ? store.kind : "unavailable",
        temporal: config.TEMPORAL_ENABLED ? (temporalReady ? "ready" : "unavailable") : "disabled"
      }
    };
  })
  .get("/v1/auth/context", async ({ headers, set }) => {
    const auth = await authFromHeaders(headers);
    if (!auth) {
      set.status = 401;
      return { title: "Authentication required", code: "UNAUTHENTICATED" };
    }
    return auth;
  })
  .get("/metrics", async () => new Response(await renderMetrics(), { headers: { "content-type": "text/plain; version=0.0.4" } }))
  .post("/v1/caller/sessions", ({ body, set }) => {
    const service = readAllowed(body.service, ["shelter", "respite"] as const);
    const language = readAllowed(body.language, ["en", "hi", "hinglish"] as const);
    if (!service || !language) { set.status = 400; return { code: "INVALID_DEMO_OPTION" }; }
    if (body.dialedNumber !== config.DEMO_DIAL_CODE) {
      set.status = 400;
      return { code: "NOT_DEMO_LINE", message: "This browser dialpad connects only to the Doot demo line." };
    }
    const session = createVoiceSession({
      callSid: `browser_${randomUUID()}`,
      channel: "browser",
      service,
      language,
      ttlMs: 30 * 60_000
    });
    return {
      sessionToken: session.token,
      sessionUrl: `${config.VOICE_RUNTIME_PUBLIC_WS_URL}/v1/browser/stream/${session.token}`,
      expiresAt: session.expiresAt,
      voiceMode: config.VOICE_PROVIDER_MODE,
      providerMode: config.COMMUNICATION_MODE === "live" ? "live" : "fixture"
    };
  }, { body: t.Object({ dialedNumber: t.String(), service: t.String(), language: t.String() }) })
  .get("/v1/caller/sessions/:sessionToken", async ({ params, set }) => {
    const session = getVoiceSession(params.sessionToken);
    if (!session || session.channel !== "browser") {
      set.status = 404;
      return { code: "CALL_SESSION_NOT_FOUND" };
    }
    const current = session.caseId ? await store.getCase(session.caseId) : null;
    return {
      case: current ? redactCaseSecrets(current) : null,
      calls: current ? await projectProviderCalls(current) : [],
      service: session.service,
      expiresAt: session.expiresAt
    };
  })
  .post("/v1/caller/sessions/:sessionToken/decision", async ({ params, body, set }) => {
    const session = getVoiceSession(params.sessionToken);
    if (!session || session.channel !== "browser" || !session.caseId) {
      set.status = 404;
      return { accepted: false, code: "CALL_SESSION_NOT_FOUND" };
    }
    const current = await store.getCase(session.caseId);
    if (!current || current.callerChannel !== "browser" || current.state !== "awaiting_decision" ||
        body.caseVersion !== (current.decisionVersion ?? current.version) ||
        !current.holds.some((hold) => hold.id === body.selectedHoldId && hold.status === "active" && Date.parse(hold.expiresAt) > Date.now())) {
      set.status = 409;
      return { accepted: false, code: "DECISION_NOT_AVAILABLE" };
    }
    const signalled = await temporal.signalDecision(current.workflowId, {
      caseId: current.id,
      caseVersion: body.caseVersion,
      selectedHoldId: body.selectedHoldId,
      actor: "caller",
      verification: "browser_session"
    });
    if (!signalled) { set.status = 503; return { accepted: false, code: "WORKFLOW_UNAVAILABLE" }; }
    return { accepted: signalled };
  }, { body: t.Object({ caseVersion: t.Number(), selectedHoldId: t.String() }) })
  .post(
    "/v1/privacy/redact-telemetry",
    ({ body }) => ({ attributes: redactTelemetryAttributes(body.attributes) }),
    { body: t.Object({ attributes: t.Record(t.String(), t.Any()) }) }
  )
  .get(
    "/v1/telephony/exotel/resolve",
    ({ query }) => {
      const language = readAllowed(query.language ?? "hinglish", ["en", "hi", "hinglish"] as const) ?? "hinglish";
      const session = createVoiceSession({
        callSid: query.callSid,
        language,
        ...(query.callerPhoneBlindIndex ? { callerPhoneBlindIndex: query.callerPhoneBlindIndex } : {})
      });
      const sessionUrl = `${config.VOICE_RUNTIME_WS_URL}/v1/telephony/exotel/stream/${session.token}?language=${session.language}`;
      return {
        callSid: session.callSid,
        sessionToken: session.token,
        sessionUrl,
        expiresAt: session.expiresAt
      };
    },
    {
      query: t.Object({
        callSid: t.String(),
        language: t.Optional(t.String()),
        callerPhoneBlindIndex: t.Optional(t.String())
      })
    }
  )
  .get("/v1/internal/telephony/sessions/:sessionToken", ({ headers, params, set }) => {
    if (!requireServiceToken(headers, set)) return { title: "Invalid service credential", code: "UNAUTHORIZED_SERVICE" };
    const session = getVoiceSession(params.sessionToken);
    if (!session) {
      set.status = 404;
      return { title: "Voice session not found or expired", code: "VOICE_SESSION_NOT_FOUND" };
    }
    return session;
  })
  .get("/v1/internal/demo-cases/:caseCode", async ({ headers, params, set }) => {
    if (!requireServiceToken(headers, set)) return { code: "UNAUTHORIZED_SERVICE" };
    const matches = (await store.listCases()).filter((item) => item.callerChannel === "browser" && demoCaseCode(item.id) === params.caseCode);
    if (matches.length !== 1) { set.status = 404; return { code: "DEMO_CASE_NOT_FOUND" }; }
    return { caseId: matches[0]!.id, needSummary: matches[0]!.needSummary };
  })
  .post("/v1/internal/provider-transcripts", async ({ headers, body, set }) => {
    if (!requireServiceToken(headers, set)) return { code: "UNAUTHORIZED_SERVICE" };
    const current = (await store.listCases()).find((item) => item.id === body.caseId && demoCaseCode(item.id) === body.caseCode);
    if (!current || !["provider_lotus", "provider_ashraya"].includes(body.providerId) || !["hold", "release"].includes(body.kind) || body.turns.length > 40 ||
        body.turns.some((turn) => turn.speaker !== "Doot" && turn.speaker !== "Provider")) {
      set.status = 400; return { code: "INVALID_PROVIDER_TRANSCRIPT" };
    }
    const safeTurns = body.turns.map((turn) => ({ speaker: turn.speaker, text: turn.text.slice(0, 1200) }));
    const artifact = await archive.put({
      id: `artifact_${randomUUID()}`, caseId: current.id, artifactType: "transcript",
      body: Buffer.from(JSON.stringify({ source: "provider_answerer", providerId: body.providerId, streamSid: body.streamSid, turns: safeTurns })),
      contentType: "application/json"
    });
    await store.putArtifact(artifact);
    await store.mutateCase(current.id, null, (activeCase) => ({
      case: { ...activeCase, version: activeCase.version + 1, providerTranscriptArtifacts: { ...activeCase.providerTranscriptArtifacts, [`${body.providerId}:${body.kind}`]: artifact.id } },
      result: null
    }));
    set.status = 201;
    return { artifactId: artifact.id };
  }, { body: t.Object({ caseId: t.String(), caseCode: t.String(), providerId: t.String(), streamSid: t.String(), kind: t.String(), turns: t.Array(t.Object({ speaker: t.String(), text: t.String() })) }) })
  .post("/v1/internal/cases/:caseId/artifacts", async ({ headers, body, params, set }) => {
    if (!requireServiceToken(headers, set)) return { title: "Invalid service credential", code: "UNAUTHORIZED_SERVICE" };
    const activeCase = await store.getCase(params.caseId);
    if (!activeCase) {
      set.status = 404;
      return { title: "Case not found", code: "CASE_NOT_FOUND" };
    }
    const artifactType = readAllowed(body.artifactType, ["recording", "transcript", "consent_segment", "evidence", "audit_export"] as const);
    if (!artifactType) {
      set.status = 400;
      return { title: "Invalid artifact type", code: "INVALID_ARTIFACT_TYPE" };
    }
    const artifact = await archive.put({
      id: `artifact_${randomUUID()}`,
      caseId: activeCase.id,
      artifactType,
      body: Buffer.from(body.contentBase64, "base64"),
      contentType: body.contentType
    });
    await store.putArtifact(artifact);
    set.status = 201;
    return { artifact };
  }, {
    body: t.Object({ artifactType: t.String(), contentBase64: t.String(), contentType: t.String() })
  })
  .post("/v1/webhooks/exotel/status", async ({ body, headers, set }) => {
    const eventId = String(headers["x-exotel-event-id"] ?? randomUUID());
    const accepted = await store.acceptWebhook({ source: "exotel", externalEventId: eventId, payload: body });
    set.status = 202;
    return { accepted: accepted.accepted, duplicate: accepted.entry.duplicate, source: "exotel", eventId, inboxId: accepted.entry.id };
  })
  .post("/v1/webhooks/call-e", async ({ body, headers, set }) => {
    if (!validWebhookCredential(headers.authorization, config.CALL_E_WEBHOOK_SECRET)) {
      set.status = 401;
      return { accepted: false, source: "call-e", code: "INVALID_WEBHOOK_CREDENTIAL" };
    }
    const eventId = String(headers["call-e-event-id"] ?? randomUUID());
    const bodyId = extractBodyId(body);
    if (bodyId && bodyId !== eventId) {
      set.status = 400;
      return { accepted: false, source: "call-e", eventId, code: "CALL_E_EVENT_ID_MISMATCH", refetchRequired: true };
    }
    const accepted = await store.acceptWebhook({ source: "call-e", externalEventId: eventId, payload: body });
    set.status = 202;
    return {
      accepted: accepted.accepted,
      duplicate: accepted.entry.duplicate,
      source: "call-e",
      eventId,
      inboxId: accepted.entry.id,
      refetchRequired: true
    };
  })
  .post(
    "/v1/internal/cases/:caseId/provider-goals",
    async ({ body, headers, params, set }) => {
      if (!requireServiceToken(headers, set)) return { title: "Invalid service credential", code: "UNAUTHORIZED_SERVICE" };
      const provider = demoProviders.find((item) => item.id === body.providerId);
      if (!provider) {
        set.status = 404;
        return { title: "Provider not found", code: "PROVIDER_NOT_FOUND" };
      }
      try {
        return await store.mutateCase(params.caseId, null, (activeCase) => {
          const nextCase: DootCase = {
            ...activeCase,
            version: activeCase.version + 1,
            state: "searching",
            timeline: activeCase.timeline.some((item) => item.id === `evt_provider_requested_${provider.id}`)
              ? activeCase.timeline
              : [...activeCase.timeline, event(`evt_provider_requested_${provider.id}`, new Date(), "Provider goal requested", `${provider.name} was queued with a stable idempotency key.`, "provider")]
          };
          const command = buildProviderHoldGoalCommand(nextCase, provider);
          return { case: nextCase, commands: [command], result: { command } };
        });
      } catch (error) { return handleStoreConflict(error, set); }
    },
    { body: t.Object({ providerId: t.String() }) }
  )
  .post(
    "/v1/internal/cases/:caseId/provider-results",
    async ({ body, headers, params, set }) => {
      if (!requireServiceToken(headers, set)) return { title: "Invalid service credential", code: "UNAUTHORIZED_SERVICE" };
      const parsed = ProviderCallResultSchema.safeParse(body);
      if (!parsed.success || parsed.data.caseId !== params.caseId) {
        set.status = 400;
        return { title: "Invalid provider result", code: "INVALID_PROVIDER_RESULT" };
      }
      try {
        return await store.mutateCase(params.caseId, null, (activeCase) => {
          if (activeCase.attempts.some((item) => item.externalCallId === parsed.data.externalCallId)) {
            return { case: activeCase, result: { duplicate: true, case: activeCase } };
          }
          const normalized = normalizeProviderResult(parsed.data);
          const provider = demoProviders.find((item) => item.id === normalized.providerId);
          const attempt: ProviderAttempt = {
            id: `attempt_${idempotencyKey([normalized.caseId, normalized.providerId, normalized.externalCallId])}`,
            caseId: normalized.caseId,
            providerId: normalized.providerId,
            providerName: provider?.name ?? normalized.providerId,
            externalCallId: normalized.externalCallId,
            outcome: normalized.outcome,
            eligibilityStatus: normalized.eligibility.status,
            evidenceSummary: normalized.evidenceSummary,
            confidence: normalized.confidence,
            durationSeconds: 0
          };
          const hold: Hold | null = normalized.hold ? {
            id: `hold_${idempotencyKey([normalized.caseId, normalized.providerId, normalized.hold.reference])}`,
            caseId: normalized.caseId,
            providerId: normalized.providerId,
            reference: normalized.hold.reference,
            expiresAt: normalized.hold.expiresAt,
            status: activeCase.state === "safety_handoff" ? "release_pending" : "active",
            constraints: normalized.hold.constraints
          } : null;
          const nextCase: DootCase = {
            ...activeCase,
            version: activeCase.version + 1,
            state: activeCase.state === "safety_handoff"
              ? "safety_handoff"
              : hold || activeCase.holds.some((item) => item.status === "active") ? "awaiting_decision" : "validating",
            attempts: [...activeCase.attempts, attempt],
            holds: hold ? [...activeCase.holds, hold] : activeCase.holds,
            timeline: [...activeCase.timeline, event(`evt_provider_result_${attempt.id}`, new Date(), "Provider result recorded", `${attempt.providerName} returned ${attempt.outcome}.`, "provider")]
          };
          const commands = hold?.status === "release_pending" ? [buildReleaseHoldCommand(nextCase, hold)] : [];
          return { case: nextCase, commands, result: { duplicate: false, case: nextCase } };
        });
      } catch (error) { return handleStoreConflict(error, set); }
    },
    { body: t.Any() }
  )
  .post("/v1/internal/cases/:caseId/callback", async ({ headers, params, set }) => {
    if (!requireServiceToken(headers, set)) return { title: "Invalid service credential", code: "UNAUTHORIZED_SERVICE" };
    try {
      return await store.mutateCase(params.caseId, null, (activeCase) => {
        if (activeCase.state === "safety_handoff") return { case: activeCase, result: activeCase };
        if (activeCase.mode === "planning") {
          const nextCase: DootCase = {
            ...activeCase,
            version: activeCase.version + 1,
            state: "resolved",
            smsReceiptQueued: activeCase.callerChannel !== "browser",
            timeline: [...activeCase.timeline, event(`evt_planning_complete_${activeCase.version + 1}`, new Date(), "Planning options ready", activeCase.callerChannel === "browser" ? "Non-binding provider availability is ready in the browser." : "Non-binding provider availability was gathered and an SMS summary was queued.", "commit")]
          };
          return { case: nextCase, commands: activeCase.callerChannel === "browser" ? [] : [buildComparisonSmsCommand(nextCase)], result: nextCase };
        }
        const hasActiveHold = activeCase.holds.some((hold) => hold.status === "active" && new Date(hold.expiresAt).getTime() > Date.now());
        const nextCase: DootCase = {
          ...activeCase,
          version: activeCase.version + 1,
          decisionVersion: activeCase.version + 1,
          state: hasActiveHold ? "awaiting_decision" : "no_options",
          timeline: [...activeCase.timeline, event(`evt_callback_${activeCase.version + 1}`, new Date(), hasActiveHold ? activeCase.callerChannel === "browser" ? "Options ready in browser" : "Caller callback queued" : "No viable options", hasActiveHold ? "No more than three active holds will be presented." : "Provider search completed without a valid active hold.", "decision")]
        };
        return { case: nextCase, commands: hasActiveHold && activeCase.callerChannel !== "browser" ? [buildCallerDecisionCallbackCommand(nextCase)] : [], result: nextCase };
      });
    } catch (error) { return handleStoreConflict(error, set); }
  })
  .post("/v1/internal/cases/:caseId/expire", async ({ headers, params, set }) => {
    if (!requireServiceToken(headers, set)) return { title: "Invalid service credential", code: "UNAUTHORIZED_SERVICE" };
    try {
      return await store.mutateCase(params.caseId, null, (activeCase) => {
        const nextCase: DootCase = {
          ...activeCase,
          version: activeCase.version + 1,
          state: "expired",
          holds: activeCase.holds.map((hold): Hold => hold.status === "active" ? { ...hold, status: "expired" } : hold),
          timeline: [...activeCase.timeline, event(`evt_workflow_expired_${activeCase.version + 1}`, new Date(), "Workflow deadline expired", "No decision was committed before the durable deadline.", "commit")]
        };
        return { case: nextCase, result: nextCase };
      });
    } catch (error) { return handleStoreConflict(error, set); }
  })
  .post(
    "/v1/internal/cases/:caseId/holds/:holdId/expire",
    async ({ headers, params, set }) => {
      if (!requireServiceToken(headers, set)) return { title: "Invalid service credential", code: "UNAUTHORIZED_SERVICE" };
      try {
        return await store.mutateCase(params.caseId, null, (activeCase) => {
          const nextCase = markHoldExpired(activeCase, params.holdId);
          return { case: nextCase, result: nextCase };
        });
      } catch (error) { return handleStoreConflict(error, set); }
    }
  )
  .post("/v1/internal/cases/:caseId/safety-handoff", async ({ headers, params, set }) => {
    if (!requireServiceToken(headers, set)) return { title: "Invalid service credential", code: "UNAUTHORIZED_SERVICE" };
    try {
      const result = await store.mutateCase(params.caseId, null, (activeCase) => {
        if (activeCase.state === "safety_handoff") return { case: activeCase, result: activeCase };
        const holds = activeCase.holds.map((hold): Hold => hold.status === "active" || hold.status === "commit_pending"
          ? { ...hold, status: "release_pending" }
          : hold);
        const nextCase: DootCase = {
          ...activeCase,
          version: activeCase.version + 1,
          state: "safety_handoff",
          holds,
          safety: { ...activeCase.safety, midCallEscalation: true },
          timeline: [...activeCase.timeline, event(`evt_safety_handoff_${activeCase.version + 1}`, new Date(), "Safety handoff invoked", activeCase.safety.handoffScript, "safety")]
        };
        const commands = holds
          .filter((hold) => hold.status === "release_pending" && activeCase.holds.find((item) => item.id === hold.id)?.status !== "release_pending")
          .map((hold) => buildReleaseHoldCommand(nextCase, hold));
        return { case: nextCase, commands, result: nextCase };
      });
      const signalled = await temporal.signalSafetyHandoff(result.workflowId).catch(() => false);
      return { case: redactCaseSecrets(result), signalled };
    } catch (error) {
      return handleStoreConflict(error, set);
    }
  })
  .post(
    "/v1/cases",
    async ({ body, headers, set }) => {
      const intakeSession = body.sessionToken ? getVoiceSession(body.sessionToken) : null;
      if (body.sessionToken && (!intakeSession || intakeSession.callerPhoneBlindIndex !== body.callerPhoneBlindIndex)) {
        set.status = 401;
        return { title: "Invalid voice session", code: "INVALID_VOICE_SESSION" };
      }
      if (!body.consentAccepted) {
        set.status = 400;
        return { title: "Consent is required before intake", code: "CONSENT_REQUIRED" };
      }
      const requestedFor = readAllowed(body.requestedFor ?? "unknown", ["self", "someone_else", "unknown"] as const);
      const languageHint = readAllowed(body.languageHint ?? "hinglish", ["en", "hi", "hinglish"] as const);
      if (!requestedFor || !languageHint) {
        set.status = 400;
        return { title: "Invalid intake option", code: "INVALID_INTAKE_OPTION" };
      }
      const classification = classifyIntake({
        callerPhoneBlindIndex: body.callerPhoneBlindIndex,
        utterance: body.utterance,
        requestedFor,
        languageHint,
        existingReference: body.existingReference,
        location: body.location,
        service: intakeSession?.service ?? body.service,
        accessibilityNeeds: body.accessibilityNeeds,
        requestedTimeframe: body.requestedTimeframe
      });
      const selectedProviders = classification.safetyEscalation ? [] : selectProviders(demoProviders, {
        mode: classification.mode,
        location: body.location ?? "indiranagar",
        service: intakeSession?.service ?? body.service ?? "shelter",
        accessibilityNeeds: body.accessibilityNeeds,
        language: classification.language,
        limit: 3
      });
      const now = new Date();
      const { requestId, traceId } = correlationFromHeaders(headers);
      if (classification.mode === "existing") {
        const existingCase = (await store.listCases()).find((item) =>
          item.callerPhoneBlindIndex === body.callerPhoneBlindIndex && item.existingReference === body.existingReference);
        if (!existingCase) {
          set.status = 404;
          return { title: "Existing case verification failed", code: "EXISTING_CASE_NOT_FOUND" };
        }
        const verified = await store.mutateCase(existingCase.id, null, (activeCase) => {
          const nextCase: DootCase = {
            ...activeCase,
            version: activeCase.version + 1,
            callerVerifiedAt: now.toISOString(),
            timeline: [...activeCase.timeline, event(`evt_existing_verified_${activeCase.version + 1}`, now, "Returning caller verified", "Stored phone blind index and spoken reference matched before case access.", "audit")]
          };
          return { case: nextCase, result: nextCase };
        });
        await archiveIntakeArtifacts(verified, body.utterance, classification.disclosureScript, body.recordingAccepted);
        set.status = 200;
        return {
          case: redactCaseSecrets(verified),
          classification,
          selectedProviders: [],
          workflow: { started: false, resumed: true, workflowId: verified.workflowId }
        };
      }
      const caseId = `case_${randomUUID()}`;
      const activeCase: DootCase = {
        id: caseId,
        version: 0,
        callerChannel: intakeSession?.channel ?? "phone",
        mode: classification.mode,
        state: classification.safetyEscalation ? "safety_handoff" : "safety_screened",
        callerLabel: body.callerLabel ?? "Authenticated caller",
        callerPhoneBlindIndex: body.callerPhoneBlindIndex,
        existingReference: body.existingReference,
        callerVerifiedAt: now.toISOString(),
        needSummary: body.utterance,
        language: classification.language,
        createdAt: now.toISOString(),
        callbackDeadlineAt: new Date(now.getTime() + (classification.mode === "planning" ? 24 * 60 : 5) * 60_000).toISOString(),
        traceId,
        requestId,
        workflowId: `case-${caseId}`,
        safety: {
          initialScreenClear: !classification.safetyEscalation,
          midCallEscalation: false,
          handoffScript: classification.handoffScript ?? "If this becomes life-threatening, call 112 or 108 now."
        },
        attempts: [],
        holds: [],
        timeline: [
          event(`evt_consent_${caseId}`, now, "Disclosure and consent recorded", `${classification.disclosureScript} Recording consent: ${body.recordingAccepted ? "accepted" : "declined"}.`, "intake"),
          event(`evt_safety_${caseId}`, now, classification.safetyEscalation ? "Safety handoff invoked" : "Safety screen clear", classification.safetyEscalation ? classification.handoffScript ?? "Emergency handoff required." : "Ordinary coordination may continue.", "safety")
        ],
        smsReceiptQueued: false,
        confirmationCallScheduled: false
      };
      await store.createCase(activeCase);
      if (intakeSession) bindVoiceSessionCase(intakeSession.token, activeCase.id);
      await archiveIntakeArtifacts(activeCase, body.utterance, classification.disclosureScript, body.recordingAccepted);
      const workflow = classification.safetyEscalation
        ? { started: false, workflowId: activeCase.workflowId }
        : await temporal.startCase(activeCase, selectedProviders.map((provider) => provider.id));
      set.status = 201;
      return { case: redactCaseSecrets(activeCase), classification, selectedProviders, workflow };
    },
    {
      body: t.Object({
        callerPhoneBlindIndex: t.String(),
        callerLabel: t.Optional(t.String()),
        utterance: t.String(),
        consentAccepted: t.Boolean(),
        recordingAccepted: t.Boolean(),
        requestedFor: t.Optional(t.String()),
        languageHint: t.Optional(t.String()),
        existingReference: t.Optional(t.String()),
        location: t.Optional(t.String()),
        service: t.Optional(t.String()),
        accessibilityNeeds: t.Array(t.String()),
        requestedTimeframe: t.Optional(t.String()),
        sessionToken: t.Optional(t.String())
      })
    }
  )
  .post("/v1/internal/workflows/:workflowId/provider-result", async ({ body, headers, params, set }) => {
    if (!requireServiceToken(headers, set)) return { signalled: false, code: "UNAUTHORIZED_SERVICE" };
    const result = ProviderCallResultSchema.safeParse(body);
    if (!result.success) {
      set.status = 400;
      return { signalled: false, code: "INVALID_PROVIDER_RESULT" };
    }
    return { signalled: await temporal.signalProviderResult(params.workflowId, result.data) };
  }, { body: t.Any() })
  .post("/v1/internal/workflows/:workflowId/release-result", async ({ body, headers, params, set }) => {
    if (!requireServiceToken(headers, set)) return { signalled: false, code: "UNAUTHORIZED_SERVICE" };
    return { signalled: await temporal.signalReleaseResult(params.workflowId, { holdId: body.holdId, succeeded: body.succeeded }) };
  }, { body: t.Object({ holdId: t.String(), succeeded: t.Boolean() }) })
  .post("/v1/internal/workflows/:workflowId/decision", async ({ body, headers, params, set }) => {
    if (!requireServiceToken(headers, set)) return { signalled: false, code: "UNAUTHORIZED_SERVICE" };
    const actor = readAllowed(body.actor, ["caller", "operator"] as const);
    const verification = readAllowed(body.verification, ["phone_match_and_reference", "browser_session", "operator_override"] as const);
    if (!actor || !verification) {
      set.status = 400;
      return { signalled: false, code: "INVALID_DECISION_OPTION" };
    }
    return { signalled: await temporal.signalDecision(params.workflowId, {
      caseId: body.caseId,
      caseVersion: body.caseVersion,
      selectedHoldId: body.selectedHoldId,
      actor,
      verification
    }) };
  }, { body: t.Object({ caseId: t.String(), caseVersion: t.Number(), selectedHoldId: t.String(), actor: t.String(), verification: t.String() }) })
  .post("/v1/internal/inbox/:entryId/processed", async ({ headers, params, set }) => {
    if (!requireServiceToken(headers, set)) return { processed: false, code: "UNAUTHORIZED_SERVICE" };
    const entry = await store.markInboxProcessed(params.entryId);
    if (!entry) {
      set.status = 404;
      return { processed: false, code: "INBOX_ENTRY_NOT_FOUND" };
    }
    return { processed: true, entry };
  })
  .get("/v1/ops/cases", async ({ headers, set }) => {
    const denied = requireRole(await authFromHeaders(headers), ["operator", "supervisor", "developer", "auditor"], set);
    if (denied) return denied;
    const cases = await store.listCases();
    return { cases: cases.map(redactCaseSecrets), metrics: outcomeMetrics(cases) };
  })
  .get("/v1/ops/cases/:caseId/provider-calls", async ({ headers, params, set }) => {
    const denied = requireRole(await authFromHeaders(headers), ["operator", "supervisor", "developer", "auditor"], set);
    if (denied) return denied;
    const current = await store.getCase(params.caseId);
    if (!current) {
      set.status = 404;
      return { code: "CASE_NOT_FOUND" };
    }
    return { calls: await projectProviderCalls(current, true) };
  })
  .post("/v1/ops/cases/:caseId/call-e-rehearsal", async ({ headers, body, params, set }) => {
    const auth = await authFromHeaders(headers);
    const denied = requireRole(auth, ["operator", "supervisor"], set);
    if (denied) return denied;
    if (!rehearsalConfigured(config)) { set.status = 503; return { code: "REHEARSAL_NOT_CONFIGURED" }; }
    const current = await store.getCase(params.caseId);
    if (!current) { set.status = 404; return { code: "CASE_NOT_FOUND" }; }
    if (!current.safety.initialScreenClear || current.safety.midCallEscalation) {
      set.status = 409;
      return { code: "SAFETY_HANDOFF_ACTIVE" };
    }
    const now = new Date().toISOString();
    const record = await store.createRehearsal({
      caseId: current.id, idempotencyKey: `doot_rehearsal_${idempotencyKey([current.id, "v1"])}`,
      actorSubject: auth!.subject, service: body.service, callId: null, status: "pending", availability: null,
      caseCodeConfirmed: null, answered: false, caseCodeSpoken: false, taskCompleted: null, transcriptArtifactId: null,
      errorCode: null, createdAt: now, updatedAt: now, completedAt: null
    });
    if (record.service !== body.service) { set.status = 409; return { code: "REHEARSAL_SERVICE_LOCKED" }; }
    if (!record.callId && record.status === "pending") {
      try {
        const callId = await createRehearsalCall(config, record, demoCaseCode(current.id));
        const updated: RehearsalRecord = { ...record, callId, status: "queued", updatedAt: new Date().toISOString() };
        await store.updateRehearsal(updated);
        set.status = 202;
        return publicRehearsal(updated);
      } catch {
        set.status = 502;
        return { code: "CALL_E_CREATE_UNCONFIRMED", message: "The result is unknown. Retry uses the same idempotency key." };
      }
    }
    return publicRehearsal(record);
  }, { body: t.Object({ confirmed: t.Literal(true), service: t.Union([t.Literal("shelter"), t.Literal("respite")]) }) })
  .get("/v1/ops/cases/:caseId/call-e-rehearsal", async ({ headers, params, set }) => {
    const denied = requireRole(await authFromHeaders(headers), ["operator", "supervisor", "developer", "auditor"], set);
    if (denied) return denied;
    if (!(await store.getCase(params.caseId))) { set.status = 404; return { code: "CASE_NOT_FOUND" }; }
    const record = await store.getRehearsal(params.caseId);
    if (!record) return { configured: rehearsalConfigured(config), rehearsal: null };
    if (!record.callId || record.status === "failed" || record.status === "canceled" || (record.status === "completed" && record.transcriptArtifactId)) {
      return { configured: rehearsalConfigured(config), rehearsal: publicRehearsal(record) };
    }
    try {
      const result = await readRehearsalCall(config, record.callId);
      let transcriptArtifactId = record.transcriptArtifactId;
      if (result.turns.length && !transcriptArtifactId && result.status === "completed") {
        const artifact = await archive.put({
          id: `artifact_rehearsal_${idempotencyKey([record.caseId, record.callId])}`, caseId: record.caseId,
          artifactType: "transcript", body: Buffer.from(JSON.stringify({ source: "call-e", turns: result.turns })), contentType: "application/json"
        });
        await store.putArtifact(artifact);
        transcriptArtifactId = artifact.id;
      }
      const updated: RehearsalRecord = {
        ...record, status: result.status, availability: result.availability, caseCodeConfirmed: result.caseCodeConfirmed,
        answered: result.answered, caseCodeSpoken: caseCodeSpoken(result.turns, demoCaseCode(record.caseId)), taskCompleted: result.taskCompleted, transcriptArtifactId,
        errorCode: result.errorCode, completedAt: result.completedAt, updatedAt: new Date().toISOString()
      };
      await store.updateRehearsal(updated);
      return { configured: rehearsalConfigured(config), rehearsal: publicRehearsal(updated) };
    } catch {
      set.status = 502;
      return { code: "CALL_E_REFRESH_FAILED", rehearsal: publicRehearsal(record) };
    }
  })
  .get("/v1/ops/cases/:caseId/call-e-rehearsal/transcript", async ({ headers, params, set }) => {
    const auth = await authFromHeaders(headers);
    const denied = requireRole(auth, ["operator", "supervisor", "auditor"], set);
    if (denied) return denied;
    const record = await store.getRehearsal(params.caseId);
    const artifact = record?.transcriptArtifactId
      ? (await store.listArtifacts()).find((item) => item.id === record.transcriptArtifactId && item.caseId === params.caseId)
      : null;
    if (!artifact) { set.status = 404; return { code: "REHEARSAL_TRANSCRIPT_NOT_FOUND" }; }
    await store.recordAuditAccess({
      id: `audit_access_${randomUUID()}`, artifactId: artifact.id, actorSubject: auth!.subject,
      actorRole: auth!.role, reason: "call_e_rehearsal_proof", allowed: true, occurredAt: new Date().toISOString()
    });
    const archived = JSON.parse(Buffer.from(await archive.get(artifact)).toString("utf8")) as { turns: RehearsalTurn[] };
    return { source: "call-e", label: "CALL-E transcript of authorized human rehearsal", turns: archived.turns.slice(0, 12).map((turn) => ({ ...turn, text: turn.text.slice(0, 1200) })) };
  })
  .get("/v1/ops/cases/:caseId/provider-transcripts/:providerId", async ({ headers, params, query, set }) => {
    const auth = await authFromHeaders(headers);
    const denied = requireRole(auth, ["operator", "supervisor", "auditor"], set);
    if (denied) return denied;
    const current = await store.getCase(params.caseId);
    const kind = readAllowed(query.kind ?? "hold", ["hold", "release"] as const);
    if (!kind) { set.status = 400; return { code: "INVALID_TRANSCRIPT_KIND" }; }
    const artifactId = current?.providerTranscriptArtifacts?.[`${params.providerId}:${kind}`];
    const artifact = artifactId ? (await store.listArtifacts()).find((item) => item.id === artifactId && item.caseId === current?.id) : null;
    if (!artifact || !auth) { set.status = 404; return { code: "PROVIDER_TRANSCRIPT_NOT_FOUND" }; }
    await store.recordAuditAccess({
      id: `audit_access_${randomUUID()}`, artifactId: artifact.id,
      actorSubject: auth.subject, actorRole: auth.role,
      reason: "provider_side_transcript_proof", allowed: true, occurredAt: new Date().toISOString()
    });
    const content = JSON.parse(Buffer.from(await archive.get(artifact)).toString("utf8")) as { source: string; providerId: string; turns: Array<{ speaker: string; text: string }> };
    return { artifactId: artifact.id, source: "provider_answerer", providerId: params.providerId, turns: content.turns.slice(0, 12) };
  })
  .get("/v1/ops/inbox", async ({ headers, set }) => {
    const denied = requireRole(await authFromHeaders(headers), ["operator", "developer", "supervisor"], set);
    if (denied) return denied;
    return { entries: await store.listInbox() };
  })
  .get("/v1/ops/outbox", async ({ headers, set }) => {
    const denied = requireRole(await authFromHeaders(headers), ["operator", "developer", "supervisor"], set);
    if (denied) return denied;
    return { items: await store.listOutbox() };
  })
  .post("/v1/ops/outbox/lease", async ({ headers, set }) => {
    const denied = requireRole(await authFromHeaders(headers), ["operator", "developer"], set);
    if (denied) return denied;
    return { item: await store.leaseOutbox() };
  })
  .post(
    "/v1/ops/outbox/:itemId/attempt-result",
    async ({ headers, body, params, set }) => {
      const denied = requireRole(await authFromHeaders(headers), ["operator", "developer"], set);
      if (denied) return denied;
      const item = (await store.listOutbox()).find((entry) => entry.id === params.itemId);
      if (!item) {
        set.status = 404;
        return { title: "Outbox item not found", code: "OUTBOX_ITEM_NOT_FOUND" };
      }
      const status = readAllowed(body.status, ["pending", "sent", "failed", "dead_lettered"] as const);
      if (!status) {
        set.status = 400;
        return { title: "Invalid outbox status", code: "INVALID_OUTBOX_STATUS" };
      }
      return { item: await store.recordOutboxAttempt(params.itemId, {
        status,
        ...(body.error ? { error: body.error } : {}),
        ...(body.externalRef ? { externalRef: body.externalRef } : {}),
        ...(body.countAttempt === false ? { countAttempt: false } : {}),
        ...(body.adapterResponse !== undefined ? { adapterResponse: body.adapterResponse } : {})
      }) };
    },
    {
      body: t.Object({
        status: t.String(),
        error: t.Optional(t.String()),
        externalRef: t.Optional(t.String()),
        countAttempt: t.Optional(t.Boolean()),
        adapterResponse: t.Optional(t.Any())
      })
    }
  )
  .get("/v1/providers", () => ({ providers: demoProviders }))
  .get("/v1/audit/artifacts", async ({ headers, set }) => {
    const denied = requireRole(await authFromHeaders(headers), ["operator", "auditor", "supervisor"], set);
    if (denied) return denied;
    return { artifacts: await store.listArtifacts() };
  })
  .get("/v1/audit/access-events", async ({ headers, set }) => {
    const denied = requireRole(await authFromHeaders(headers), ["auditor", "supervisor"], set);
    if (denied) return denied;
    return { events: await store.listAuditAccess() };
  })
  .post(
    "/v1/audit/artifacts/:artifactId/access",
    async ({ headers, body, params, set }) => {
      const denied = requireRole(await authFromHeaders(headers), ["auditor"], set);
      if (denied) return denied;
      const artifact = (await store.listArtifacts()).find((item) => item.id === params.artifactId);
      if (!artifact) {
        set.status = 404;
        return { title: "Artifact not found", code: "ARTIFACT_NOT_FOUND" };
      }
      const auth = await authFromHeaders(headers);
      if (!auth) {
        set.status = 401;
        return { title: "Authentication required", code: "UNAUTHENTICATED" };
      }
      const decision = decideAuditAccess({
        artifactId: params.artifactId,
        actorRole: auth.role,
        reason: body.reason
      });
      await store.recordAuditAccess({
        id: `audit_access_${randomUUID()}`,
        artifactId: artifact.id,
        actorSubject: auth.subject,
        actorRole: auth.role,
        reason: body.reason,
        allowed: decision.allowed,
        occurredAt: new Date().toISOString()
      });
      const content = decision.allowed ? await archive.get(artifact) : null;
      return { artifactId: artifact.id, ...decision, contentBase64: content ? Buffer.from(content).toString("base64") : null };
    },
    {
      body: t.Object({
        reason: t.String()
      })
    }
  )
  .post("/v1/audit/deletion-jobs/run", async ({ headers, set }) => {
    const denied = requireRole(await authFromHeaders(headers), ["auditor", "admin"], set);
    if (denied) return denied;
    const auditArtifacts: AuditArtifact[] = [];
    for (const artifact of await store.listArtifacts()) {
      const planned = planArtifactDeletion(artifact);
      if (planned.deletionStatus === "delete_scheduled") {
        await archive.delete(planned);
        auditArtifacts.push(markArtifactDeleted(planned));
      } else {
        auditArtifacts.push(planned);
      }
    }
    await store.replaceArtifacts(auditArtifacts);
    const deletedCaseIds = new Set(auditArtifacts.filter((artifact) => artifact.deletionStatus === "deleted").map((artifact) => artifact.caseId));
    for (const caseId of deletedCaseIds) {
      const caseArtifacts = auditArtifacts.filter((artifact) => artifact.caseId === caseId);
      if (caseArtifacts.length > 0 && caseArtifacts.every((artifact) => artifact.deletionStatus === "deleted")) await archive.destroyCaseKey(caseId);
    }
    return { artifacts: auditArtifacts };
  })
  .post(
    "/v1/intake/classify",
    ({ body, set }) => {
      const requestedFor = body.requestedFor
        ? readAllowed(body.requestedFor, ["self", "someone_else", "unknown"] as const)
        : "unknown";
      const languageHint = body.languageHint ? readAllowed(body.languageHint, ["en", "hi", "hinglish"] as const) : "hinglish";
      if (!requestedFor || !languageHint) {
        set.status = 400;
        return { title: "Invalid intake option", code: "INVALID_INTAKE_OPTION" };
      }
      const classification = classifyIntake({
        callerPhoneBlindIndex: body.callerPhoneBlindIndex,
        utterance: body.utterance,
        requestedFor,
        languageHint,
        existingReference: body.existingReference,
        location: body.location,
        service: body.service,
        accessibilityNeeds: body.accessibilityNeeds,
        requestedTimeframe: body.requestedTimeframe
      });
      const selectedProviders = classification.safetyEscalation
        ? []
        : selectProviders(demoProviders, {
            mode: classification.mode,
            location: body.location ?? "indiranagar",
            service: body.service ?? "shelter",
            accessibilityNeeds: body.accessibilityNeeds,
            language: classification.language,
            limit: 3
          });
      return { classification, selectedProviders };
    },
    {
      body: t.Object({
        callerPhoneBlindIndex: t.String(),
        utterance: t.String(),
        requestedFor: t.Optional(t.String()),
        languageHint: t.Optional(t.String()),
        existingReference: t.Optional(t.String()),
        location: t.Optional(t.String()),
        service: t.Optional(t.String()),
        accessibilityNeeds: t.Array(t.String()),
        requestedTimeframe: t.Optional(t.String())
      })
    }
  )
  .post(
    "/v1/ops/cases/:caseId/actions/verify-existing",
    async ({ headers, body, params, set }) => {
      const denied = requireRole(await authFromHeaders(headers), ["operator", "supervisor"], set);
      if (denied) return denied;
      try {
        type VerificationResult =
          | { verified: false; code: "EXISTING_CASE_MISMATCH" }
          | { verified: true; case: DootCase };
        const result = await store.mutateCase<VerificationResult>(params.caseId, null, (activeCase) => {
          const verified = activeCase.mode === "existing" && verifyExistingCaller({
            expectedPhoneBlindIndex: activeCase.callerPhoneBlindIndex ?? "",
            suppliedPhoneBlindIndex: body.suppliedPhoneBlindIndex,
            expectedReference: activeCase.existingReference ?? "",
            suppliedReference: body.suppliedReference
          });
          if (!verified) {
            return { case: activeCase, result: { verified: false, code: "EXISTING_CASE_MISMATCH" } };
          }
          const nextCase: DootCase = {
            ...activeCase,
            version: activeCase.version + 1,
            callerVerifiedAt: new Date().toISOString(),
            timeline: [
              ...activeCase.timeline,
              event(
                `evt_verified_${activeCase.version + 1}`,
                new Date(),
                "Existing caller verified",
                "Phone blind index and spoken reference matched before case modification.",
                "audit"
              )
            ]
          };
          return { case: nextCase, result: { verified: true, case: redactCaseSecrets(nextCase) } };
        });
        if (!result.verified) set.status = 403;
        return result;
      } catch (error) {
        return handleStoreConflict(error, set);
      }
    },
    {
      body: t.Object({
        suppliedPhoneBlindIndex: t.String(),
        suppliedReference: t.String()
      })
    }
  )
  .post(
    "/v1/providers/:providerId/reliability/project",
    ({ body, params, set }) => {
      const provider = demoProviders.find((item) => item.id === params.providerId);
      if (!provider) {
        set.status = 404;
        return { title: "Provider not found", code: "PROVIDER_NOT_FOUND" };
      }
      const recordedOutcome = readAllowed(body.recordedOutcome, ["honoured", "orphaned", "no_answer"] as const);
      if (!recordedOutcome) {
        set.status = 400;
        return { title: "Invalid recorded outcome", code: "INVALID_RECORDED_OUTCOME" };
      }
      return projectReliability(provider, recordedOutcome);
    },
    { body: t.Object({ recordedOutcome: t.String() }) }
  )
  .get("/v1/ops/cases/:caseId", async ({ headers, params, set }) => {
    const denied = requireRole(await authFromHeaders(headers), ["operator", "supervisor", "developer", "auditor"], set);
    if (denied) return denied;
    const activeCase = await store.getCase(params.caseId);
    if (!activeCase) {
      set.status = 404;
      return { title: "Case not found", code: "CASE_NOT_FOUND" };
    }
    return redactCaseSecrets(activeCase);
  })
  .get("/v1/ops/cases/:caseId/events", async ({ headers, params, set }) => {
    const denied = requireRole(await authFromHeaders(headers), ["operator", "supervisor", "developer", "auditor"], set);
    if (denied) return denied;
    const activeCase = await store.getCase(params.caseId);
    if (!activeCase) {
      set.status = 404;
      return { events: [] };
    }
    return { events: activeCase.timeline };
  })
  .get("/v1/ops/events", async ({ headers, set }) => {
    const denied = requireRole(await authFromHeaders(headers), ["operator", "supervisor", "developer", "auditor"], set);
    if (denied) return denied;
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    return new Response(
      new ReadableStream({
        async start(controller) {
          const push = async () => {
            const cases = (await store.listCases()).map(redactCaseSecrets);
            controller.enqueue(encoder.encode(`event: case.snapshot\ndata: ${JSON.stringify(cases)}\n\n`));
          };
          try {
            await push();
            timer = setInterval(() => {
              void push().catch(() => {
                if (timer) clearInterval(timer);
                try { controller.close(); } catch { /* already closed */ }
              });
            }, 2_000);
          } catch {
            controller.close();
          }
        },
        cancel() {
          if (timer) clearInterval(timer);
        }
      }),
      {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive"
        }
      }
    );
  })
  .post(
    "/v1/ops/cases/:caseId/actions/decide",
    async ({ headers, body, params, set }) => {
      const denied = requireRole(await authFromHeaders(headers), ["operator", "supervisor"], set);
      if (denied) return denied;
      const actor = readAllowed(body.actor, ["caller", "operator"] as const);
      const verification = readAllowed(body.verification, ["phone_match_and_reference", "browser_session", "operator_override"] as const);
      if (!actor || !verification) {
        set.status = 400;
        return { title: "Invalid decision option", code: "INVALID_DECISION_OPTION" };
      }
      let result: ReturnType<typeof applyDecision>;
      try {
        result = await store.mutateCase<ReturnType<typeof applyDecision>>(params.caseId, null, (activeCase) => {
          const signal = {
            caseId: params.caseId,
            caseVersion: body.caseVersion,
            selectedHoldId: body.selectedHoldId,
            actor,
            verification
          };
          const rawDecision = applyDecision(activeCase, signal);
          const decision = rawDecision.ok && activeCase.callerChannel === "browser"
            ? { ...rawDecision, case: { ...rawDecision.case, smsReceiptQueued: false } }
            : rawDecision;
          const commands = decision.ok
            ? [
                ...decision.releasedHoldIds.flatMap((holdId) => {
                  const hold = decision.case.holds.find((item) => item.id === holdId);
                  return hold ? [buildReleaseHoldCommand(decision.case, hold)] : [];
                }),
                ...(decision.case.callerChannel === "browser" ? [] : [buildComparisonSmsCommand(decision.case)])
              ]
            : [];
          return decision.ok
            ? { case: decision.case, commands, decision: signal, result: decision }
            : { case: decision.case, commands, result: decision };
        });
      } catch (error) {
        return handleStoreConflict(error, set);
      }
      if (!result.ok) {
        set.status = 409;
        return result;
      }
      return result.ok ? { ...result, case: redactCaseSecrets(result.case) } : result;
    },
    {
      body: t.Object({
        caseVersion: t.Number(),
        selectedHoldId: t.String(),
        actor: t.String(),
        verification: t.String()
      })
    }
  )
  .post("/v1/ops/cases/:caseId/actions/pause", async ({ headers, params, set }) => {
    const denied = requireRole(await authFromHeaders(headers), ["operator", "supervisor"], set);
    if (denied) return denied;
    try {
      const result = await store.mutateCase(params.caseId, null, (activeCase) => {
        const nextCase: DootCase = {
          ...activeCase,
          version: activeCase.version + 1,
          state: "manual_review",
          timeline: [...activeCase.timeline, event(`evt_pause_${activeCase.version + 1}`, new Date(), "Case paused", "Operator paused orchestration for manual review.", "diagnostic")]
        };
        return { case: nextCase, result: nextCase };
      });
      return redactCaseSecrets(result);
    } catch (error) { return handleStoreConflict(error, set); }
  })
  .post("/v1/ops/cases/:caseId/actions/resume", async ({ headers, params, set }) => {
    const denied = requireRole(await authFromHeaders(headers), ["operator", "supervisor"], set);
    if (denied) return denied;
    try {
      const result = await store.mutateCase(params.caseId, null, (activeCase) => {
        const nextCase: DootCase = {
          ...activeCase,
          version: activeCase.version + 1,
          state: activeCase.holds.some((hold) => hold.status === "release_pending") ? "releasing" : "awaiting_decision",
          timeline: [...activeCase.timeline, event(`evt_resume_${activeCase.version + 1}`, new Date(), "Case resumed", "Operator resumed ordinary orchestration.", "diagnostic")]
        };
        return { case: nextCase, result: nextCase };
      });
      return redactCaseSecrets(result);
    } catch (error) { return handleStoreConflict(error, set); }
  })
  .post("/v1/ops/cases/:caseId/actions/force-release", async ({ headers, params, set }) => {
    const denied = requireRole(await authFromHeaders(headers), ["operator", "supervisor"], set);
    if (denied) return denied;
    const existing = await store.getCase(params.caseId);
    if (!existing) {
      set.status = 404;
      return { title: "Case not found", code: "CASE_NOT_FOUND" };
    }
    if (existing.mode === "existing" && !existing.callerVerifiedAt) {
      set.status = 409;
      return { ok: false, code: "EXISTING_CASE_UNVERIFIED", message: "Verify phone and reference before force-release.", case: redactCaseSecrets(existing) };
    }
    try {
      const result = await store.mutateCase(params.caseId, null, (activeCase) => {
        const holds = activeCase.holds.map((hold): Hold => hold.status === "active" || hold.status === "release_pending" ? { ...hold, status: "release_pending" } : hold);
        const nextCase: DootCase = {
          ...activeCase,
          version: activeCase.version + 1,
          state: "releasing",
          holds,
          timeline: [...activeCase.timeline, event(`evt_force_release_${activeCase.version + 1}`, new Date(), "Force release queued", "Operator requested release for every uncommitted active hold.", "release")]
        };
        const commands = holds.filter((hold) => hold.status === "release_pending").map((hold) => buildReleaseHoldCommand(nextCase, hold));
        return { case: nextCase, commands, result: nextCase };
      });
      return redactCaseSecrets(result);
    } catch (error) { return handleStoreConflict(error, set); }
  })
  .post(
    "/v1/ops/cases/:caseId/actions/release-result",
    async ({ headers, body, params, set }) => {
      const denied = requireRole(await authFromHeaders(headers), ["operator", "supervisor"], set);
      if (denied) return denied;
      try {
        const result = await store.mutateCase(params.caseId, null, (activeCase) => {
          const nextCase = confirmRelease(activeCase, body.holdId, body.succeeded);
          const commands = nextCase.state === "resolved" && nextCase.confirmationCallScheduled && nextCase.callerChannel !== "browser"
            ? [buildPostCommitConfirmationCommand(nextCase)]
            : [];
          return { case: nextCase, commands, result: nextCase };
        });
        return redactCaseSecrets(result);
      } catch (error) { return handleStoreConflict(error, set); }
    },
    { body: t.Object({ holdId: t.String(), succeeded: t.Boolean() }) }
  )
  .get("/v1/diagnostics/cases/:caseId/bundle", async ({ headers, params, query, set }) => {
    const auth = await authFromHeaders(headers);
    if (!auth) {
      set.status = 401;
      return { title: "Authentication required", code: "UNAUTHENTICATED" };
    }
    const includeSensitive = query.includeSensitive === "true";
    if (includeSensitive) {
      const denied = requireRole(auth, ["auditor"], set);
      if (denied) return denied;
      if (!query.reason || query.reason.trim().length < 8) {
        set.status = 400;
        return { title: "Auditor access reason required", code: "AUDIT_REASON_REQUIRED" };
      }
    } else {
      const denied = requireRole(auth, ["operator", "developer", "supervisor"], set);
      if (denied) return denied;
    }
    const activeCase = await store.getCase(params.caseId);
    if (!activeCase) {
      set.status = 404;
      return { title: "Case not found", code: "CASE_NOT_FOUND" };
    }
    const workflowStatus = await temporal.queryStatus(activeCase.workflowId).catch(() => null);
    const diagnostics = buildDiagnostics(activeCase, {
      workflowStatus: workflowStatus ? JSON.stringify(workflowStatus) : null,
      includeSensitive
    });
    if (!includeSensitive) return diagnostics;
    const artifacts = (await store.listArtifacts()).filter((artifact) => artifact.caseId === activeCase.id);
    for (const artifact of artifacts) {
      await store.recordAuditAccess({
        id: `audit_access_${randomUUID()}`,
        artifactId: artifact.id,
        actorSubject: auth.subject,
        actorRole: auth.role,
        reason: query.reason!,
        allowed: true,
        occurredAt: new Date().toISOString()
      });
    }
    const sensitiveArtifacts = artifacts.map((artifact) => ({
      id: artifact.id,
      artifactType: artifact.artifactType,
      encryptedObjectUri: artifact.encryptedObjectUri,
      retentionUntil: artifact.retentionUntil,
      accessReason: query.reason!
    }));
    while (Buffer.byteLength(JSON.stringify({ ...diagnostics, sensitiveArtifacts }), "utf8") > 16 * 1024) sensitiveArtifacts.pop();
    return {
      ...diagnostics,
      truncated: diagnostics.truncated || sensitiveArtifacts.length < artifacts.length,
      sensitiveArtifacts
    };
  }, {
    query: t.Object({
      mode: t.Optional(t.String()),
      includeSensitive: t.Optional(t.String()),
      reason: t.Optional(t.String())
    })
  })
  .post("/v1/demo/reset", async ({ headers, set }) => {
    const denied = requireRole(await authFromHeaders(headers), ["operator", "developer"], set);
    if (denied) return denied;
    const cases = await store.reset();
    await seedDemoArchive();
    return { cases, metrics: outcomeMetrics(cases) };
  })
  .listen(Number(process.env.PORT ?? 4000));

console.log(`Doot control API listening on http://localhost:${app.server?.port}`);

async function authFromHeaders(headers: Record<string, string | undefined>): Promise<AuthContext | null> {
  if (config.AUTH_MODE === "demo") {
    return createDemoAuthContext({
      role: typeof headers["x-doot-role"] === "string" ? headers["x-doot-role"] : null,
      subject: typeof headers["x-doot-subject"] === "string" ? headers["x-doot-subject"] : null
    });
  }
  const authorization = headers.authorization;
  const cookieToken = headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("doot_access_token="))?.slice("doot_access_token=".length);
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : cookieToken;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, oidcKeys, { issuer: config.OIDC_ISSUER, audience: config.OIDC_CLIENT_ID });
    const realmRoles = readStringArray((payload.realm_access as Record<string, unknown> | undefined)?.roles);
    const clientRoles = readStringArray((payload.resource_access as Record<string, Record<string, unknown>> | undefined)?.[config.OIDC_CLIENT_ID]?.roles);
    const role = [...clientRoles, ...realmRoles].map((value) => readAllowed(value, ["operator", "supervisor", "developer", "auditor", "admin"] as const)).find(Boolean);
    if (!payload.sub || !role) return null;
    return { subject: payload.sub, role, authMode: "oidc" };
  } catch {
    return null;
  }
}

function correlationFromHeaders(headers: Record<string, string | undefined>) {
  return {
    requestId: headers["x-request-id"] ?? `req_${randomUUID()}`,
    traceId: headers.traceparent?.split("-")[1] ?? randomUUID().replaceAll("-", "")
  };
}

function requireRole(auth: AuthContext | null, allowed: readonly AccessRole[], set: { status?: number | string }) {
  if (!auth) {
    set.status = 401;
    return { title: "Authentication required", code: "UNAUTHENTICATED" };
  }
  if (isAuthorized(auth, allowed)) return null;
  set.status = 403;
  return authorizationProblem(auth, allowed);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function requireServiceToken(headers: Record<string, string | undefined>, set: { status?: number | string }) {
  const authorization = headers.authorization;
  const allowed = authorization === `Bearer ${config.INTERNAL_SERVICE_TOKEN}`;
  if (!allowed) set.status = 401;
  return allowed;
}

function redactCaseSecrets(current: DootCase): DootCase {
  const { callerPhoneBlindIndex: _phone, existingReference: _reference, providerTranscriptArtifacts: _providerTranscripts, ...visible } = current;
  return visible;
}

async function projectProviderCalls(current: DootCase, includeTranscript = false) {
  const outbox = await store.listOutbox();
  return outbox
    .filter((item) => item.caseId === current.id && (item.command.kind === "provider_hold_goal" || item.command.kind === "release_hold_goal"))
    .map((item) => {
      const response = typeof item.adapterResponse === "object" && item.adapterResponse !== null
        ? item.adapterResponse as Record<string, unknown> : {};
      const status = readAllowed(String(response.status ?? ""), ["queued", "in_progress", "completed", "failed", "canceled"] as const)
        ?? (item.status === "dead_lettered" ? "failed" : "queued");
      const attempt = current.attempts.find((entry) => entry.providerId === item.command.target.providerId);
      return {
        id: item.id,
        providerId: item.command.target.providerId,
        providerName: demoProviders.find((provider) => provider.id === item.command.target.providerId)?.name ?? "Provider",
        kind: item.command.kind,
        source: item.externalRef?.startsWith("mock_") || (!item.externalRef && config.COMMUNICATION_MODE === "mock") ? "fixture" : "call_e",
        status,
        goalRunId: item.externalRef?.startsWith("mock_") ? null : item.externalRef,
        callId: typeof response.call_id === "string" ? response.call_id : null,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        outcome: attempt?.outcome ?? null,
        evidenceSummary: attempt?.evidenceSummary ?? null,
        holdReference: item.command.target.holdReference ?? null,
        transcriptArtifactId: includeTranscript ? current.providerTranscriptArtifacts?.[`${item.command.target.providerId ?? ""}:${item.command.kind === "release_hold_goal" ? "release" : "hold"}`] ?? null : null,
        error: item.status === "dead_lettered" ? item.lastError : null
      };
    });
}

function validWebhookCredential(authorization: string | undefined, secret: string) {
  if (!secret) return config.NODE_ENV !== "production";
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(authorization ?? "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function extractBodyId(body: unknown) {
  if (!body || typeof body !== "object" || !("id" in body)) return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

function readAllowed<const T extends readonly string[]>(value: string, allowed: T): T[number] | null {
  return allowed.includes(value) ? value : null;
}

async function archiveIntakeArtifacts(current: DootCase, utterance: string, disclosure: string, recordingAccepted: boolean) {
  const values: Array<{ artifactType: AuditArtifact["artifactType"]; body: string; contentType: string }> = [
    { artifactType: "consent_segment", body: JSON.stringify({ disclosure, recordingAccepted, capturedAt: new Date().toISOString() }), contentType: "application/json" },
    { artifactType: "transcript", body: JSON.stringify({ turns: [{ speaker: "caller", text: utterance }] }), contentType: "application/json" }
  ];
  for (const value of values) {
    const artifact = await archive.put({
      id: `artifact_${randomUUID()}`,
      caseId: current.id,
      artifactType: value.artifactType,
      body: Buffer.from(value.body),
      contentType: value.contentType
    });
    await store.putArtifact(artifact);
  }
}

async function seedDemoArchive() {
  const cases = await store.listCases();
  for (const artifact of await store.listArtifacts()) {
    const current = cases.find((item) => item.id === artifact.caseId);
    const body = artifact.artifactType === "consent_segment"
      ? JSON.stringify({ fixture: true, disclosureRecorded: true, caseId: artifact.caseId })
      : JSON.stringify({ fixture: true, summary: current?.needSummary ?? "Demo artifact" });
    const persisted = await archive.put({
      id: artifact.id,
      caseId: artifact.caseId,
      artifactType: artifact.artifactType,
      body: Buffer.from(body),
      contentType: "application/json",
      now: new Date(artifact.createdAt)
    });
    await store.putArtifact(persisted);
  }
}

async function renderMetrics() {
  const [cases, webhookInbox, outbox, auditArtifacts] = await Promise.all([
    store.listCases(),
    store.listInbox(),
    store.listOutbox(),
    store.listArtifacts()
  ]);
  const metrics = outcomeMetrics(cases);
  const now = Date.now();
  const releasePending = cases.flatMap((item) => item.holds).filter((hold) => hold.status === "release_pending").length;
  const releaseFailures = cases.flatMap((item) => item.holds).filter((hold) => hold.status === "release_failed").length;
  const callbackDeadlineBreaches = cases.filter(
    (item) => item.state !== "resolved" && new Date(item.callbackDeadlineAt).getTime() < now
  ).length;
  const safetyHandoffs = cases.filter((item) => !item.safety.initialScreenClear || item.safety.midCallEscalation).length;
  const unprocessedWebhookCount = webhookInbox.filter((entry) => !entry.processedAt).length;
  const pendingOutboxCount = outbox.filter((item) => item.status === "pending").length;
  const archiveFailures = auditArtifacts.filter((artifact) => artifact.deletionStatus === "legal_hold_blocked").length;
  const dependencyAvailable = {
    deepgram: config.DEEPGRAM_API_KEY.length > 0 ? 1 : 0,
    elevenlabs: config.ELEVENLABS_API_KEY.length > 0 ? 1 : 0,
    "call-e": config.CALL_E_API_KEY.length > 0 ? 1 : 0,
    exotel: config.EXOTEL_API_TOKEN.length > 0 && config.EXOTEL_ACCOUNT_SID.length > 0 ? 1 : 0
  };
  return [
    "# HELP doot_cases_total Total demo cases in the operations queue.",
    "# TYPE doot_cases_total gauge",
    `doot_cases_total ${metrics.totalCases}`,
    "# HELP doot_cases_resolved_total Resolved demo cases.",
    "# TYPE doot_cases_resolved_total gauge",
    `doot_cases_resolved_total ${metrics.resolved}`,
    "# HELP doot_cases_resolved_before_expiry_total Cases resolved before committed hold expiry.",
    "# TYPE doot_cases_resolved_before_expiry_total gauge",
    `doot_cases_resolved_before_expiry_total ${metrics.eligibleResolvedBeforeExpiry}`,
    "# HELP doot_orphan_hold_rate Fraction of cases with failed release debt.",
    "# TYPE doot_orphan_hold_rate gauge",
    `doot_orphan_hold_rate ${metrics.orphanHoldRate}`,
    "# HELP doot_human_override_rate Fraction of cases requiring operator override.",
    "# TYPE doot_human_override_rate gauge",
    `doot_human_override_rate ${metrics.humanOverrideRate}`,
    "# HELP doot_callback_deadline_breaches_total Cases whose caller callback deadline passed before resolution.",
    "# TYPE doot_callback_deadline_breaches_total gauge",
    `doot_callback_deadline_breaches_total ${callbackDeadlineBreaches}`,
    "# HELP doot_release_pending_holds Holds waiting for explicit provider release confirmation.",
    "# TYPE doot_release_pending_holds gauge",
    `doot_release_pending_holds ${releasePending}`,
    "# HELP doot_release_failures_total Holds whose release confirmation failed.",
    "# TYPE doot_release_failures_total gauge",
    `doot_release_failures_total ${releaseFailures}`,
    "# HELP doot_webhook_inbox_unprocessed Webhook events accepted but not marked processed.",
    "# TYPE doot_webhook_inbox_unprocessed gauge",
    `doot_webhook_inbox_unprocessed ${unprocessedWebhookCount}`,
    "# HELP doot_outbox_pending Pending outbound communication commands.",
    "# TYPE doot_outbox_pending gauge",
    `doot_outbox_pending ${pendingOutboxCount}`,
    "# HELP doot_archive_failures_total Audit archive operations requiring operator attention.",
    "# TYPE doot_archive_failures_total gauge",
    `doot_archive_failures_total ${archiveFailures}`,
    "# HELP doot_safety_handoffs_total Cases routed to safety handoff.",
    "# TYPE doot_safety_handoffs_total gauge",
    `doot_safety_handoffs_total ${safetyHandoffs}`,
    "# HELP doot_voice_dependency_available Whether a configured voice or telephony dependency is available.",
    "# TYPE doot_voice_dependency_available gauge",
    ...Object.entries(dependencyAvailable).map(([dependency, available]) => `doot_voice_dependency_available{dependency="${dependency}"} ${available}`),
    ""
  ].join("\n");
}

function handleStoreConflict(error: unknown, set: { status?: number | string }) {
  if (error instanceof StoreConflictError) {
    set.status = error.code === "CASE_NOT_FOUND" ? 404 : 409;
    return { title: error.message, code: error.code };
  }
  throw error;
}

function publicRehearsal(record: RehearsalRecord) {
  return {
    caseId: record.caseId, service: record.service, callId: record.callId, status: record.status,
    availability: record.availability, caseCodeConfirmed: record.caseCodeConfirmed,
    answered: record.answered, caseCodeSpoken: record.caseCodeSpoken, taskCompleted: record.taskCompleted,
    verifiedConversation: record.status === "completed" && record.answered && record.caseCodeSpoken && record.taskCompleted === true && record.caseCodeConfirmed === "yes",
    transcriptAvailable: Boolean(record.transcriptArtifactId), errorCode: record.errorCode,
    createdAt: record.createdAt, updatedAt: record.updatedAt, completedAt: record.completedAt
  };
}
