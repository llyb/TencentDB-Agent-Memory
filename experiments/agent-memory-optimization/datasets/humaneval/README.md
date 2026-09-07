# HumanEval prompt manifests

Source: `openai/human-eval` commit
`6d43fb980f9fee3c892a914eda09951f772ad10d`.

- `dev.jsonl`: 82 tasks with even numeric task IDs.
- `test.jsonl`: 82 tasks with odd numeric task IDs.
- Rows contain only `task_id`, `family`, `sequence_index`, `prompt`, and
  `entry_point`.
- Canonical solutions and evaluator tests are intentionally excluded from
  model-visible data.

Regenerate from the repository root after installing the official HumanEval
package:

```bash
python experiments/agent-memory-optimization/prepare-humaneval-dataset.py
```
