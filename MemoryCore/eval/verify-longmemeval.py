"""Cross-check TypeScript retrieval scores with the unmodified pinned upstream evaluator.

Usage: python eval/verify-longmemeval.py --run <run-dir> --data <official-json>
Requires numpy. Does not run a model or connect to the network.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np

parser = argparse.ArgumentParser()
parser.add_argument("--run", required=True, type=Path)
parser.add_argument("--data", required=True, type=Path)
args = parser.parse_args()

evaluator = Path(__file__).parent / "vendor" / "longmemeval" / "eval_utils.py"
expected_evaluator = "c98b8d1096877a15aa755c9de44fe33c195298466a2eb6f3c0f9f6bde8c72349"
expected_data = "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442"

def file_hash(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()

assert file_hash(evaluator) == expected_evaluator, "Upstream evaluator drift"
assert file_hash(args.data) == expected_data, "Official dataset drift"
# NumPy 2 removed asfarray. Restore only the old float conversion, not metric logic.
compat = not hasattr(np, "asfarray")
if compat:
    np.asfarray = lambda values: np.asarray(values, dtype=float)
spec = importlib.util.spec_from_file_location("longmemeval_upstream_metrics", evaluator)
upstream = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upstream)

with args.data.open(encoding="utf-8") as file:
    official = {q["question_id"]: q for q in json.load(file)}
with (args.run / "results.jsonl").open(encoding="utf-8") as file:
    rows = [json.loads(line) for line in file if line.strip()]
summary = json.loads((args.run / "summary.json").read_text(encoding="utf-8"))
assert len(rows) == summary["expected_rows"] == summary["completed_rows"]
seen = set()
checked = {"all": 0, "user": 0}
excluded = {"all": {}, "user": {}}
values = {"all": [], "user": []}

with (args.run / "record-map.jsonl").open(encoding="utf-8") as file:
    mappings = (json.loads(line) for line in file if line.strip())
    for row in rows:
        mapping = next(mappings)
        key = (row["question_id"], row["roles"])
        assert key not in seen, "Duplicate question/mode"
        seen.add(key)
        assert key == (mapping["question_id"], mapping["roles"])
        assert row["status"] == "ok", "Cannot validate a run with retrieval errors"
        q = official[key[0]]
        mode = key[1]
        assert len(mapping["records"]) == len(q["haystack_sessions"]), "History was truncated"
        evaluation_ids = list(q["haystack_session_ids"])
        if mode == "user":
            for i, (sid, turns) in enumerate(zip(evaluation_ids, q["haystack_sessions"])):
                if "answer" in sid and not any(t.get("has_answer", False) for t in turns if t["role"] == "user"):
                    evaluation_ids[i] = sid.replace("answer", "noans")
            gold = sorted(set(sid for sid in evaluation_ids if "answer" in sid))
        else:
            gold = sorted(set(q["answer_session_ids"]))
        exclusion = "abstention" if q["question_id"].endswith("_abs") else None
        if not exclusion and mode == "user" and not any(t.get("has_answer", False) for s in q["haystack_sessions"] for t in s if t["role"] == "user"):
            exclusion = "no_user_evidence"
        assert sorted(row["gold_session_ids"]) == gold
        assert row["exclusion"] == exclusion
        assert [m["evaluation_id"] for m in mapping["records"]] == evaluation_ids
        assert [m["source_session_id"] for m in mapping["records"]] == q["haystack_session_ids"]
        # Independently verify the frozen content-only snapshot mapping from the raw data.
        for i, m in enumerate(mapping["records"]):
            turns = q["haystack_sessions"][i]
            indices = [j for j, t in enumerate(turns) if mode == "all" or t["role"] == "user"]
            text = " ".join(turns[j]["content"] for j in indices)
            encoded = json.dumps(text, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            assert hashlib.sha256(encoded).hexdigest() == m["content_sha256"], "Indexed content differs from raw role-selected text"
            assert m["source_message_indices"] == indices
        if exclusion:
            assert row["scores"] is None
            excluded[mode][exclusion] = excluded[mode].get(exclusion, 0) + 1
            continue
        positions = {m["record_id"]: i for i, m in enumerate(mapping["records"])}
        rankings = [positions[r["record_id"]] for r in row["retrieved"]]
        any_score, all_score, ndcg = upstream.evaluate_retrieval(rankings, gold, evaluation_ids, k=5)
        score = row["scores"]
        for field, expected in [("hit_at_5", any_score), ("recall_all_at_5", all_score), ("ndcg_at_5", ndcg)]:
            assert abs(score[field] - expected) < 1e-12, (key, field, score[field], expected)
        checked[mode] += 1
        values[mode].append([any_score, all_score, ndcg])
    assert next(mappings, None) is None, "Extra mappings"

report = {
    "status": "passed", "official_evaluator_sha256": expected_evaluator,
    "official_dataset_sha256": expected_data, "numpy": np.__version__,
    "numpy_asfarray_compatibility_shim": compat,
    "verified_rows": len(rows), "verified_scored_questions": checked, "verified_exclusions": excluded,
    "metrics": {mode: dict(zip(["recall_any_at_5", "recall_all_at_5", "ndcg_at_5"], np.mean(xs, axis=0).tolist())) for mode, xs in values.items() if xs},
    "checks": ["all original session positions retained", "content hashes and source-message mapping",
               "independent gold/denominator reconstruction", "per-question upstream evaluator parity"],
}
print(json.dumps(report, ensure_ascii=False, indent=2))
with (args.run / "upstream-verification.json").open("x", encoding="utf-8") as file:
    json.dump(report, file, ensure_ascii=False, indent=2)
    file.write("\n")
