import { describe, expect, it } from "vitest";
import {
  classifyIntake,
  demoProviders,
  projectReliability,
  selectProviders,
  verifyExistingCaller
} from "../src/index";

describe("Doot policy", () => {
  it("classifies urgent, planning, and existing intake", () => {
    expect(classifyIntake({
      callerPhoneBlindIndex: "blind",
      utterance: "I need a bed tonight near Indiranagar",
      languageHint: "hinglish",
      requestedFor: "self",
      accessibilityNeeds: []
    }).mode).toBe("urgent");

    expect(classifyIntake({
      callerPhoneBlindIndex: "blind",
      utterance: "I am planning options for next week",
      languageHint: "en",
      requestedFor: "self",
      accessibilityNeeds: []
    }).mode).toBe("planning");

    expect(classifyIntake({
      callerPhoneBlindIndex: "blind",
      utterance: "I have my old reference",
      existingReference: "D-8842",
      languageHint: "en",
      requestedFor: "self",
      accessibilityNeeds: []
    }).mode).toBe("existing");
  });

  it("routes safety cues to handoff before ordinary intake", () => {
    const result = classifyIntake({
      callerPhoneBlindIndex: "blind",
      utterance: "Someone is not breathing",
      languageHint: "en",
      requestedFor: "someone_else",
      accessibilityNeeds: []
    });

    expect(result.safetyEscalation).toBe(true);
    expect(result.handoffScript).toContain("112 or 108");
  });

  it("selects only eligible hold-capable providers for urgent cases", () => {
    const selected = selectProviders(demoProviders, {
      mode: "urgent",
      location: "indiranagar",
      service: "shelter",
      accessibilityNeeds: ["wheelchair"],
      language: "hinglish",
      limit: 3
    });

    expect(selected.map((provider) => provider.id)).toEqual(["provider_lotus", "provider_ashraya"]);
    expect(selected.every((provider) => provider.acceptsHolds)).toBe(true);
  });

  it("allows availability-only providers in planning cases", () => {
    const selected = selectProviders(demoProviders, {
      mode: "planning",
      location: "indiranagar",
      service: "shelter",
      accessibilityNeeds: ["wheelchair"],
      language: "hinglish",
      limit: 3
    });

    expect(selected.map((provider) => provider.id)).toContain("provider_civic");
  });

  it("requires phone blind index and spoken reference for existing-case changes", () => {
    expect(verifyExistingCaller({
      expectedPhoneBlindIndex: "blind-8842",
      suppliedPhoneBlindIndex: "blind-8842",
      expectedReference: "D-8842",
      suppliedReference: "D-8842"
    })).toBe(true);

    expect(verifyExistingCaller({
      expectedPhoneBlindIndex: "blind-8842",
      suppliedPhoneBlindIndex: "blind-0000",
      expectedReference: "D-8842",
      suppliedReference: "D-8842"
    })).toBe(false);
  });

  it("updates reliability only from recorded outcomes", () => {
    const provider = demoProviders[0]!;
    const honoured = projectReliability(provider, "honoured");
    const orphaned = projectReliability(provider, "orphaned");

    expect(honoured.holdHonourRate).toBeGreaterThan(provider.reliability.holdHonourRate);
    expect(orphaned.orphanHoldRate).toBeGreaterThan(provider.reliability.orphanHoldRate);
    expect(orphaned.score).toBeLessThan(honoured.score);
  });
});
