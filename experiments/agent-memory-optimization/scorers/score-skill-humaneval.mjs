import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const requiredNumbers = [
  "sequence_index",
  "seed",
  "turns",
  "solve_input_tokens",
  "solve_output_tokens",
  "skill_extraction_tokens",
  "skill_routing_tokens",
];

function assertRow(row, index) {
  for (const field of ["task_id", "family", "group"]) {
    if (typeof row[field] !== "string" || row[field].length === 0) {
      throw new Error(`row ${index + 1}: ${field} must be a non-empty string`);
    }
  }
  for (const field of requiredNumbers) {
    if (!Number.isFinite(row[field]) || row[field] < 0) {
      throw new Error(`row ${index + 1}: ${field} must be a non-negative number`);
    }
  }
  if (typeof row.pass !== "boolean" || typeof row.archive_triggered !== "boolean") {
    throw new Error(`row ${index + 1}: pass/archive_triggered must be boolean`);
  }
  if (!Array.isArray(row.extracted_skill_ids) || !Array.isArray(row.injected_skill_ids)) {
    throw new Error(`row ${index + 1}: extracted_skill_ids/injected_skill_ids must be arrays`);
  }
  if (row.snapshot_skill_ids !== undefined && !Array.isArray(row.snapshot_skill_ids)) {
    throw new Error(`row ${index + 1}: snapshot_skill_ids must be an array when present`);
  }
}

const mean = (values) => values.length === 0
  ? null
  : values.reduce((sum, value) => sum + value, 0) / values.length;

const ratio = (numerator, denominator) => ({
  numerator,
  denominator,
  value: denominator === 0 ? null : numerator / denominator,
});

/** Compute only the five metrics approved for task two. */
export function scoreSkillHumanEval(rows) {
  rows.forEach(assertRow);
  const groups = new Map();
  for (const row of rows) {
    const bucket = groups.get(row.group) ?? [];
    bucket.push(row);
    groups.set(row.group, bucket);
  }

  const result = {};
  for (const [group, groupRows] of [...groups.entries()].sort()) {
    const ordered = [...groupRows].sort((a, b) =>
      a.seed - b.seed || a.family.localeCompare(b.family) || a.sequence_index - b.sequence_index);
    const archiveRows = ordered.filter((row) => row.archive_triggered);
    const extractionRows = archiveRows.filter((row) => row.extracted_skill_ids.length > 0);

    // Every group/seed/family has an independent store, optionally initialized
    // from a frozen earlier-split snapshot for transfer-only comparisons.
    const extracted = new Map();
    for (const row of ordered) {
      for (const skillId of new Set(row.snapshot_skill_ids ?? [])) {
        const key = `${row.seed}\u0000${row.family}\u0000${skillId}`;
        if (!extracted.has(key)) extracted.set(key, { sequence_index: -1 });
      }
      for (const skillId of new Set(row.extracted_skill_ids)) {
        const key = `${row.seed}\u0000${row.family}\u0000${skillId}`;
        const first = extracted.get(key);
        if (!first || row.sequence_index < first.sequence_index) {
          extracted.set(key, { sequence_index: row.sequence_index });
        }
      }
    }
    const hit = new Set();
    for (const row of ordered) {
      for (const skillId of new Set(row.injected_skill_ids)) {
        const key = `${row.seed}\u0000${row.family}\u0000${skillId}`;
        const origin = extracted.get(key);
        if (origin && row.sequence_index > origin.sequence_index) hit.add(key);
      }
    }

    const totalTokens = groupRows.map((row) =>
      row.solve_input_tokens
      + row.solve_output_tokens
      + row.skill_extraction_tokens
      + row.skill_routing_tokens);

    result[group] = {
      task_count: groupRows.length,
      pass_at_1: ratio(groupRows.filter((row) => row.pass).length, groupRows.length),
      average_total_tokens: mean(totalTokens),
      average_turns: mean(groupRows.map((row) => row.turns)),
      skill_extraction_rate: ratio(extractionRows.length, archiveRows.length),
      skill_hit_rate: ratio(hit.size, extracted.size),
    };
  }
  return result;
}

function parseJsonl(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(JSON.parse);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const inputs = process.argv.slice(2);
  if (inputs.length === 0) throw new Error("usage: node score-skill-humaneval.mjs <runs.jsonl> [...shards.jsonl]");
  const rows = (await Promise.all(inputs.map(async (input) => parseJsonl(await readFile(input, "utf8"))))).flat();
  console.log(JSON.stringify(scoreSkillHumanEval(rows), null, 2));
}
