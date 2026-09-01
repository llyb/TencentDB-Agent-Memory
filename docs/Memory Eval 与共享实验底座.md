# Memory Eval 与共享实验底座

方向一已升级为“完整记忆系统评测与 Embedding 检索效果验证”。本文保留旧会话检索基线及共享契约的说明；新增真实 L0/L1/L2/L3、Embedding 对照与回答评测见 [完整系统教程](../MemoryCore/eval/SYSTEM_EVAL_CN.md) 和 [系统测试报告](MEMORY_SYSTEM_TEST_REPORT_CN.md)。评测只使用作者发布的 LongMemEval-S cleaned 官方数据：旧组件基线运行全部 500 题，系统运行规模由预先固定的分层配置决定，不能混淆分母。范围见 [研究路线](PROJECT_OPTIMIZATION_RESEARCH_AND_RESUME_CN.md)，旧成绩见 [LongMemEval 测试报告](LONGMEMEVAL_TEST_REPORT_CN.md)。

## 实现范围

| 组成 | 实现与边界 |
|---|---|
| 官方数据 | 固定 revision、文件大小和 SHA-256；保留全部历史会话及干扰项 |
| 会话索引 | 每题、每种角色模式各建独立内存 SQLite；正文之外的 gold 标签不参与索引 |
| 真实检索链路 | 复用生产 VectorStore 与 executeMemorySearch，SQLite FTS5 BM25，Top5、候选上限 15 |
| 来源追溯 | record ID → 原始 session 位置、消息下标、正文哈希；保留重复会话位置 |
| 指标 | Recall、Hit、MRR、Recall-all、作者定义的 nDCG、候选覆盖率、分组和置信区间 |
| 错误归因 | 区分候选遗漏、排名截断、运行错误和指标排除；拒答题单独统计 |
| 运行身份 | 保存配置、数据与快照哈希、源码逐文件哈希、逐题结果和 trace |
| 官方核验 | 独立读取原始数据与标签，调用作者原版 Python 评分函数逐题交叉检查 |

整段会话被写入临时 L1 表以复用检索接口，这不是模型抽取的原子记忆快照。当前成绩不包含写入抽取质量、Dense/Hybrid 或回答生成准确率。

## 代码入口

| 文件 | 职责 |
|---|---|
| [cli.ts](../MemoryCore/eval/cli.ts) | 官方数据下载、验证、运行及 trace 校验 |
| [longmemeval-data.ts](../MemoryCore/eval/longmemeval-data.ts) | 官方版本、数据结构、会话索引和 gold 规则 |
| [longmemeval.ts](../MemoryCore/eval/longmemeval.ts) | 执行、逐题评分、聚合与报告 |
| [retrieval.ts](../MemoryCore/eval/retrieval.ts) | 隔离 SQLite 和捕获生产候选 |
| [metrics.ts](../MemoryCore/eval/metrics.ts) | 均值、分位数和按问题 bootstrap |
| [schema.ts](../MemoryCore/eval/schema.ts) | 运行身份与各套件独立 trace 契约 |
| [verify-longmemeval.py](../MemoryCore/eval/verify-longmemeval.py) | 官方评分与数据映射独立核验 |

Memory Retrieval、Tool Decision 和 Skill Coding 共享运行标识和日志封装，分开计分，不构造综合分。Tool Decision 与 Skill Coding 目前只保留契约和报告模板，没有模型运行器或评分器。

## 使用

在 `MemoryCore` 目录执行：

```powershell
npm run eval:memory -- download-longmemeval
npm run eval:memory -- validate
npm run eval:memory -- run
```

默认和 `run` 入口均指向 [longmemeval-s.json](../MemoryCore/eval/configs/longmemeval-s.json)；`longmemeval` 是同义入口。下载后可离线复测，不需要模型凭证。详细镜像、单模式、冒烟与 Python 核验步骤见 [LongMemEval 教程](../MemoryCore/eval/LONGMEMEVAL_CN.md)。

CI 执行评测代码类型检查、24 项离线测试及共享 trace 示例校验，不将边界测试夹具当作评测数据，也不自动下载官方文件或调用模型 API。旧官方全量会话基线成绩与产物见 [归档说明](eval-baseline/2026-08-31-longmemeval-s-bm25/README.md)。
