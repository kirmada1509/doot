import { z } from "zod";

export const caseModes = ["urgent", "planning", "existing"] as const;
export const caseStates = [
  "intake",
  "safety_screened",
  "searching",
  "validating",
  "awaiting_decision",
  "committing",
  "releasing",
  "resolved",
  "safety_handoff",
  "no_options",
  "expired",
  "manual_review",
  "failed"
] as const;
export const providerOutcomes = [
  "hold_secured",
  "availability_only",
  "unavailable",
  "ineligible",
  "no_answer",
  "failed",
  "unknown"
] as const;

export const CaseModeSchema = z.enum(caseModes);
export const CaseStateSchema = z.enum(caseStates);
export const ProviderOutcomeSchema = z.enum(providerOutcomes);
export const accessRoles = ["operator", "supervisor", "developer", "auditor", "admin"] as const;
export const AccessRoleSchema = z.enum(accessRoles);

export type CaseMode = z.infer<typeof CaseModeSchema>;
export type CaseState = z.infer<typeof CaseStateSchema>;
export type ProviderOutcome = z.infer<typeof ProviderOutcomeSchema>;
export type AccessRole = z.infer<typeof AccessRoleSchema>;

export const AuthContextSchema = z.object({
  subject: z.string(),
  role: AccessRoleSchema,
  authMode: z.enum(["demo-header", "oidc"])
});

export type AuthContext = z.infer<typeof AuthContextSchema>;

export const IntakeRequestSchema = z.object({
  callerPhoneBlindIndex: z.string(),
  utterance: z.string(),
  requestedFor: z.enum(["self", "someone_else", "unknown"]).default("unknown"),
  languageHint: z.enum(["en", "hi", "hinglish"]).default("hinglish"),
  existingReference: z.string().optional(),
  location: z.string().optional(),
  service: z.string().optional(),
  accessibilityNeeds: z.array(z.string()).default([]),
  requestedTimeframe: z.string().optional()
});

export type IntakeRequest = z.infer<typeof IntakeRequestSchema>;

export const IntakeClassificationSchema = z.object({
  mode: CaseModeSchema,
  safetyEscalation: z.boolean(),
  language: z.enum(["en", "hi", "hinglish"]),
  reason: z.string(),
  disclosureScript: z.string(),
  handoffScript: z.string().nullable()
});

export type IntakeClassification = z.infer<typeof IntakeClassificationSchema>;

export const ProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  serviceTags: z.array(z.string()),
  locationTags: z.array(z.string()),
  accessibilityTags: z.array(z.string()),
  languages: z.array(z.enum(["en", "hi", "hinglish"])),
  acceptsHolds: z.boolean(),
  active: z.boolean(),
  reliability: z.object({
    answeredCallRate: z.number().min(0).max(1),
    holdHonourRate: z.number().min(0).max(1),
    orphanHoldRate: z.number().min(0).max(1),
    averageResponseSeconds: z.number().nonnegative()
  })
});

export type Provider = z.infer<typeof ProviderSchema>;

export const ProviderSelectionCriteriaSchema = z.object({
  mode: CaseModeSchema,
  location: z.string(),
  service: z.string(),
  accessibilityNeeds: z.array(z.string()),
  language: z.enum(["en", "hi", "hinglish"]),
  limit: z.number().int().positive().max(10).default(3)
});

export type ProviderSelectionCriteria = z.infer<typeof ProviderSelectionCriteriaSchema>;

export const CallerVerificationSchema = z.object({
  expectedPhoneBlindIndex: z.string(),
  suppliedPhoneBlindIndex: z.string(),
  expectedReference: z.string(),
  suppliedReference: z.string()
});

export type CallerVerification = z.infer<typeof CallerVerificationSchema>;

export const ProblemSchema = z.object({
  type: z.string().url(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  code: z.string(),
  requestId: z.string(),
  traceId: z.string(),
  retryable: z.boolean()
});

export const ProviderCallResultSchema = z.object({
  caseId: z.string(),
  providerId: z.string(),
  externalCallId: z.string(),
  outcome: ProviderOutcomeSchema,
  eligibility: z.object({
    status: z.enum(["eligible", "ineligible", "unknown"]),
    criteria: z.array(z.string())
  }),
  hold: z
    .object({
      reference: z.string().min(1),
      expiresAt: z.string().datetime(),
      constraints: z.array(z.string())
    })
    .nullable(),
  evidenceSummary: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  transcriptArtifactId: z.string().optional()
});

export type ProviderCallResult = z.infer<typeof ProviderCallResultSchema>;

export const DecisionSignalSchema = z.object({
  caseId: z.string(),
  caseVersion: z.number().int().nonnegative(),
  selectedHoldId: z.string(),
  actor: z.enum(["caller", "operator"]),
  verification: z.enum(["phone_match_and_reference", "browser_session", "operator_override"])
});

export type DecisionSignal = z.infer<typeof DecisionSignalSchema>;

export const HoldSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  providerId: z.string(),
  reference: z.string(),
  expiresAt: z.string().datetime(),
  status: z.enum(["active", "commit_pending", "committed", "release_pending", "released", "release_failed", "expired"]),
  constraints: z.array(z.string())
});

