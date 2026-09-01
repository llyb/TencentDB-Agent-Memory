# Memory Eval：LongMemEval 官方数据评测

新增 **完整记忆系统数据链路与 Embedding 对照**：`npm run eval:memory -- system --live`。真实执行 L0→L1→L2→L3、BM25/Dense/Hybrid、回答及双裁判；见 [SYSTEM_EVAL_CN.md](SYSTEM_EVAL_CN.md)。下文 `run` 仍是无需 API 的旧会话检索基线，两个实验边界独立。

Memory Retrieval 只使用作者发布的 **LongMemEval-S cleaned 全部 500 题**，固定版本和 SHA-256。运行生产 SQLite FTS5 BM25，会话粒度、Top5，分别报告完整会话与仅用户消息两种模式。

完整步骤、数据来源、指标和限制见 [LongMemEval 使用教程](LONGMEMEVAL_CN.md)；实际结果见 [测试报告](../../docs/LONGMEMEVAL_TEST_REPORT_CN.md)；实现结构见 [Memory Eval 与共享实验底座](<../../docs/Memory Eval 与共享实验底座.md>)。

## 快速开始

在 `MemoryCore` 目录执行，需要 Node.js ≥22.16：

```powershell
npm install --ignore-scripts --legacy-peer-deps --no-audit --no-fund
npm run eval:memory -- download-longmemeval
npm run eval:memory -- validate
npm run eval:memory -- run
```

直连不可达时显式添加 `--mirror`，仍严格校验官方哈希。数据已经下载时只需最后两行。`run`、不带子命令和 `longmemeval` 均运行同一官方数据评测；不会访问生产库或调用模型 API。

## 命令与配置

| 命令 | 用途 |
|---|---|
| `download-longmemeval [--mirror]` | 下载或核验固定官方文件 |
| `validate` | 校验官方文件字节数、SHA-256、500 题和数据结构 |
| `run` / `longmemeval` | 全量 500 题 × 两种模式 |
| `longmemeval --limit 3` | 前 3 题冒烟，明确标记为子集 |
| `validate-traces --file <文件>` | 检查共享 trace 契约 |
| `--help` | 显示可用命令 |

默认配置：[configs/longmemeval-s.json](configs/longmemeval-s.json)。`--config` 可指定复制后的配置；文件中的路径相对于配置文件目录。输出写到新的 `eval/runs/longmemeval-.../`，官方原始数据保存在 Git 忽略的 `eval/private/longmemeval/`。

## 验证与共享契约

```powershell
npm run typecheck:eval
npm run test:eval
npm run eval:memory -- validate-traces --file eval/examples/trace-examples.jsonl
```

单元测试中的微型边界夹具只验证解析、评分和隔离，不是可运行的 benchmark 数据集，不产生评测成绩。CI 运行这些离线测试与 trace 校验，不自动下载 277 MB 数据；全量测试按上方命令显式执行。

[schema.ts](schema.ts) 保留 Memory Retrieval、Tool Decision、Skill Coding 的独立 trace 契约；[报告模板](examples/report-template.md)和 [trace 示例](examples/trace-examples.jsonl)说明共享日志格式。后两套件未实现模型运行器或评分器，不混入检索成绩。

旧 `run/longmemeval` 命令不运行记忆抽取、Dense/Hybrid 或回答生成；这些由显式 `system --live` 命令实现。旧检索指标不能表述为论文端到端问答准确率。
