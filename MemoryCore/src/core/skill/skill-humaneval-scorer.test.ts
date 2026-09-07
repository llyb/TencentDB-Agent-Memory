import { describe, expect, it } from "vitest";

import { scoreSkillHumanEval } from "../../../../experiments/agent-memory-optimization/scorers/score-skill-humaneval.mjs";

const base = {
  family: "strings",
  group: "S1",
  seed: 1,
  turns: 4,
  solve_input_tokens: 100,
  solve_output_tokens: 20,
  skill_extraction_tokens: 10,
  skill_routing_tokens: 0,
  archive_triggered: true,
};

describe("scoreSkillHumanEval", () => {
  it("computes the five task-two metrics and requires a later-task hit", () => {
    const result = scoreSkillHumanEval([
      {
        ...base,
        task_id: "HumanEval/0",
        sequence_index: 0,
        pass: true,
        extracted_skill_ids: ["skl-a", "skl-b"],
        injected_skill_ids: [],
      },
      {
        ...base,
        task_id: "HumanEval/1",
        sequence_index: 1,
        pass: false,
        turns: 6,
        archive_triggered: false,
        extracted_skill_ids: [],
        injected_skill_ids: ["skl-a"],
      },
    ]);

    expect(result.S1.pass_at_1).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(result.S1.average_total_tokens).toBe(130);
    expect(result.S1.average_turns).toBe(5);
    expect(result.S1.skill_extraction_rate).toEqual({ numerator: 1, denominator: 1, value: 1 });
    expect(result.S1.skill_hit_rate).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
  });

  it("counts frozen snapshot Skills in injection-only hit rate", () => {
    const result = scoreSkillHumanEval([
      {
        ...base,
        group: "S3",
        task_id: "HumanEval/24",
        sequence_index: 12,
        pass: true,
        archive_triggered: false,
        skill_extraction_tokens: 0,
        snapshot_skill_ids: ["skl-a", "skl-b"],
        extracted_skill_ids: [],
        injected_skill_ids: ["skl-b"],
      },
    ]);

    expect(result.S3.skill_extraction_rate).toEqual({ numerator: 0, denominator: 0, value: null });
    expect(result.S3.skill_hit_rate).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
  });
});