export type Hold = z.infer<typeof HoldSchema>;

export const ProviderAttemptSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  providerId: z.string(),
  providerName: z.string(),
  externalCallId: z.string(),
  outcome: ProviderOutcomeSchema,
  eligibilityStatus: z.enum(["eligible", "ineligible", "unknown"]),
  evidenceSummary: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  durationSeconds: z.number().int().nonnegative()
});

export type ProviderAttempt = z.infer<typeof ProviderAttemptSchema>;

export const TimelineEventSchema = z.object({
  id: z.string(),
  at: z.string().datetime(),
  title: z.string(),
  detail: z.string(),
  kind: z.enum(["intake", "safety", "provider", "decision", "commit", "release", "diagnostic", "audit"])
});

export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

export const DootCaseSchema = z.object({
  id: z.string(),
  version: z.number().int().nonnegative(),
  decisionVersion: z.number().int().nonnegative().optional(),
  callerChannel: z.enum(["browser", "phone"]).optional(),
  providerTranscriptArtifacts: z.record(z.string()).optional(),
  mode: CaseModeSchema,
  state: CaseStateSchema,
  callerLabel: z.string(),
  callerPhoneBlindIndex: z.string().optional(),
  existingReference: z.string().optional(),
  callerVerifiedAt: z.string().datetime().nullable().optional(),
  needSummary: z.string(),
  language: z.enum(["en", "hi", "hinglish"]),
  createdAt: z.string().datetime(),
  callbackDeadlineAt: z.string().datetime(),
  traceId: z.string(),
  requestId: z.string(),
  workflowId: z.string(),
  safety: z.object({
    initialScreenClear: z.boolean(),
    midCallEscalation: z.boolean(),
    handoffScript: z.string()
  }),
  attempts: z.array(ProviderAttemptSchema),
  holds: z.array(HoldSchema),
  timeline: z.array(TimelineEventSchema),
  smsReceiptQueued: z.boolean(),
  confirmationCallScheduled: z.boolean()
});

export type DootCase = z.infer<typeof DootCaseSchema>;

export const CompactDiagnosticsSchema = z.object({
  caseId: z.string(),
  caseState: CaseStateSchema,
  caseVersion: z.number().int(),
  activeDeadlines: z.array(z.object({ label: z.string(), at: z.string().datetime() })),
  latestEvents: z.array(TimelineEventSchema),
  providerAttemptSummary: z.array(z.string()),
  workflowStatus: z.string(),
  firstRelevantError: z.string().nullable(),
  links: z.object({
    trace: z.string(),
    logs: z.string(),
    metrics: z.string()
  }),
  nextChecks: z.array(z.string()),
  byteSize: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
  includeSensitive: z.boolean().optional(),
  sensitiveArtifacts: z.array(z.object({
    id: z.string(),
    artifactType: z.string(),
    encryptedObjectUri: z.string(),
    retentionUntil: z.string().datetime(),
    accessReason: z.string()
  })).optional()
});

export type CompactDiagnostics = z.infer<typeof CompactDiagnosticsSchema>;

export const ProviderReliabilityProjectionSchema = z.object({
  providerId: z.string(),
  answeredCallRate: z.number().min(0).max(1),
  holdHonourRate: z.number().min(0).max(1),
  orphanHoldRate: z.number().min(0).max(1),
  averageResponseSeconds: z.number().nonnegative(),
  score: z.number().min(0).max(1)
});

export type ProviderReliabilityProjection = z.infer<typeof ProviderReliabilityProjectionSchema>;

export const AuditArtifactSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  artifactType: z.enum(["recording", "transcript", "consent_segment", "evidence", "audit_export"]),
  encryptedObjectUri: z.string(),
  retentionUntil: z.string().datetime(),
  legalHold: z.boolean(),
  deletionStatus: z.enum(["retained", "delete_scheduled", "deleted", "legal_hold_blocked"]),
  createdAt: z.string().datetime()
});

export type AuditArtifact = z.infer<typeof AuditArtifactSchema>;

export const AuditAccessRequestSchema = z.object({
  artifactId: z.string(),
  actorRole: AccessRoleSchema,
  reason: z.string().min(8)
});

