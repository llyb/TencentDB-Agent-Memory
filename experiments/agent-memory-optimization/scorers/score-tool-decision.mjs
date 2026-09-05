import { readFile } from "node:fs/promises";

function parseJsonl(text, label) {
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`${label}:${index + 1}: ${error.message}`); }
  });
}

export function scoreToolDecisions(cases, runs) {
  const byId = new Map(runs.map((run) => [run.case_id, run]));
  const missing = cases.filter((item) => !byId.has(item.case_id)).map((item) => item.case_id);
  if (missing.length) throw new Error(`Missing run rows: ${missing.slice(0, 10).join(", ")}`);

  let shouldCall = 0;
  let effectiveCalls = 0;
  let shouldNotCall = 0;
  let falseCalls = 0;
  let positiveCalls = 0;
  let correctSelections = 0;
  let injectedTokens = 0;

  for (const item of cases) {
    const run = byId.get(item.case_id);
    if (typeof run.did_call !== "boolean") throw new Error(`${item.case_id}: did_call must be boolean`);
    if (!Number.isFinite(run.injected_tokens) || run.injected_tokens < 0) throw new Error(`${item.case_id}: injected_tokens must be non-negative`);
    if (run.did_call && !["memory", "skill", "knowledge"].includes(run.actual_first_family)) {
      throw new Error(`${item.case_id}: a called run needs actual_first_family`);
    }
    injectedTokens += run.injected_tokens;
    if (item.expected_family === "none") {
      shouldNotCall++;
      if (run.did_call) falseCalls++;
      continue;
    }
    shouldCall++;
    if (run.did_call) {
      effectiveCalls++;
      positiveCalls++;
      if (run.actual_first_family === item.expected_family) correctSelections++;
    }
  }

  const ratio = (n, d) => d === 0 ? null : n / d;
  return {
    case_count: cases.length,
    effective_call_rate: ratio(effectiveCalls, shouldCall),
    false_call_rate: ratio(falseCalls, shouldNotCall),
    tool_selection_accuracy: ratio(correctSelections, positiveCalls),
    injected_token_count: {
      total: injectedTokens,
      average_per_case: ratio(injectedTokens, cases.length),
    },
    denominators: { should_call: shouldCall, should_not_call: shouldNotCall, positive_calls: positiveCalls },
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href) {
  const [casePath, runPath] = process.argv.slice(2);
  if (!casePath || !runPath) {
    console.error("Usage: node score-tool-decision.mjs <cases.jsonl> <runs.jsonl>");
    process.exit(2);
  }
  const [caseText, runText] = await Promise.all([readFile(casePath, "utf8"), readFile(runPath, "utf8")]);
  console.log(JSON.stringify(scoreToolDecisions(parseJsonl(caseText, casePath), parseJsonl(runText, runPath)), null, 2));
}
