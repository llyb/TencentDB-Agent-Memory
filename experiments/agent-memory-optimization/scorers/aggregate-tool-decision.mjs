import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scoreToolDecisions } from "./score-tool-decision.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const experiment = path.resolve(here, "..");
const parseJsonl = (text) => text.trim().split(/\r?\n/).map(JSON.parse);
const cases = parseJsonl(await readFile(path.join(experiment, "datasets/proxy-test.jsonl"), "utf8"));
const names = (await readdir(path.join(experiment, "runs")))
  .filter((name) => /^glm-5\.2-p[03]-test-seed[123]\.jsonl$/.test(name))
  .sort();
const tokenControl = parseJsonl(await readFile(path.join(experiment, "runs/glm-5.2-pnone-test-seed1.jsonl"), "utf8"));
const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const tokenControlAverage = average(tokenControl.map((run) => run.provider_prompt_tokens).filter(Number.isFinite));

const versions = {};
for (const version of ["p0", "p3"]) {
  const files = names.filter((name) => name.includes(`-${version}-`));
  const seeds = [];
  const pooledCases = [];
  const pooledRuns = [];
  const failures = [];
  for (const [fileIndex, file] of files.entries()) {
    const runs = parseJsonl(await readFile(path.join(experiment, "runs", file), "utf8"));
    const metrics = scoreToolDecisions(cases, runs);
    seeds.push({ seed: runs[0]?.seed, file, metrics });
    for (let i = 0; i < cases.length; i++) {
      const suffix = `#${fileIndex}`;
      pooledCases.push({ ...cases[i], case_id: `${cases[i].case_id}${suffix}` });
      pooledRuns.push({ ...runs[i], case_id: `${runs[i].case_id}${suffix}` });
      const expected = cases[i].expected_family;
      const failed = expected === "none"
        ? runs[i].did_call
        : !runs[i].did_call || runs[i].actual_first_family !== expected;
      if (failed) failures.push({
        case_id: cases[i].case_id,
        seed: runs[i].seed,
        expected,
        actual: runs[i].actual_first_family,
        assistant_text: runs[i].assistant_text,
        actual_first_tool: runs[i].actual_first_tool,
      });
    }
  }
  const providerPromptTokens = pooledRuns.map((run) => run.provider_prompt_tokens).filter(Number.isFinite);
  const providerPromptTokensAverage = average(providerPromptTokens);
  versions[version] = {
    seeds,
    pooled: scoreToolDecisions(pooledCases, pooledRuns),
    provider_prompt_tokens_average: providerPromptTokensAverage,
    provider_injected_tokens_average: providerPromptTokensAverage - tokenControlAverage,
    failures,
  };
}

const report = {
  model: "glm-5.2",
  temperature: 0,
  seeds: [1, 2, 3],
  split: "test",
  cases_per_seed: cases.length,
  token_control: {
    file: "glm-5.2-pnone-test-seed1.jsonl",
    provider_prompt_tokens_average: tokenControlAverage,
    purpose: "Subtract common system, query, and Bash tool-schema tokens; not used for behavior metrics.",
  },
  versions,
};
await mkdir(path.join(experiment, "reports"), { recursive: true });
await writeFile(path.join(experiment, "reports", "glm-5.2-p0-p3-test.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
