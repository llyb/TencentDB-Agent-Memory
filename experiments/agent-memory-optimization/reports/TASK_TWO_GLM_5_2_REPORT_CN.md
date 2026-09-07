# 任务二：Skill 整链路优化实验报告（glm-5.2）

> 日期：2026-09-06  
> 数据集：OpenAI HumanEval（固定提交 `6d43fb980f9fee3c892a914eda09951f772ad10d`）  
> 模型：本地 `glm-5.2`；向量模型：本地 `bge-m3`

## 1. 结论

HumanEval 开发集三 seed 的结果不支持“Skill 生成越多越好”。生产默认阈值在短单轮任务上完全不触发；将触发阈值降至 512B 后，在线积累方案把 pooled pass@1 从 69.51% 提升到 78.05%（+8.54 个百分点），但包含蒸馏的平均总 Token 从 2624.44 增至 3014.40（+14.86%）。这是一条成功率换成本的曲线，而不是同时提高成功率并降低 Token 的 Pareto 改进。

注入侧的结论更明确：严格 BM25 单条注入相较 topK=3，在同一冻结 Skill 集上使 pass@1 高 9.76 个百分点、平均总 Token 低 10.23%；后者虽把命中率从 83.33% 提升至 91.67%，却降低任务通过率。因此命中率不能脱离任务正确率和成本单独优化。

最终建议保持现有生产默认触发值，新增参数能力和保守生命周期治理，但不把 HumanEval 专用的 512B 阈值设为全局默认。需要优先成功率的同类短 coding 流程可显式启用 512B 触发；需要控制成本的通用生产流量应少生成、严格路由，并用业务任务重新校准阈值。

## 2. 评测设计

- 164 道 HumanEval 按数字 task ID 排序，偶数 ID 为 dev、奇数 ID 为 test，各 82 题；所有参数只在 dev 决定。
- 模型只接收 prompt，不接收 canonical solution、测试代码或未来任务内容。
- 每个任务生成一次 completion，pass@1 使用官方 `evaluate_functional_correctness`。
- 官方执行器运行在无网络、限制内存/CPU/PID、丢弃 capabilities 的 Docker 容器中。
- 每个 seed 内任务顺序固定；在线积累实验严格串行，Skill 只能流向后续任务。
- 平均总 Token 包含求解、抽取和 embedding/routing 的 provider usage；Turn 定义为求解交互轮数。
- Skill 命中只统计其完整内容被后续任务注入的 Skill；仅出现在目录元数据中不计命中。

## 3. 实现范围

### 3.1 提取侧

- 解耦归档缓冲大小、触发字节阈值、请求压缩阈值和 transcript 预算，修复“改一个参数牵动全部内部预算”的问题。
- 提供 `legacy` / `evidence` 抽取 Prompt；evidence 版本要求可复用证据、适用边界、验证方式和无价值时不创建。
- 提供 `head_tail` / `structured` transcript 策略；结构化策略保留初始目标、最终结果及完整相邻 tool-call/tool-result 对。
- 补充抽取耗时、候选数、原始/入选 transcript 字符数和策略版本 telemetry。

HumanEval runner 的抽取是一次结构化请求，没有生产抽取 Agent 的 tool-calling 循环；因此本数据集无法识别 `maxIterations=2/4/8/16` 的差异。实现保留了独立旋钮，但没有用不可观测的结果下调生产默认值。所有 HumanEval transcript 也远小于 40K，结构化截断的收益仅由单元测试验证，不能计为本轮模型指标提升。

### 3.2 注入侧

- 让 `charBudgetPercent` 真正解析为 listing 字符预算，并记录实际 budget used。
- listing 按完整 Skill 条目装箱，不再对 XML 文本直接切片。
- 增加 repo/path/language/version scope 过滤；历史无 scope 的 Skill 保持兼容。
- 支持 BM25、真实本地 embedding 和 hybrid 的冻结快照可归因比较，并增加低相关拒绝阈值。

### 3.3 机制侧

