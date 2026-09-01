import { describe, expect, it } from "vitest";
import { traceSchema } from "./schema.js";
import { bootstrapCI } from "./metrics.js";

describe("shared, separate trace contracts", () => {
  const base = { run_id: "run", config_hash: "hash", model: null, repo_commit: "commit", prompt_version: "v1",
    sample_id: "sample", timestamp: "2026-08-31T00:00:00Z" };
  it("accepts tool decisions without pretending local coding tools are asset tools", () => {
    expect(traceSchema.parse({ ...base, suite: "tool_decision", event: "decision", trace: {
      context_hash: "c", assets_hash: "a", serialized_prompt_hash: "p", allowed_asset_tools: [],
      called_tools: ["shell", "read"], expected_asset_call: false, injection_tokens: 0, fixture_hash: "f",
    } }).suite).toBe("tool_decision");
  });
  it("prevents cache token double counting and does not merge suite scores", () => {
    const row = { ...base, suite: "skill_coding", event: "task", trace: { task_commit: "base", skill_snapshot_hash: "skills",
      status: "passed", verifier_command: "npm test", verifier_exit_code: 0, turns: 2, loaded_skill_ids: ["sop"],
      costs: [{ stage: "task", input_tokens: 100, output_tokens: 20, cached_input_tokens: 120 }] } };
    expect(traceSchema.safeParse(row).success).toBe(false);
    row.trace.costs[0].cached_input_tokens = 40;
    expect(traceSchema.safeParse(row).success).toBe(true);
  });
});

describe("question-level uncertainty", () => {
  it("bootstraps deterministically without inventing a one-question interval", () => {
    const values = [{ group_id: "a", value: 0 }, { group_id: "b", value: 1 }];
    expect(bootstrapCI(values, 500, 123)).toEqual([0, 1]);
    expect(bootstrapCI(values, 500, 123)).toEqual(bootstrapCI(values, 500, 123));
    expect(bootstrapCI([values[0]], 500, 123)).toBeNull();
  });
});
