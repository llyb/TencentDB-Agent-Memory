import { describe, expect, it } from "vitest";

import { normalizeSkillNameForDedup, skillNameOverlapForDedup } from "./skill-tools.js";

describe("Skill create duplicate preflight helpers", () => {
  it("normalizes separator-only variants", () => {
    expect(normalizeSkillNameForDedup("closest-pair")).toBe(normalizeSkillNameForDedup("closest_pair"));
  });

  it("detects modifier-only near duplicates conservatively", () => {
    expect(skillNameOverlapForDedup("closest-pair-via-sorting", "find-closest-pair-by-sorting")).toBe(1);
    expect(skillNameOverlapForDedup("max-nesting-depth", "bracket-balance-counter")).toBeLessThan(1);
    expect(skillNameOverlapForDedup("sorted-two-pointer-triplet-sum", "two-pointer-interleave-from-ends")).toBeLessThan(1);
  });

  it("does not reject a specific skill because of one generic shared term", () => {
    expect(skillNameOverlapForDedup("sorting", "closest-pair-by-sorting")).toBe(0);
  });
});