- 新 Skill 写入来源任务、抽取时间和 scope provenance。
- 写入前执行规范化名称和保守近义名称查重；重复项要求 view 后 update/patch，而不是继续 create。
- 使用本地 `bge-m3` 对冻结快照做语义去重，阈值 0.78；M1 将 37 条 Skill 去重为 35 条。
- 所有新增行为均保留向后兼容默认值，不把开发集专用参数直接写成生产默认。

## 4. 开发集结果

### 4.1 全量在线积累（82 题 × 3 seeds）

| 组 | pass@1 | 平均总 Token | 平均 Turn | Skill 提取率 | Skill 命中率 |
|---|---:|---:|---:|---:|---:|
| S0 无 Skill | 171/246 = 69.51% | 2631.59 | 1.00 | — | — |
| S1 生产默认 | 171/246 = 69.51% | 2624.44 | 1.00 | 0/246 = 0 | — |
| S2 512B + evidence + BM25 top1 | 192/246 = 78.05% | 3014.40 | 1.00 | 93/132 = 70.45% | 50/93 = 53.76% |

S1 的 246 条 telemetry 中归档触发、提取和注入均为 0，因此它等价于另一轮无 Skill 生成。S0/S1 pooled pass@1 相同，Token 差为 -0.27%，应视为运行波动。

真实 S0 transcript 字节分布中，512B 可触发 43/82，768B 可再触发 11/82，1024B 仅再触发 1/82，40KB 为 0。校准后选择 512B，是因为它能形成足够的在线 Skill 累积样本；这不是通用生产阈值。

### 4.2 冻结快照注入比较（后 41 题 × 3 seeds）

路由方式先在 seed=1 的同一 12 条快照上比较：

| 路由 | pass@1 | 平均总 Token | Skill 命中率 |
|---|---:|---:|---:|
| BM25 | 33/41 = 80.49% | 2622.24 | 10/12 = 83.33% |
| embedding (`bge-m3`) | 28/41 = 68.29% | 3123.05 | 8/12 = 66.67% |
| hybrid | 31/41 = 75.61% | 2868.44 | 6/12 = 50.00% |

embedding/hybrid 的 routing Token 真实计入，不是 SQLite BM25 fallback。该任务形态最终选择 BM25。

注入量在 seed=1 上的受控比较：

| 配置 | pass@1 | 平均总 Token | Skill 命中率 |
|---|---:|---:|---:|
| BM25，topK=1，阈值 0.05，预算 0.5% | 33/41 = 80.49% | 2618.80 | 10/12 = 83.33% |
| BM25，topK=3，阈值 0.01，预算 1% | 29/41 = 70.73% | 2886.63 | 11/12 = 91.67% |

### 4.3 S3/S4/S5 公平后半段比较（41 题 × 3 seeds）

| 组 | pass@1 | 平均总 Token | 平均 Turn | Skill 提取率 | Skill 命中率 |
|---|---:|---:|---:|---:|---:|
| S0 同题无 Skill | 72/123 = 58.54% | 2967.10 | 1.00 | — | — |
| S1 同题生产默认 | 79/123 = 64.23% | 2890.07 | 1.00 | 0 | — |
| S2 同题在线积累 | 87/123 = 70.73% | 3487.67 | 1.00 | — | — |
| S3 冻结快照 + 严格注入 | 86/123 = 69.92% | 2859.72 | 1.00 | — | 26/37 = 70.27% |
| S4 M1 去重快照 + 严格注入 | 86/123 = 69.92% | 2813.80 | 1.00 | — | 24/35 = 68.57% |
| S5 M1 快照 + 在线提取 + 严格注入 | 90/123 = 73.17% | 3517.72 | 1.00 | 62/78 = 79.49% | 39/97 = 40.21% |

S4 相比 S3 保持相同 pass@1，同时平均总 Token 降低 1.61%，说明去重首先改善的是冗余和成本。S5 相比 S4 提高 3.25 个百分点，但 Token 增加 25.02%，且命中率下降 28.37 个百分点；继续在线大量生成的边际效率较差。

