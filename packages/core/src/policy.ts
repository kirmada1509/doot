import type {
  CallerVerification,
  CaseMode,
  IntakeClassification,
  IntakeRequest,
  Provider,
  ProviderReliabilityProjection,
  ProviderSelectionCriteria
} from "@doot/contracts";

type ReliabilityMetrics = {
  answeredCallRate: number;
  holdHonourRate: number;
  orphanHoldRate: number;
  averageResponseSeconds: number;
};

const urgentTerms = ["tonight", "now", "today", "urgent", "abhi", "aaj", "within hours"];
const planningTerms = ["next week", "planning", "exploring", "later", "kal", "agle hafte"];
const safetyTerms = ["life-threatening", "not breathing", "heart attack", "suicide", "kill myself", "unsafe right now", "jaan khatra"];

export const disclosureScripts = {
  en: "Hi, I am Doot, an AI coordination agent. I can record this call to find options, keep the record for 365 days, and you can ask for deletion later. If this is life-threatening, call 112 or 108 now.",
  hi: "Namaste, main Doot hoon, ek AI coordination agent. Main options dhoondhne ke liye call record kar sakta hoon, record 365 din tak rakha ja sakta hai, aur aap baad mein deletion maang sakte hain. Agar jaan ko khatra hai, abhi 112 ya 108 par call kijiye.",
  hinglish: "Hi, main Doot hoon, ek AI coordination agent. Main options dhoondhne ke liye call record kar sakta hoon, record 365 days tak rakha ja sakta hai, aur aap deletion maang sakte hain. Agar life-threatening emergency hai, abhi 112 ya 108 call kijiye."
} as const;

export const emergencyHandoffScript =
  "This sounds urgent or life-threatening. Please call 112 or 108 now. Doot is a coordination line and cannot dispatch emergency help.";

export function classifyIntake(request: IntakeRequest): IntakeClassification {
  const text = request.utterance.toLowerCase();
  const safetyEscalation = safetyTerms.some((term) => text.includes(term));
  const language = request.languageHint;
  const mode: CaseMode = request.existingReference
    ? "existing"
    : request.requestedTimeframe === "now" || urgentTerms.some((term) => text.includes(term))
      ? "urgent"
      : planningTerms.some((term) => text.includes(term))
        ? "planning"
        : "planning";

  return {
    mode,
    safetyEscalation,
    language,
    reason: safetyEscalation
      ? "Safety cue detected before ordinary intake."
      : mode === "existing"
        ? "Caller supplied an existing case reference."
        : mode === "urgent"
          ? "Caller expressed a same-day or within-hours need."
          : "Caller is asking for non-immediate planning guidance.",
    disclosureScript: disclosureScripts[language],
    handoffScript: safetyEscalation ? emergencyHandoffScript : null
  };
}

export function selectProviders(providers: Provider[], criteria: ProviderSelectionCriteria): Provider[] {
  return providers
    .filter((provider) => provider.active)
    .filter((provider) => provider.serviceTags.includes(criteria.service))
    .filter((provider) => provider.locationTags.includes(criteria.location))
    .filter((provider) => criteria.accessibilityNeeds.every((need) => provider.accessibilityTags.includes(need)))
    .filter((provider) => provider.languages.includes(criteria.language) || provider.languages.includes("hinglish"))
    .filter((provider) => criteria.mode !== "urgent" || provider.acceptsHolds)
    .sort((left, right) => reliabilityScore(right) - reliabilityScore(left))
    .slice(0, criteria.limit);
}

export function verifyExistingCaller(input: CallerVerification) {
  return input.expectedPhoneBlindIndex === input.suppliedPhoneBlindIndex && input.expectedReference === input.suppliedReference;
}

export function reliabilityScore(provider: Provider | ProviderReliabilityProjection | ReliabilityMetrics) {
  const metrics = reliabilityMetrics(provider);
  const responseScore = Math.max(0, 1 - metrics.averageResponseSeconds / 180);
  const score =
    metrics.answeredCallRate * 0.28 +
    metrics.holdHonourRate * 0.42 +
    (1 - metrics.orphanHoldRate) * 0.2 +
    responseScore * 0.1;
  return Math.max(0, Math.min(1, Number(score.toFixed(4))));
}

export function projectReliability(provider: Provider, recordedOutcome: "honoured" | "orphaned" | "no_answer"): ProviderReliabilityProjection {
  const answeredDelta = recordedOutcome === "no_answer" ? -0.08 : 0.04;
  const honourDelta = recordedOutcome === "honoured" ? 0.06 : recordedOutcome === "orphaned" ? -0.08 : 0;
  const orphanDelta = recordedOutcome === "orphaned" ? 0.08 : recordedOutcome === "honoured" ? -0.03 : 0;
  const projectedMetrics = {
    providerId: provider.id,
    answeredCallRate: clamp(provider.reliability.answeredCallRate + answeredDelta),
    holdHonourRate: clamp(provider.reliability.holdHonourRate + honourDelta),
    orphanHoldRate: clamp(provider.reliability.orphanHoldRate + orphanDelta),
    averageResponseSeconds: provider.reliability.averageResponseSeconds
  };
  return { ...projectedMetrics, score: reliabilityScore(projectedMetrics) };
}

export const demoProviders: Provider[] = [
  {
    id: "provider_lotus",
    name: "Lotus Night Shelter",
    serviceTags: ["shelter", "respite"],
    locationTags: ["indiranagar", "central-bengaluru"],
    accessibilityTags: ["wheelchair", "women-only", "ground-floor"],
    languages: ["en", "hi", "hinglish"],
    acceptsHolds: true,
    active: true,
    reliability: { answeredCallRate: 0.92, holdHonourRate: 0.88, orphanHoldRate: 0.03, averageResponseSeconds: 52 }
  },
  {
    id: "provider_ashraya",
    name: "Ashraya Backup Desk",
    serviceTags: ["shelter", "respite"],
    locationTags: ["indiranagar", "central-bengaluru"],
    accessibilityTags: ["wheelchair", "ground-floor"],
    languages: ["hi", "hinglish"],
    acceptsHolds: true,
    active: true,
    reliability: { answeredCallRate: 0.84, holdHonourRate: 0.8, orphanHoldRate: 0.05, averageResponseSeconds: 61 }
  },
  {
    id: "provider_civic",
    name: "Civic Respite Desk",
    serviceTags: ["shelter", "respite"],
    locationTags: ["indiranagar"],
    accessibilityTags: ["wheelchair"],
    languages: ["en", "hinglish"],
    acceptsHolds: false,
    active: true,
    reliability: { answeredCallRate: 0.89, holdHonourRate: 0.42, orphanHoldRate: 0.01, averageResponseSeconds: 65 }
  },
  {
    id: "provider_northstar",
    name: "Northstar Hostel",
    serviceTags: ["shelter"],
    locationTags: ["indiranagar"],
    accessibilityTags: ["stairs-only"],
    languages: ["en"],
    acceptsHolds: true,
    active: true,
    reliability: { answeredCallRate: 0.76, holdHonourRate: 0.62, orphanHoldRate: 0.12, averageResponseSeconds: 34 }
  }
];

function clamp(value: number) {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

function reliabilityMetrics(provider: Provider | ProviderReliabilityProjection | ReliabilityMetrics): ReliabilityMetrics {
  if ("reliability" in provider) return provider.reliability;
  return provider;
}