export type AuditAccessRequest = z.infer<typeof AuditAccessRequestSchema>;

export const AuditAccessDecisionSchema = z.object({
  allowed: z.boolean(),
  reason: z.string(),
  immutableEventTitle: z.string()
});

export type AuditAccessDecision = z.infer<typeof AuditAccessDecisionSchema>;

export const EnvelopeEncryptionResultSchema = z.object({
  caseId: z.string(),
  keyId: z.string(),
  ciphertext: z.string(),
  blindIndex: z.string()
});

export type EnvelopeEncryptionResult = z.infer<typeof EnvelopeEncryptionResultSchema>;

export const WorkflowLedgerEventSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  at: z.string().datetime(),
  type: z.enum([
    "case.started",
    "provider.goal_requested",
    "provider.result_recorded",
    "caller.callback_requested",
    "decision.received",
    "hold.release_requested",
    "hold.release_confirmed",
    "confirmation.requested",
    "workflow.completed",
    "workflow.manual_review"
  ]),
  idempotencyKey: z.string(),
  summary: z.string()
});

export type WorkflowLedgerEvent = z.infer<typeof WorkflowLedgerEventSchema>;

export const WorkflowRunResultSchema = z.object({
  caseId: z.string(),
  workflowId: z.string(),
  state: CaseStateSchema,
  ledger: z.array(WorkflowLedgerEventSchema),
  activeHoldCount: z.number().int().nonnegative(),
  releaseDebtCount: z.number().int().nonnegative()
});

export type WorkflowRunResult = z.infer<typeof WorkflowRunResultSchema>;

export const communicationCommandKinds = [
  "provider_hold_goal",
  "caller_decision_callback",
  "release_hold_goal",
  "post_commit_confirmation",
  "comparison_sms"
] as const;

export const communicationChannels = ["call_e_goal_run", "call_e_call", "exotel_sms"] as const;

export const CommunicationCommandKindSchema = z.enum(communicationCommandKinds);
export const CommunicationChannelSchema = z.enum(communicationChannels);

export type CommunicationCommandKind = z.infer<typeof CommunicationCommandKindSchema>;
export type CommunicationChannel = z.infer<typeof CommunicationChannelSchema>;

export const CommunicationCommandSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  kind: CommunicationCommandKindSchema,
  channel: CommunicationChannelSchema,
  idempotencyKey: z.string(),
  traceId: z.string(),
  requestId: z.string(),
  workflowId: z.string(),
  language: z.enum(["en", "hi", "hinglish"]),
  target: z.object({
    providerId: z.string().optional(),
    holdId: z.string().optional(),
    holdReference: z.string().optional(),
    callerPhoneBlindIndex: z.string().optional()
  }),
  goal: z.object({
    name: z.string(),
    objective: z.string(),
    script: z.string(),
    input: z.record(z.string())
  }),
  metadata: z.object({
    caseId: z.string(),
    workflowId: z.string(),
    traceId: z.string(),
    requestId: z.string(),
    attemptId: z.string().optional(),
    holdId: z.string().optional()
  })
});

export type CommunicationCommand = z.infer<typeof CommunicationCommandSchema>;

export const CalleProviderGoalResultSchema = z.object({
  case_id: z.string(),
  provider_id: z.string(),
  external_call_id: z.string(),
  outcome: ProviderOutcomeSchema,
  eligibility_status: z.enum(["eligible", "ineligible", "unknown"]),
  eligibility_criteria: z.array(z.string()),
  hold_reference: z.string(),
  hold_expires_at: z.string(),
  hold_constraints: z.array(z.string()),
  evidence_summary: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  transcript_artifact_id: z.string()
});

export type CalleProviderGoalResult = z.infer<typeof CalleProviderGoalResultSchema>;

export const WebhookInboxEntrySchema = z.object({
  id: z.string(),
  source: z.enum(["exotel", "call-e"]),
  externalEventId: z.string(),
  receivedAt: z.string().datetime(),
  processedAt: z.string().datetime().nullable(),
  duplicate: z.boolean(),
  payload: z.unknown()
});

export type WebhookInboxEntry = z.infer<typeof WebhookInboxEntrySchema>;

export const OutboxItemSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  command: CommunicationCommandSchema,
  status: z.enum(["pending", "leased", "sent", "failed", "dead_lettered"]),
  attempts: z.number().int().nonnegative(),
  leaseUntil: z.string().datetime().nullable(),
  externalRef: z.string().nullable(),
  adapterResponse: z.unknown().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastError: z.string().nullable()
});

export type OutboxItem = z.infer<typeof OutboxItemSchema>;
