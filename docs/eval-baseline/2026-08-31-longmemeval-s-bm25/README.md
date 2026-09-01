# LongMemEval-S BM25 全量运行归档

本目录保存运行 `longmemeval-2026-08-31T06-26-05-642Z-3ef6c67c` 的原始产物。500 个问题、all/user 两种模式、1000 行结果，运行错误为 0；作者原版评分函数的独立核验通过。详见[中文报告与教程](../../LONGMEMEVAL_TEST_REPORT_CN.md)。

| 文件 | 用途 |
|---|---|
| [report.md](report.md) | 执行器自动生成的结果报告 |
| [summary.json](summary.json) | 总体、分类和时间诊断子集的完整指标与置信区间 |
| [run.json](run.json) | 数据、配置、源码和快照身份 |
| [config.resolved.json](config.resolved.json) | 本机执行时的实际配置；路径指向当时工作区 |
| [source-files.json](source-files.json) | 实际运行源码的逐文件 SHA-256 |
| [samples.jsonl](samples.jsonl) | 500 题的题目、参考答案、gold ID 与元数据 |
| [results.jsonl](results.jsonl) | 1000 行排名、候选、逐题指标与排除原因 |
| [trace.jsonl](trace.jsonl) | 1000 条共享结构检索 trace |
| [record-map.jsonl.gz](record-map.jsonl.gz) | 全量 record 到原始 session 位置及消息的映射，无损 gzip |
| [upstream-verification.json](upstream-verification.json) | 原版评分函数及数据映射独立核验结论 |
| [manifest.json](manifest.json) | 上述运行产物的字节数和 SHA-256；压缩文件附解压后哈希 |

除来源映射经过无损压缩外，所有运行产物均按原始字节复制，未手工修改成绩。`manifest.json` 不包含自身及本说明文件。解压后的映射为 31,753,236 字节，SHA-256：

```text
c7c96560fcfc3a2ec21d2ab7f9f50c9ae509ed709eadcbd5cc903891d11abe9a
```

可以用任何 gzip 工具读取映射；按 `question_id`、`roles`、`record_id` 与结果关联。核验器默认接收新运行目录内未压缩的 `record-map.jsonl`。如需核验本归档，请先复制到单独目录并解压映射、排除已生成的核验输出，再按教程执行；不要修改此冻结归档。

原始 277,383,467 字节数据不在此目录。使用[固定的官方版本](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/tree/98d7416c24c778c2fee6e6f3006e7a073259d48f)，SHA-256 为 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`。保留所有历史而不是 oracle 会话。数据与作者评分代码采用 MIT 许可，原文许可见 [LICENSE](../../../MemoryCore/eval/vendor/longmemeval/LICENSE)。

这里是本项目 FTS5 BM25 的会话检索成绩，未包含模型抽取、Dense/Hybrid 或回答准确率。all/user 的相关性评分分母分别为 470/419；其余题仍保留日志，不应按 500 重新解释均值。