由于本地模型即使 temperature=0 仍存在重复运行差异，S0 与 S1 同题结果也不同。以上结果适合做工程选型，不应解释为严格统计显著性结论。

## 5. 锁定测试集

测试配置在查看 test 结果前锁定：

```yaml
triggerBytes: 512
toolCallThreshold: 999
extractionPrompt: evidence
routing: bm25
routingThreshold: 0.05
topK: 1
charBudgetPercent: 0.005
lifecycle: dev snapshot embedding-dedup@0.78; test online append-only
```

测试组使用各 seed 对应的开发集前半段 M1 去重快照作为可迁移知识，随后在 82 道奇数 ID 测试题上顺序求解和在线提取。快照来源与 test 完全不重叠。实验 runner 的 test 在线写入为 append-only；生产路径另有更保守的名称查重，因此测试结果不把该生产查重的收益计入。

<!-- TEST_RESULTS_START -->
| 组 | pass@1 | 平均总 Token | 平均 Turn | Skill 提取率 | Skill 命中率 |
|---|---:|---:|---:|---:|---:|
| S0 无 Skill（246 题） | 168/246 = 68.29% | 2753.04 | 1.00 | — | — |
| S5 锁定组合（246 题） | 182/246 = 73.98% | 3190.81 | 1.00 | 98/119 = 82.35% | 59/133 = 44.36% |

锁定组合相较 S0 提高 5.69 个百分点，但平均总 Token 增加 15.90%；测试结果与 dev 的方向一致，仍属于成功率换成本。三 seed 的 S5 pass@1 分别为 73.17%、73.17%、75.61%，没有根据 test 结果调整参数。
<!-- TEST_RESULTS_END -->

## 6. 失败案例与边界

- HumanEval/94、106、118（seed=1）分别注入 `closest-pair-by-sorting`、`sorted-two-pointer-triplet-sum`、`shortest-palindrome-prefix` 后仍未通过，说明检索命中不等于方法适用或实现正确。
- HumanEval/86、88、96（seed=2）分别注入 `compare-by-aggregate`、`closest-pair-by-sorting`、`compare-by-aggregate` 后仍未通过；应靠更强适用性拒绝，而不是提高 topK。
- HumanEval 是单轮函数补全，平均 Turn 固定为 1，无法证明多轮 coding Agent 的 Turn 降幅。
- 开发集方法型 Skill 对测试集的可迁移程度有限；结论不外推到仓库级 issue 修复。
- S4 的 embedding 去重为离线快照治理，生产写路径采用更保守的名称查重，避免 embedding 误合并造成不可逆信息损失。

## 7. 推荐配置与上线策略

1. 合入参数解耦、结构化 transcript、完整条目 packing、scope/provenance、telemetry 和保守查重，它们修复了伪旋钮与不可观测问题。
2. 保持通用生产默认 `toolCallThreshold=10`、`bytesThreshold=40KB`、BM25、`topK=20`、1% 预算，以避免由 HumanEval 短任务分布直接改变线上行为。
3. 为短 coding 专用实验配置使用 512B、BM25 top1、阈值 0.05、0.5% 预算；上线前必须在实际仓库任务重测。
4. 优化目标若要求 pass@1 与 Token 同时改善，则本轮没有可宣布的 Pareto 胜出配置；应报告权衡，不包装为双赢。

## 8. 简历描述条目

- **Agent Skill 整链路优化：** 基于 HumanEval 164 题、3 seeds 和本地 `glm-5.2`/`bge-m3` 搭建“触发—提取—路由—注入—生命周期”可归因评测链路，修复注入预算伪旋钮与条目截断，引入结构化轨迹、scope/provenance、路由拒绝及近义去重；开发集将在线 Skill 方案 pass@1 从 69.51% 提升至 78.05%（+8.54pp），并通过严格 top1 注入相较宽松 top3 将平均总 Token 降低 10.23%、pass@1 提升 9.76pp，量化得出“少而准优于多生成/多注入”的配置结论。

这条描述有意不声称 Turn 下降，也不声称相对无 Skill 同时降低 Token；两者均不被本次 HumanEval 数据支持。
