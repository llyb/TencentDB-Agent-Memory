import { describe, expect, it } from "vitest";

import {
  filterSkillListingsByScope,
  packSkillListing,
  type SkillListingItem,
} from "./skill-handlers.js";

const items: SkillListingItem[] = [
  { skill_id: "skl-1", version: 1, name: "first", description: "first description" },
  { skill_id: "skl-2", version: 2, name: "second", description: "second description" },
];

describe("packSkillListing", () => {
  it("packs only complete entries and reports matching hits", () => {
    const oneEntryBudget = packSkillListing(items.slice(0, 1), 10_000).listing.length;
    const result = packSkillListing(items, oneEntryBudget);

    expect(result.listing.length).toBeLessThanOrEqual(oneEntryBudget);
    expect(result.listing).toContain("- first: first description");
    expect(result.listing).not.toContain("- second:");
    expect(result.listing.endsWith("</available_skills>")).toBe(true);
    expect(result.packed.map((item) => item.skill_id)).toEqual(["skl-1"]);
    expect(result.omitted).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it("escapes metadata before injecting it into XML", () => {
    const result = packSkillListing([
      { skill_id: "skl-&", version: 1, name: "a<b", description: "x & y" },
    ], 10_000);

    expect(result.listing).toContain("a&lt;b");
    expect(result.listing).toContain("x &amp; y");
  });

  it("returns no partial wrapper when the budget is too small", () => {
    const result = packSkillListing(items, 5);
    expect(result).toMatchObject({ listing: "", packed: [], omitted: 2, truncated: true });
  });

  it("filters known incompatible scopes while retaining legacy unknown scopes", () => {
    const scoped: SkillListingItem[] = [
      items[0]!,
      {
        ...items[1]!,
        scope: { repo: "owner/repo", path_globs: ["src/**/*.ts"], languages: ["TypeScript"] },
      },
    ];

    expect(filterSkillListingsByScope(scoped, {
      repo: "other/repo",
      path: "src/core/a.ts",
      language: "TypeScript",
    }).map((item) => item.skill_id)).toEqual(["skl-1"]);

    expect(filterSkillListingsByScope(scoped, {
      repo: "owner/repo",
      path: "src/core/a.ts",
      language: "typescript",
    }).map((item) => item.skill_id)).toEqual(["skl-1", "skl-2"]);
  });
});
