# LongMemEval 官方数据测试报告与使用教程

日期：2026-08-31。对应合并后的「方向一：评测驱动的记忆 RAG 召回与排序优化」中的会话检索基线；[研究路线与评测边界](PROJECT_OPTIMIZATION_RESEARCH_AND_RESUME_CN.md)已更新，实现说明见 [Memory Eval 与共享实验底座](<Memory Eval 与共享实验底座.md>)。

本次已完成 **LongMemEval-S cleaned 全量 500 题、两种会话模式共 1000 条检索记录**，运行错误为 0。完整会话模式的 Recall@5 为 **0.91652**、MRR@5 为 **0.91755**；遵循作者用户侧文本及标签规则的模式分别为 **0.89805 / 0.87414**。作者原版评分函数的独立逐题核验通过。

这些结果衡量本项目的 **SQLite FTS5 BM25 会话检索**。没有运行 LLM 记忆抽取、Dense/Hybrid、回答生成或 QA Judge；不能将其表述为论文端到端准确率，也不代表检索优化收益。执行器直接使用 L1 搜索函数，尚未覆盖真实 L1 抽取快照、L0 搜索入口、L2/L3 注入及 Agent 工具决策，因此也不是整个记忆系统的效果报告。

## 1. 数据来源与固定版本

使用 [LongMemEval 论文配套仓库](https://github.com/xiaowu0162/LongMemEval)链接的作者维护数据集，[固定版本见此](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/tree/98d7416c24c778c2fee6e6f3006e7a073259d48f)。这是作者维护的 cleaned 版本，不声称与论文最初发布文件逐字相同。

| 项目 | 本次取值 |
|---|---|
| 数据集 | `xiaowu0162/longmemeval-cleaned` |
| 数据 revision | `98d7416c24c778c2fee6e6f3006e7a073259d48f` |
| 文件 | `longmemeval_s_cleaned.json`，277,383,467 字节 |
| SHA-256 | `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442` |
| 作者代码 commit | `9e0b455f4ef0e2ab8f2e582289761153549043fc` |
| 数据/代码许可 | MIT；随附作者评分代码及许可 |
| 本地保存位置 | `MemoryCore/eval/private/longmemeval/longmemeval_s_cleaned.json`，Git 忽略 |

实际使用镜像传输，因为直连下载不可达；下载后的字节数和 SHA-256 均与官方 LFS 元数据一致。镜像只解决传输，不改变数据来源或版本。使用完整 S 文件，包括所有干扰会话；没有使用 oracle 文件、手工挑选答案会话或抽样后冒充全量。

原文件包含 500 个唯一 question ID、23,867 个会话位置、246,750 条消息，其中 user 消息 122,416 条。包含 12 条空正文、71 个无用户消息的会话，以及 13 个含重复 session ID 的问题，适配器全部保留。

## 2. 实现与测试协议

新增 [官方数据适配器](../MemoryCore/eval/longmemeval-data.ts)、[执行与报告入口](../MemoryCore/eval/longmemeval.ts)、[默认配置](../MemoryCore/eval/configs/longmemeval-s.json)和[独立 Python 核验器](../MemoryCore/eval/verify-longmemeval.py)，复用方向一已有的配置、源码哈希、trace 和真实生产检索链路。

每个问题、每种模式各建独立的内存 SQLite，只装入该题的全部历史会话。每个会话作为一条原文文档写入临时 L1 表，执行生产 `executeMemorySearch` 与 `VectorStore`；不会访问或修改生产数据库。这里使用 L1 表作为存储容器，**并未把会话转成模型抽取的原子记忆**。

| 模式 | 索引与 gold 定义 | 执行题数 | 纳入相关性评分 | 排除原因 |
|---|---|---:|---:|---|
| all | user+assistant 正文，gold 为 `answer_session_ids` | 500 | 470 | 30 条拒答题 |
| user | 仅 user 正文，复现作者 flat retrieval 的 gold 标签与过滤规则 | 500 | 419 | 30 条拒答题；另 51 条无用户侧证据 |

user 模式按[作者检索程序](https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/src/retrieval/run_retrieval.py)处理 `answer/noans` 标签，并排除没有用户侧 `has_answer` 的问题。51 条额外排除题均属于 single-session-assistant。因此两种模式的均值并非相同样本分母上的配对比较。

本项目检索使用 Jieba 搜索分词与 SQLite FTS5 BM25，作者原版使用 `rank_bm25.BM25Okapi` 及空格分词。**复现的是数据、用户侧标签规则和评分函数，不是原版 BM25 排名实现或论文成绩。**

固定 TopK=5，生产候选上限为 15，bootstrap 2000 次，随机种子 20260831。全量测试没有依成绩挑选样本、调参或重新排序。原始 session ID 有提示答案的命名，因此数据库使用不含标签的哈希 ID；索引只含正文，不包含问题、参考答案、`has_answer` 或 gold ID。来源映射只用于审计与评分。

会话重复 ID 保留为多个独立位置，不静默去重。返回的重复会话仍占用 Top5 的排名位置；证据覆盖率按 gold 会话集合计算。完整会话、选定消息下标与正文哈希均有归档，可从 record ID 追溯到官方原文件。

## 3. 全量结果

以下是问题级宏平均。Recall@5 表示 gold 会话覆盖比例；Hit@5 表示至少命中一条；Recall-all@5 表示全部 gold 均在 Top5。三者不可混用。

| 模式 | 有效题数 | Recall@5 | Hit@5 | MRR@5 | Recall-all@5 | nDCG@5 | 候选 Recall@15 |
|---|---:|---:|---:|---:|---:|---:|---:|
| all | 470 | 0.91652 | 0.97234 | 0.91755 | 0.83830 | 0.88928 | 0.96996 |
| user | 419 | 0.89805 | 0.94749 | 0.87414 | 0.83771 | 0.86544 | 0.94674 |

| 模式 | Recall@5 的 95% CI | MRR@5 的 95% CI | 检索 P50 / P95 | 建库 P50 |
|---|---|---|---|---|
| all | [0.89610, 0.93500] | [0.89596, 0.93741] | 1.55970 / 2.78720 ms | 55.41670 ms |
| user | [0.87064, 0.92148] | [0.84503, 0.90044] | 0.90340 / 1.51530 ms | 12.97130 ms |

区间按 question ID 重采样；没有对模式差异做配对显著性检验。时延为本机顺序运行的进程内测量，检索不含建库和文件下载，也不代表网络服务或生产并发延迟。

本次最终批次从 06:26:05.644Z 至 06:26:47.650Z（北京时间 14:26）完成，日志内运行窗口约 42.0 秒，不包含下载、进程启动前工作与随后 Python 核验。1000 条结果的排名、候选与评分均与此前官方全量运行一致；归档使用当前代码生成的源码指纹和运行标识。

### 按原始问题类型拆分

| 问题类型 | all 有效题数 | all Recall@5 | all MRR@5 | user 有效题数 | user Recall@5 | user MRR@5 |
|---|---:|---:|---:|---:|---:|---:|
| single-session-user | 64 | 1.00000 | 0.96016 | 64 | 1.00000 | 0.97656 |
| multi-session | 121 | 0.83802 | 0.92218 | 121 | 0.85579 | 0.87948 |
| single-session-preference | 30 | 0.86667 | 0.66056 | 30 | 0.76667 | 0.55389 |
| temporal-reasoning | 127 | 0.88478 | 0.88307 | 127 | 0.86404 | 0.83648 |
| knowledge-update | 72 | 0.98611 | 0.97569 | 72 | 0.98611 | 0.97222 |
| single-session-assistant | 56 | 1.00000 | 1.00000 | 5 | 1.00000 | 0.90000 |

主要薄弱点是偏好问题的排名，以及多会话问题的完整证据覆盖。all 模式 multi-session 的 MRR 为 0.92218，但 Recall-all 只有 0.66942：很快找到一条正确会话，并不意味着找齐回答所需材料。user 模式该类 Recall-all 为 0.72727。较高的 knowledge-update 检索分数也不能证明回答模型会采用更新后的事实。

### 时间数据与拒答边界

原文件 76 题含晚于 `question_date` 的历史，共 1475 个会话位置。本次遵循官方提供的完整历史，不删除这些内容、不补造时区、不加入时间重排。原始日期没有时区；内部 ISO 的 Z 只是可排序的墙上时间替代表示，不主张原始日期为 UTC。

另报告没有此类历史的 `no_future_history` 子集：

| 模式 | 子集有效题数 | Recall@5 | MRR@5 | Recall-all@5 |
|---|---:|---:|---:|---:|
| all | 401 | 0.90931 | 0.90939 | 0.83042 |
| user | 350 | 0.88510 | 0.85590 | 0.82000 |

这只是原始数据的诊断切片，不是通过截断历史得到的新 benchmark，也不能证明严格因果时间评测成立。

30 条拒答题全部实际执行检索，两种模式均在 30/30 题返回了记录；这里只能说关键词检索没有拒绝返回候选。没有回答生成和证据充分性判断，**不能把这一比例叫作幻觉率、错误回答率或拒答准确率**。

## 4. 错误分类与可追溯案例

| 模式 | 至少一项 gold 未进入候选的题数 | gold 已进候选但在 Top5 外的题数 |
|---|---:|---:|
| all | 32 | 57 |
| user | 35 | 43 |

两类按“问题是否发生该错误”计数，同一道题可同时出现，所以不可直接相加为失败总题数。所有原文会话位置都已写入索引；本次没有测量 LLM 抽取造成的写入遗漏。

| question ID / 模式 | 问题概要 | 实测证据位置与错误 |
|---|---|---|
| `75832dbd` / all | 根据历史兴趣推荐出版物或会议 | 唯一 gold `answer_d87a6ef8` 排在候选第 6，候选覆盖率 1，但 Top5 Recall 为 0。属于截断/排名问题。 |
| `6d550036` / all | 汇总已领导或正在领导的项目数量 | 4 个 gold 中一个排第 4，两个排第 9、14，另一个未进 Top15。Recall@5=0.25、候选 Recall=0.75，同时有漏召回和排名问题。 |
| `gpt4_e061b84f` / user | 按时间列出最近参与的三场体育活动 | 3 个 gold 中两个排第 11、13，另一个未进 Top15。Top5 完全未命中，候选 Recall=2/3。 |

案例可在归档的 [逐题结果](eval-baseline/2026-08-31-longmemeval-s-bm25/results.jsonl)与[固定问题清单](eval-baseline/2026-08-31-longmemeval-s-bm25/samples.jsonl)按 question ID 联查。由这些结果推断，后续应分别验证语义候选召回与排序/上下文选取；单靠给候选加时间分数，无法修复候选中根本没有的证据。这是后续实验假设，本次尚未测得任何重排收益。

## 5. 验证与可复现证据

- `npm run typecheck:eval`：通过。
- `npm run test:eval`：2 个文件、15 个测试通过，包括官方适配的 12 项测试和共享契约/置信区间的 3 项测试。
- 全量运行：500 个唯一问题 × 2 模式，1000 条结果，无运行错误。
- [独立核验结果](eval-baseline/2026-08-31-longmemeval-s-bm25/upstream-verification.json)：1000 行通过原始数据、位置、正文哈希、消息映射和分母重建检查；470/419 条计分题的 recall-any、recall-all、nDCG 与作者原版函数逐题一致，容差为 1e-12。
- 原版 [eval_utils.py](https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/src/retrieval/eval_utils.py)随 MIT 许可保存在 `MemoryCore/eval/vendor/longmemeval/`，文件 SHA-256 为 `c98b8d1096877a15aa755c9de44fe33c195298466a2eb6f3c0f9f6bde8c72349`。

官方 nDCG 的第 1、2 位权重同为 1。本实现与交叉核验保留该定义，未替换成另一种常见折扣公式。NumPy 2.3.5 中仅为已移除的 `asfarray` 补充等价数组转换，不改作者评分源码。

| 运行标识 | 值 |
|---|---|
| run_id | `longmemeval-2026-08-31T06-26-05-642Z-3ef6c67c` |
| repo_commit | `50f33f52217a540111f56f43c385acb319c964f6`，工作区有未提交修改 |
| source_hash | `a444d1eb803521a8a2847d5259b20d8515359e591e78cd7d157d96d2dfbfb2f9` |
| config_hash | `6db0117eeee1ef77db8455309f7738c4740b780961fe3e11d638f163c8b6e758` |
| snapshot_hash | `826fa99b2bba767fd824800c063985e22c0a339c42c7d304c6584fd44e874374` |
| 运行环境 | Windows x64，Node v24.18.0，tsx 4.23.13，Jieba 2.0.2，sqlite-vec 0.1.7-alpha.2，zod 4.5.4 |

`snapshot_hash` 标识官方原文件、构建规则、角色模式和固定题单；每题实际文档内容另存 `corpus_hash`。因为代码尚未提交，不能仅凭 HEAD 复现，应同时保留当前实现和 `source-files.json`。跨机器的依赖版本、绝对配置路径或源码改变可能改变身份哈希；时延也可能变化。

完整归档见 [产物说明与校验清单](eval-baseline/2026-08-31-longmemeval-s-bm25/README.md)。逐题结果、trace、配置、源码哈希、汇总和官方核验结果均已保留。31.75 MB 的来源映射无损压缩为约 4.68 MB；原始 277 MB 数据不放入代码归档，可按固定 revision 和 SHA 下载。

## 6. 使用教程

完整参数、数据约束与输出解释见 [LongMemEval 使用教程](../MemoryCore/eval/LONGMEMEVAL_CN.md)。以下命令从仓库根目录开始；需要 Node.js ≥22.16。

```powershell
cd MemoryCore
npm install --ignore-scripts --legacy-peer-deps --no-audit --no-fund
npm run eval:memory -- download-longmemeval
npm run eval:memory -- longmemeval
```

直连失败时，显式选择镜像，仍按官方哈希校验：

```powershell
npm run eval:memory -- download-longmemeval --mirror
npm run eval:memory -- longmemeval
```

本工作区已经下载并验证了官方文件，**再次全量测试只需**：

```powershell
npm run eval:memory -- longmemeval
```

最后一行输出本次 `eval/runs/longmemeval-.../` 目录。先读其中 `report.md`，然后查看 `summary.json` 中的 `full_dataset`、`completed_rows`、`failed` 和各模式 `eligible`；本次应分别为 true、1000、false、470/419。运行每 25 题打印进度；中断目录不会被当作已完成结果。

快速检查前 3 题可用 `npm run eval:memory -- longmemeval --limit 3`，该结果会标记为子集。仅测一个模式时，复制 `eval/configs/longmemeval-s.json`，把 `roles` 改为 `["user"]` 或 `["all"]`，再用 `--config` 指定新文件。不要手工裁剪原始 JSON；下载入口和加载器都会核对固定版本。

可选的官方评分交叉检查需要 Python ≥3.11 和 NumPy，将下面占位路径替换成刚输出的新运行目录：

```powershell
python -m pip install numpy
python eval/verify-longmemeval.py --run eval/runs/<本次目录名> --data eval/private/longmemeval/longmemeval_s_cleaned.json
```

核验成功会创建 `upstream-verification.json`；为了保留审计记录，已有文件不会被覆盖。默认测试不调用任何远程模型，不需要 API Key；首次下载之后可离线执行。Dense/Hybrid 和端到端 QA 应作为另一个有明确模型、费用、向量快照与 Judge 配置的实验，不能套用本报告的成绩。
