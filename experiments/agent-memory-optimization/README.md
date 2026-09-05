# Task 1: Proxy tool-injection evaluation

This directory implements the approved four-metric evaluation contract. It does not measure tool-result quality.

Generate the fixed 200-case dataset:

```bash
node datasets/build-proxy-dataset.mjs
```

Each split contains 100 cases: 20 memory, 20 skill, 20 knowledge, and 40 none. Development and test use disjoint `template_family` values.

A model replay writes one JSONL row per case:

```json
{"case_id":"test-memory-001","did_call":true,"actual_first_family":"memory","injected_tokens":812}
```

Score it with:

```bash
node scorers/score-tool-decision.mjs datasets/proxy-test.jsonl runs/<model>-<prompt-version>.jsonl
```

The only reported optimization metrics are `effective_call_rate`, `false_call_rate`, `tool_selection_accuracy`, and `injected_token_count`. Prompt-cache stability is validated separately as an engineering acceptance condition.

Reproduce the static P0/P3 token fixture from the repository root:

```bash
cd MemoryProxy
npx tsx ../experiments/agent-memory-optimization/measure-prompt-tokens.mts 50f33f5
```

The script reads P0 renderers from the supplied Git ref (default `50f33f5`), evaluates current P3 renderers, and writes `reports/prompt-token-baseline.json`.

Run the configured local OpenAI-compatible model (the runner reads `deploy/global-images/.env` without printing credentials):

```bash
cd MemoryProxy
npx tsx ../experiments/agent-memory-optimization/run-tool-decision-eval.mts --version p0 --split test --seed 1 --concurrency 4
npx tsx ../experiments/agent-memory-optimization/run-tool-decision-eval.mts --version p3 --split test --seed 1 --concurrency 4
```

Use seeds 1, 2, and 3 for the final result. The optional `pnone` version is a Token-only control used to subtract the common system/query/Bash-schema prompt cost; never include it in behavior metrics. Aggregate all completed runs with:

```bash
node ../experiments/agent-memory-optimization/scorers/aggregate-tool-decision.mjs
```
