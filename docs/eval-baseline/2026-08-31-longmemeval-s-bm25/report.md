# LongMemEval-S 官方数据检索测试

Run: longmemeval-2026-08-31T06-26-05-642Z-3ef6c67c

数据：[作者发布的 cleaned S](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/tree/98d7416c24c778c2fee6e6f3006e7a073259d48f)；全部 500 题。
SHA-256: `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`
源码哈希：`a444d1eb803521a8a2847d5259b20d8515359e591e78cd7d157d96d2dfbfb2f9`；配置哈希：`6db0117eeee1ef77db8455309f7738c4740b780961fe3e11d638f163c8b6e758`。

## 口径

- all：索引每个会话的 user+assistant 原文，以 answer_session_ids 为会话级 gold；排除拒答题。
- user：复用官方 flat retrieval 的 user-only 文本和用户证据筛选规则，额外排除没有用户证据的题目。
- 两种模式均使用本项目生产 SQLite FTS5 BM25，不是官方 rank_bm25 实现；没有 L1 模型抽取、语义 Embedding 或回答生成。
- 单题单库，保留全部干扰会话；不索引问题、参考答案、has_answer 或 gold ID。Top5 会话记录中重复的原始 session ID 占据原位置，证据命中用集合去重。
- 原始时间没有时区，按原始墙上时间解析；Z 仅用于存储和排序，不声称源数据是 UTC。按官方给定历史保留晚于 question_date 的会话，单列 no_future_history 子集。
- recall_all@5、recall_any@5（即 Hit@5）、nDCG@5 参照官方 eval_utils；nDCG 第二位权重也是 1。Recall@5/MRR@5 为本项目补充诊断指标。

## 主结果

| 模式 | 总题数 | 计分/应计分 | Recall@5 | Hit@5 | MRR@5 | Recall-all@5 | nDCG@5 | 候选 Recall |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| all | 500 | 470/470 | 0.91652 | 0.97234 | 0.91755 | 0.83830 | 0.88928 | 0.96996 |
| user | 500 | 419/419 | 0.89805 | 0.94749 | 0.87414 | 0.83771 | 0.86544 | 0.94674 |

## 分类结果

| 模式 | 类别/子集 | 计分题数 | Recall@5 | MRR@5 | Recall-all@5 |
|---|---|---:|---:|---:|---:|
| all | single-session-user | 64 | 1.00000 | 0.96016 | 1.00000 |
| all | multi-session | 121 | 0.83802 | 0.92218 | 0.66942 |
| all | single-session-preference | 30 | 0.86667 | 0.66056 | 0.86667 |
| all | temporal-reasoning | 127 | 0.88478 | 0.88307 | 0.76378 |
| all | knowledge-update | 72 | 0.98611 | 0.97569 | 0.97222 |
| all | single-session-assistant | 56 | 1.00000 | 1.00000 | 1.00000 |
| all | no_future_history | 401 | 0.90931 | 0.90939 | 0.83042 |
| user | single-session-user | 64 | 1.00000 | 0.97656 | 1.00000 |
| user | multi-session | 121 | 0.85579 | 0.87948 | 0.72727 |
| user | single-session-preference | 30 | 0.76667 | 0.55389 | 0.76667 |
| user | temporal-reasoning | 127 | 0.86404 | 0.83648 | 0.79528 |
| user | knowledge-update | 72 | 0.98611 | 0.97222 | 0.97222 |
| user | single-session-assistant | 5 | 1.00000 | 0.90000 | 1.00000 |
| user | no_future_history | 350 | 0.88510 | 0.85590 | 0.82000 |

## 异常、耗时与不确定性

- all：排除={"abstention":30}，运行错误=0，完整可比=true。
- all：Recall@5 95% CI=[0.8960992907801423,0.9350000000000002]；MRR@5 CI=[0.8959574468085104,0.9374113475177305]；按问题 bootstrap（非策略差值检验）。
- all：检索 P50/P95=1.55970/2.78720 ms；建库 P50=55.41670 ms。
- all：候选遗漏=32题，排序遗漏=57题；两者可重叠。拒答题无支持返回率=1.00000，n=30；不是答案拒答率。
- user：排除={"abstention":30,"no_user_evidence":51}，运行错误=0，完整可比=true。
- user：Recall@5 95% CI=[0.8706443914081144,0.9214797136038188]；MRR@5 CI=[0.84502784407319,0.9004375497215592]；按问题 bootstrap（非策略差值检验）。
- user：检索 P50/P95=0.90340/1.51530 ms；建库 P50=12.97130 ms。
- user：候选遗漏=35题，排序遗漏=43题；两者可重叠。拒答题无支持返回率=1.00000，n=30；不是答案拒答率。
- 原始数据中包含未来墙上时间的题目：76；会话位置总数：1475。
- 原始 session ID 重复的题目：13。未静默清理、去重或替换官方数据。

## 复现

在 MemoryCore 目录执行：

```powershell
npm run eval:memory -- download-longmemeval --mirror
npm run eval:memory -- longmemeval
```

下载脚本固定官方版本和校验值；--mirror 仅改变下载地址，必须通过官方 SHA-256。完整数据保存在 eval/private，不纳入 Git。
逐题列表 samples.jsonl；每模式一行结果 results.jsonl；完整记录来源映射 record-map.jsonl；共享 trace.jsonl；配置和源码指纹见 run.json/config.resolved.json/source-files.json。
没有运行 QA Judge，不报告论文的端到端回答准确率；本结果仅衡量官方数据上的会话检索。
