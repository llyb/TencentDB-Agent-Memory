"""Export deterministic HumanEval dev/test prompt manifests.

Install the official package from https://github.com/openai/human-eval first.
Only task_id, prompt, entry_point and a deterministic family are exported;
canonical solutions and hidden tests are never written to the model dataset.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from human_eval.data import read_problems


def task_number(task_id: str) -> int:
    return int(task_id.rsplit("/", 1)[1])


def main() -> None:
    parser = argparse.ArgumentParser()
    default_output = Path(__file__).resolve().parent / "datasets" / "humaneval"
    parser.add_argument("--output-dir", type=Path, default=default_output)
    args = parser.parse_args()

    problems = read_problems()
    ordered = sorted(problems.items(), key=lambda item: task_number(item[0]))
    args.output_dir.mkdir(parents=True, exist_ok=True)

    outputs = {
        "dev": (args.output_dir / "dev.jsonl").open("w", encoding="utf-8"),
        "test": (args.output_dir / "test.jsonl").open("w", encoding="utf-8"),
    }
    try:
        sequence_indexes = {"dev": 0, "test": 0}
        for task_id, problem in ordered:
            split = "dev" if task_number(task_id) % 2 == 0 else "test"
            row = {
                "task_id": task_id,
                "family": "python-function",
                "sequence_index": sequence_indexes[split],
                "prompt": problem["prompt"],
                "entry_point": problem["entry_point"],
            }
            outputs[split].write(json.dumps(row, ensure_ascii=False) + "\n")
            sequence_indexes[split] += 1
    finally:
        for output in outputs.values():
            output.close()


if __name__ == "__main__":
    main()
