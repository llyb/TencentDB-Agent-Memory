The unmodified `eval_utils.py` is from the authors' official repository:

- Repository: https://github.com/xiaowu0162/LongMemEval
- Commit: `9e0b455f4ef0e2ab8f2e582289761153549043fc`
- Path: `src/retrieval/eval_utils.py`
- SHA-256: `c98b8d1096877a15aa755c9de44fe33c195298466a2eb6f3c0f9f6bde8c72349`
- License: MIT, copyright (c) 2024 Di Wu; see `LICENSE`.

Used only by the optional offline parity checker. NumPy 2 compatibility is applied
in the caller (`np.asfarray` float conversion), without modifying the upstream file.

The unmodified `evaluate_qa.py` comes from the same repository and commit:

- Path: `src/evaluation/evaluate_qa.py`
- SHA-256: `ecce9c4c79dc89d99534ac17b383a5cbb5b9f0c69ee98adaf0684742e3d95251`
- Same MIT license and copyright; see `LICENSE`.

The system evaluator reads its five `get_anscheck_prompt` templates without
executing Python or importing the upstream OpenAI client. Judge model IDs are
configured locally; strict yes/no parsing rejects malformed labels instead of
the upstream substring check. These deviations are disclosed in the report.
