# 使用 LongMemEval 官方数据测试

本入口对作者发布的 **LongMemEval-S cleaned 全部 500 题**运行本项目生产 SQLite FTS5 BM25。它是公开数据上的会话级检索测试；没有运行 LLM 抽取、Dense/Hybrid、回答生成或 QA Judge，不等于论文的端到端准确率。

官方来源：

- [论文配套仓库](https://github.com/xiaowu0162/LongMemEval)
- [固定版本的数据集](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/tree/98d7416c24c778c2fee6e6f3006e7a073259d48f)
- [固定版本的检索代码](https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/src/retrieval/run_retrieval.py)
- [官方评分函数](https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/src/retrieval/eval_utils.py)

## 1. 下载和执行

从仓库根目录进入 MemoryCore；需要已安装项目依赖和 Node.js ≥22.16。

```powershell
cd MemoryCore
npm install --ignore-scripts --legacy-peer-deps --no-audit --no-fund
npm run eval:memory -- download-longmemeval
npm run eval:memory -- longmemeval
```

如果 Hugging Face 直连不可达，使用镜像传输，同样严格校验官方 SHA-256：

```powershell
npm run eval:memory -- download-longmemeval --mirror
npm run eval:memory -- longmemeval
```

上述命令在 PowerShell/Bash 中通用。下载后重复测试只需最后一行，不再访问网络，不需要模型凭证。下载工具不会自动切换镜像；用户显式加 `--mirror` 才使用 `hf-mirror.com`。文件已存在时重新核验，不覆盖或盲信缓存。失败的 `.download` 临时文件不参与测试，确认不用后可以删除。

固定数据文件为 `longmemeval_s_cleaned.json`，大小 **277,383,467 字节**，SHA-256：

```text
d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442
```

文件保存到 `eval/private/longmemeval/`，已被 Git 忽略。它不是只有答案会话的 oracle 文件，也不是更大的 M 版本。入口拒绝其他版本和手工裁剪文件；需要新版本时应明确更新数据来源与测试协议，不绕过校验。

## 2. 为什么运行两种模式

默认配置 `eval/configs/longmemeval-s.json` 的 `roles` 为 `all` 和 `user`：

| 模式 | 索引内容 | gold 与排除规则 | 全量相关性指标分母 |
|---|---|---|---:|
| all | 每个会话的 user+assistant 全部正文 | `answer_session_ids`，排除 30 条 `_abs` 拒答题 | 470 |
| user | 每个会话仅 user 正文，按空格连接 | 遵循作者 flat retrieval 的标签处理；再排除没有 user `has_answer` 的题 | 419 |

原版检索程序将没有用户侧证据的 `answer...` session 标签变成 `noans...`，使用保留下来的 answer 标签作为 gold，并在汇总时排除完全没有用户侧证据的题目。cleaned 版本中有 **51 条非拒答题**因此排除。这里复现该标签/分母规则，但检索器使用本项目 FTS5，而不是原版的 `rank_bm25.BM25Okapi`；不可声称完全复现了论文 BM25 数值。

all 模式保留 assistant 历史，适合检查项目对完整会话的检索表现。两种模式的分母和文本不同，不能只根据总均值的差异宣称某模式更强。论文的回答准确率需要另跑回答模型和官方 Judge，本入口没有该成绩。

30 条拒答题仍执行检索并保留日志，但不进入 Recall/MRR/nDCG 的分母。它们仅报告“是否仍返回记录”的代理指标，不把这个比例当作实际错误回答率。

## 3. 防泄漏和原始数据保留

- 每个问题、每种角色模式各建一份独立的内存 SQLite，测试后关闭。不会把其他题目的历史混入，也不会访问生产库。
- 检索索引只接受选定角色的原始正文。问题只在搜索时提供；参考答案、`answer_session_ids` 和 `has_answer` 不进入索引或排序。
- 不根据 gold 挑选历史，不截断会话，不使用 oracle 数据；保留全部干扰项。
- 原始 session ID 含有 `answer` 的提示性命名，因此数据库主键使用与标签无关的哈希；原始 ID 只出现在来源映射和评分阶段，不参与 FTS 正文。
- 13 题有重复的原始 session ID，保留所有位置并生成不同 record ID。Top5 的重复会话占据其原始排名位置，不事后扩大 TopK；计算 evidence Recall 时用集合去重。
- 76 题包含晚于 `question_date` 的历史，共 1475 个会话位置。本公开数据入口按官方文件保留，不做静默清洗，并单列 `no_future_history` 子集。**保留官方历史不证明这些数据满足严格因果时间评测。**
- 源日期未指定时区。保留原字符串，同时将墙上时间格式化为可排序的 ISO 字符串；其中 Z 是存储替代表示，不宣称原始时间属于 UTC。日期未被追加为检索关键词，也没有时间重排。

为复用项目真实检索链路，整段会话被写入临时 L1 表。**这些记录是原文会话文档，不是经过 LLM 抽取的 L1 原子记忆。** 本测试不衡量抽取、摘要、合并或画像质量。

## 4. 指标和输出

每题、每模式一行，共 1000 条结果。正常运行每 25 题打印进度，最终给出 `eval/runs/longmemeval-.../` 目录。

| 文件 | 内容 |
|---|---|
| `report.md` | 主结果、分类结果、分母和限制 |
| `run.json` / `config.resolved.json` | 运行身份、实际配置、官方数据固定版本与哈希 |
| `samples.jsonl` | 固定的 500 个 question ID、原始问题、答案和 gold session ID |
| `results.jsonl` | 1000 条排名、候选、指标、排除原因与耗时 |
| `record-map.jsonl` | 每条 record 到原始 session 位置、消息下标、内容哈希的映射 |
| `trace.jsonl` | 与此前评测底座兼容的逐次检索 trace |
| `summary.json` | 两种模式分别按全量、原始 question_type、无未来时间子集聚合 |
| `source-files.json` | 实际源码逐文件哈希 |
| `upstream-verification.json` | 可选的官方 Python 函数逐题交叉验证结果 |

主指标：

- `recall_at_5`：Top5 覆盖的不同 gold 会话数 / 全部 gold 会话数。
- `hit_at_5`：至少召回一个 gold，即官方 `recall_any@5`。
- `recall_all_at_5`：是否召回全部 gold，即官方 `recall_all@5`，不能与分数型 Recall 混用。
- `mrr_at_5`：第一条正确记录的倒数排名，超过 5 或未召回为 0。
- `ndcg_at_5`：使用官方函数的折扣形式，**第 1 和第 2 位权重都是 1**，不是另一种常见的 DCG 定义。
- `candidate_recall`：实际生产候选 Top15 的 gold 覆盖率，用于区分候选缺失和排序截断。

置信区间按 question ID bootstrap 2000 次；不是模式差值的配对显著性检验。检索计时不含建库；建库耗时另记。状态 error 不进入均值，且使 `comparable=false` 和 CLI 非零退出；排除原因也独立统计，避免改变分母后只展示均值。

`snapshot_hash` 标识“官方原始文件 + 固定构建方式 + 角色选择 + 固定题目列表”的快照构建规则，每题实际索引内容另有 `corpus_hash` 和记录正文哈希。不会把动态模型抽取混进同一个快照。

## 5. 快速冒烟与单独模式

先运行原文件前 3 题，输出会标记为冒烟子集：

```powershell
npm run eval:memory -- longmemeval --limit 3
```

需要单独 user-only 或完整会话模式时，复制配置，只保留 `roles` 中的一项，然后：

```powershell
npm run eval:memory -- longmemeval --config eval/configs/your-longmemeval-config.json
```

配置内路径相对于配置文件目录。TopK 固定为 5，只有 session 粒度、BM25 策略。本入口只接受固定版本的官方原始文件，不会在每题生成语义向量。

## 6. 用官方函数核验

`vendor/longmemeval/eval_utils.py` 来自已固定的作者提交，原文件未修改，附 MIT 许可。可选校验器需要 Python ≥3.11 和 NumPy：

```powershell
python -m pip install numpy
python eval/verify-longmemeval.py --run eval/runs/<本次目录名> --data eval/private/longmemeval/longmemeval_s_cleaned.json
```

校验器重新读取官方数据，独立推导 gold 和排除规则，逐一检查原始会话位置、选定角色的正文哈希与消息映射，再调用作者原版 `evaluate_retrieval` 核对 recall-any、recall-all、nDCG。成功后创建 `upstream-verification.json`，不覆盖已有核验结果。

NumPy 2 删除了 `asfarray`，校验器只为该旧接口提供同等的 float 数组转换，不更改官方指标逻辑。单元测试使用小型虚构夹具，不联网，也不依赖 277 MB 原始数据：

```powershell
npm run test:eval
npm run typecheck:eval
```

实际公开集结果见 [LongMemEval 测试报告](../../docs/LONGMEMEVAL_TEST_REPORT_CN.md)。本项目只保留此官方数据集作为 Memory Retrieval 评测数据。
