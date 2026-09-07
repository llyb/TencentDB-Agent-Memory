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

## Task 2: Skill-chain HumanEval evaluation

Task two uses the official [OpenAI HumanEval](https://github.com/openai/human-eval)
dataset. Install the official package, then export deterministic prompt-only
dev/test manifests from the repository root:

```bash
python experiments/agent-memory-optimization/prepare-humaneval-dataset.py
```

The exporter sorts the 164 canonical `HumanEval/<n>` tasks numerically and uses
an even/odd task-id split: even IDs are dev and odd IDs are test. It never
exports canonical solutions or tests. Within each split, tasks run in fixed
order with an independent empty Skill store for every group/seed.

Write one telemetry row per Agent run following
`schemas/skill-humaneval-run.schema.json`. Generate exactly one completion per
task for pass@1, in the official format:

```json
{"task_id":"HumanEval/0","completion":"return ..."}
```

Evaluate completion correctness with the official command inside a robust
sandbox, because it executes untrusted model-generated Python:

```bash
python -m human_eval.evaluate_functional_correctness samples.jsonl
```

For this repository, build the local evaluator image from a pinned checkout of
the official HumanEval repository. The image keeps the official tests and
execution logic, but removes the upstream all-164-tasks assertion so the frozen
dev/test subsets can be evaluated independently:

```bash
docker build -f experiments/agent-memory-optimization/humaneval-evaluator.Dockerfile \
  -t tdai-humaneval-evaluator:local D:/human-eval-validation
```

Run the local OpenAI-compatible chat model with an initially empty Skill store:

```bash
cd MemoryCore
npx tsx ../experiments/agent-memory-optimization/run-humaneval-skill-eval.mts \
  --group S0 --split dev --seed 1 --evaluate
```

The runner reads chat and embedding endpoints from `deploy/global-images/.env`
without printing credentials. Skill-enabled runs support independent controls
for `--tool-call-threshold`, `--bytes-threshold`, `--extraction-max-tokens`,
`--routing`, `--routing-threshold`, `--top-k`, and
`--char-budget-percent`. Online cumulative runs must remain sequential; do not
split them into parallel shards because each task may consume Skills extracted
from earlier tasks.

For an injection-only comparison, load one frozen snapshot in every route and
disable further extraction. Use a later, non-overlapping task range so snapshot
Skills cannot leak a solution back into their source tasks:

```bash
node ../experiments/agent-memory-optimization/prepare-frozen-skill-snapshot.mjs \
  --input ../experiments/agent-memory-optimization/runs/humaneval/s2-dev-seed1-o24-n58-bytes512-skills.json \
  --output ../experiments/agent-memory-optimization/runs/humaneval/s3-dev-seed1-prefix41-snapshot.json \
  --before-sequence 41

npx tsx ../experiments/agent-memory-optimization/run-humaneval-skill-eval.mts \
  --group S3 --split dev --seed 1 --offset 41 --limit 41 \
  --skill-snapshot ../experiments/agent-memory-optimization/runs/humaneval/s3-dev-seed1-prefix-snapshot.json \
  --disable-extraction --routing embedding --routing-threshold 0.5 \
  --top-k 3 --char-budget-percent 0.01 --run-label embedding-k3 --evaluate
```

Copy the official per-task `passed` value into the corresponding telemetry row,
then compute the five task-two metrics with:

```bash
node scorers/score-skill-humaneval.mjs runs/<skill-humaneval-run>.jsonl
```

The scorer reports exactly `pass_at_1`, `average_total_tokens` (including
extraction/routing cost), `average_turns`, `skill_extraction_rate`, and
`skill_hit_rate`. A Skill counts as hit only when its full content is injected
or read by a later task in the same family, seed, and experiment group;
appearing in listing metadata is not sufficient.

The implementation exposes independent experiment controls. A typical S2/S3
candidate configuration is:

```yaml
skill:
  enabled: true
  routing:
    mode: bm25
    searchTopK: 5
    charBudgetPercent: 0.01
    contextWindowChars: 800000
  extraction:
    enabled: true
    toolCallThreshold: 10
    bytesThreshold: 40960
    requestCompressThresholdBytes: 40960
    maxIterations: 4
    promptVersion: evidence
    transcriptStrategy: structured
    headChars: 8000
    tailChars: 32000
```

These are experiment values, not claimed best defaults. The resolver retains
backward-compatible `legacy`/`head_tail` defaults because the HumanEval dev
trade-off did not justify a global production-default change.

The dev-selected short-task candidate is intentionally opt-in: 512-byte
trigger, evidence extraction, BM25 `topK=1`, score threshold `0.05`, and a
0.5% character budget. Run the locked test candidate with a deduplicated dev
snapshot (repeat for seeds 1, 2, and 3):

```bash
cd MemoryCore
npx tsx ../experiments/agent-memory-optimization/run-humaneval-skill-eval.mts \
  --group S5 --split test --seed 1 \
  --skill-snapshot ../experiments/agent-memory-optimization/runs/humaneval/s4-dev-seed1-prefix41-m1-snapshot.json \
  --bytes-threshold 512 --tool-call-threshold 999 \
  --routing bm25 --routing-threshold 0.05 --top-k 1 \
  --char-budget-percent 0.005 --run-label final-combo --evaluate
```

HumanEval extraction is one-shot and its transcripts are short, so this
benchmark cannot identify the production extractor's `maxIterations` ceiling
or long-transcript truncation benefit. Keep their backward-compatible defaults
until a multi-turn repository benchmark measures them.
