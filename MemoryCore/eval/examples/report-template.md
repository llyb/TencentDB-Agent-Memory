# 实验报告模板（未运行，不是实验结果）

## 实验身份

填写 run_id、config_hash、model、repo_commit、source_hash、prompt_version、数据与快照哈希、运行环境、trace 路径。

## 受控变量

说明只改变什么、固定什么、开发/测试划分、失败与降级如何统计。

## 分套件结果

仅填写本次实际执行的套件；未执行的项标记“未执行”，不填零分。

| 套件 | 指标 | 样本分母 | 结果及不确定性 | 状态 |
|---|---|---|---|---|
| Memory Retrieval | Recall@5 / Hit@5 / MRR@5 / 时间子集 | 有证据且目标策略成功的问题 | 待测 | 未执行 |
| Tool Decision | 触发召回 / 误调用 / 工具选择 / 注入 Token | 正例、负例分别统计 | 待测 | 未执行 |
| Skill Coding | pass@1 / 全阶段 Token / turn / Skill 读取 | 全部任务及共同成功子集 | 待测 | 未执行 |

不构造跨套件综合分。Skill 的 cached_input_tokens 是 input_tokens 的子集，不能重复相加；单独列提取、压缩和执行成本。

## 错误分析

列出 sample_id、实际 trace、预期行为、失败归因、是否有环境错误或策略降级。

## 使用与复现

给出数据版本、配置路径、执行命令、输出目录、可重复的结果范围，以及未验证的边界。
