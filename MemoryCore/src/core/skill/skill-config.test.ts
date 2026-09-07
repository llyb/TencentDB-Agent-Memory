import { describe, expect, it } from "vitest";

import { resolveSkillConfig, type ResolverLogger } from "./skill-config.js";
import { normalizeSkillNameForDedup } from "./skill-tools.js";

const probe = {
  hasTcvdbCredentials: false,
  hasCosCredentials: false,
  embeddingAvailable: true,
  llmRunnerAvailable: true,
} as const;

function logger(): ResolverLogger {
  return { info() {}, warn() {}, error() {} };
}

describe("resolveSkillConfig task-two controls", () => {
  it("derives and exposes the listing budget from charBudgetPercent", () => {
    const cfg = resolveSkillConfig({
      enabled: true,
      routing: { charBudgetPercent: 0.02, contextWindowChars: 100_000 },
    }, probe, logger());

    expect(cfg?.routing.listingCharBudget).toBe(2_000);
    expect(cfg?.routing.charBudgetPercent).toBe(0.02);
  });

  it("allows a zero-percent listing budget for no-injection experiments", () => {
    const cfg = resolveSkillConfig({
      enabled: true,
      routing: { charBudgetPercent: 0 },
    }, probe, logger());

    expect(cfg?.routing.listingCharBudget).toBe(0);
  });

  it("allows a zero tool-call threshold for forced-trigger experiments", () => {
    const cfg = resolveSkillConfig({
      enabled: true,
      extraction: { toolCallThreshold: 0 },
    }, probe, logger());

    expect(cfg?.extraction.toolCallThreshold).toBe(0);
  });

  it("keeps archive and transcript budgets independently tunable", () => {
    const cfg = resolveSkillConfig({
      enabled: true,
      extraction: {
        archiveBytes: 40_960,
        bytesThreshold: 24_000,
        requestCompressThresholdBytes: 64_000,
        headChars: 4_000,
        tailChars: 12_000,
        prefixSkillsLimit: 0,
        promptVersion: "evidence",
        transcriptStrategy: "structured",
      },
    }, probe, logger());

    expect(cfg?.extraction).toMatchObject({
      archiveBytes: 40_960,
      bytesThreshold: 24_000,
      requestCompressThresholdBytes: 64_000,
      headChars: 4_000,
      tailChars: 12_000,
      prefixSkillsLimit: 0,
      promptVersion: "evidence",
      transcriptStrategy: "structured",
    });
  });

  it("preserves the legacy 8K listing and 8K/32K transcript defaults", () => {
    const cfg = resolveSkillConfig({ enabled: true }, probe, logger());

    expect(cfg?.routing.listingCharBudget).toBe(8_000);
    expect(cfg?.extraction.headChars).toBe(8_000);
    expect(cfg?.extraction.tailChars).toBe(32_000);
  });
});

describe("Skill name deduplication", () => {
  it("treats separator-only name variants as the same topic", () => {
    expect(normalizeSkillNameForDedup("parser-error-recovery"))
      .toBe(normalizeSkillNameForDedup("parser_error recovery"));
  });
});
