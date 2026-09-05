# TencentDB Agent Memory 两项优化详细设计方案（待审阅）

> 文档日期：2026-09-04  
> 代码基线：`50f33f5`  
> 当前状态（2026-09-04）：**任务一已按审阅范围完成本地实现，并使用本地 `glm-5.2` 完成 P0/P3 三 seed 回放；任务二仍只有方案，未修改代码。**  
> 指标边界：任务一结果只评价首次资产工具决策，不评价工具返回内容、最终回答或 coding 任务成功率。

## 1. 先给结论

这两个任务不应被处理成“把 Prompt 写短一点”和“把 `topK` 从 20 改成 5”两次参数修改。更有价值、也更适合写入简历的做法是建立两条可复现实验链路：

1. **任务一：建立四指标评测基线，并对工具描述和注入结构做受控优化。** 使用有效调用率、误调用率、工具选择正确率、注入 Token 量评价每个 Prompt 版本；通过合并重复内容、精简工具描述和明确正负触发条件降低注入成本，同时重排静态/动态内容以保证 prompt cache 前缀稳定。
2. **任务二：围绕“触发 → 提取 → 注入 → 生命周期”整条 Skill 链路做可归因优化。** 提取侧比较触发阈值、抽取 Prompt、迭代次数和 Transcript 截断；注入侧比较路由方式与注入预算；机制侧检查 Skill 的生成、更新、去重、失效和淘汰是否合理。统一使用 SWE-bench，并以 pass@1、平均总 Token、平均 Turn、Skill 提取率和 Skill 命中率评价优化效果。

对“Skill 多生成好还是少生成好”的明确回答是：

> **不预设“越多越好”或“越少越好”。** 在 pass@1 不下降的前提下，比较不同提取率对应的命中率、平均总 Token 和平均 Turn，选择综合成本最低的配置。

建议按六个小 PR 推进，而不是一次性重构整条链路：

| 顺序 | PR | 目的 | 是否改变生产行为 |
|---|---|---|---|
| 0 | 评测集、四指标评分器、基线回放 | 先让指标可信 | 否 |
| 1 | Proxy 提示词工程 | 合并重复、精简描述、优化触发条件 | 是，仅 Prompt |
| 2 | Prompt cache 稳定注入结构 | 固定前缀并保证 block metadata 完整 | 是，注入/序列化链路 |
| 3 | Skill 评测基线与参数生效检查 | 建立 SWE-bench 基线并确认旋钮真实生效 | 否 |
| 4 | Skill 提取侧与注入侧消融 | 分别定位 Token、Turn 和命中的主要影响因素 | 是，按实验结果拆分 |
| 5 | Skill 机制优化 | 优化生命周期，并给出最佳配置和完整报告 | 是，按实验结果决定 |

## 2. 范围和不做的事情

### 2.1 本方案覆盖

- Proxy 中 Memory、Skill、Knowledge 三类能力的描述、触发边界、调用先决条件与注入位置。
- Prompt cache 的前缀稳定性、block metadata 保真和真实 cache usage 验证。
- Skill 的归档触发、轨迹整理、抽取、更新、去重、检索、注入、失效和淘汰。
- 基于 SWE-bench 的真实模型回放、同仓任务累积实验和统计口径。
- PR 拆分、风险控制、验收条件与最终简历表述模板。

### 2.2 第一阶段明确不做

- 不评价 Memory、Skill、Knowledge 返回内容本身是否正确，只评价模型是否在正确时机调用正确工具。
- 不直接引入向量数据库或训练 reranker；先确认 BM25 的召回是否真是瓶颈。
- 不做论文方案的迁移实现，也不把公开论文中的结论或提升数字写成项目结果；同类调研只用于比较机制差异。
- 不把静态 Token 下降当作“任务效果提升”。
- 不在没有基线数据时宣称某组阈值是“最佳配置”。
- 不为了动态相关性每轮重写 system prompt；这会与前缀缓存目标冲突。

## 3. 当前代码链路与实际问题

以下判断来自基线 `50f33f5`，也是后续实验必须锁定的起点。

### 3.1 Proxy 注入链路

| 模块 | 当前行为 | 问题 |
|---|---|---|
| `tdai-tools-injector.ts` | 在 `system.suffix` 注入 6 个 Memory curl 模板及约束，`session_init` 缓存 | 描述较长，与 guide 有重复；操作细节和决策规则混在一起 |
| `tdai-profile-memory-injector.ts` | 注入 L2/L3 画像，同时无论有没有画像都会加入 `<memory-tools-guide>` | 同一调用边界在多个块重复，且动态画像与静态规则耦合 |
| `skill-tools-injector.ts` | 在 `system.before_tools` 注入 Skill 的 curl、错误码和 CRUD 规则 | 错误恢复信息过细；读路径和写权限规则没有按优先级组织 |
| `skill-injector.ts` | 会话初始化时注入可用 Skill 列表，文案要求“部分相关也应加载” | 容易在纯 coding 任务中误调用；检索 query 主要来自 Agent/Task 描述，而不是当前用户 query |
| `knowledge-tools-injector.ts` | 注入 code graph/wiki 描述以及 `tools/list → tools/call` 协议 | 触发边界、发现协议、鉴权和错误处理混成大块，压缩时容易误删关键先决条件 |
| `pipeline.ts` | 语义 anchor 命中后重建 system 文本 | 当前重建会把多个 block 合成单一 text block，可能丢失原 block 的 `metadata/cache_control` |

这里有一个容易误解的缓存要求：发布新 Prompt 时，旧 Prompt 与新 Prompt 的字节前缀不同，旧缓存失效一次是必然的。我们能保证的是：**新版本在同一配置下跨轮次保持稳定，首次 warm-up 后能够持续复用，而不是让两个不同版本共享同一缓存键。**

### 3.2 Skill 真实链路

| 题面参数或模块 | 基线中的真实行为 | 对方案的影响 |
|---|---|---|
| `toolCallThreshold=10` | `add-handler.ts` 只统计 `tool_call`，或消息超过约 40KB 后归档 | 阈值代表“对话较长”，不代表“任务成功且值得提炼” |
| `head=8000/tail=32000` | 这是 `SkillExtractor` 裸构造回退；生产 resolved config 把 `headChars/tailChars` 都派生为 `archiveBytes` | 不能只改构造器默认值并宣称生产生效 |
| `maxIterations=16` | 抽取 Agent 最多进行 16 轮 tool-calling | 上限过大可能浪费 Token，但直接降到 2 也可能来不及查重和更新，必须看实际迭代分布 |
| `searchTopK=20` | listing handler 确实读取该配置 | 是有效旋钮，但其效果会同时受到字符预算影响 |
| `charBudgetPercent=0.01` | `skill-handlers.ts` 没有消费该字段；请求没有 `char_budget` 时直接使用 8000 字符 | 当前是“伪旋钮”，扫描这个参数不会改变注入结果 |
| listing 截断 | 对完整 XML 字符串直接 `slice` | 可能切断一条 Skill，使模型看到不完整名称或描述 |
| `skill-fast-path.ts` | 文件明确标注未接入 | 不应在此文件修改后宣称路由已优化 |
| SQLite hybrid | embedding/hybrid 路径实际回退 BM25 | 本地实验写 `hybrid` 不等于真的比较了混合检索 |
| TCVDB hybrid | 支持实际 dense/hybrid，但后端约束与 SQLite 不同 | 报告必须记录存储后端，不能混合统计 |
| `prefixSkillsLimit` | 生产默认 20；当总量超过限制时，会额外调用一次 LLM 生成检索 query | 前置 Skill 太多会增上下文，太少又会增加查询调用或重复创建 |

因此，任务二的顺序应是：**先在 SWE-bench 上建立当前链路基线并确认参数真实生效，再分别优化提取侧、注入侧和机制侧，最后做整链路组合实验。**

## 4. 任务一：Proxy 系统提示词注入优化

任务一只研究三件事：建立四指标测试基线、构建 prompt cache 前缀稳定的注入结构、对现有工具描述进行系统化提示词工程。不在本任务中扩展通用工具调用 benchmark、多轮 Agent 状态评测、工具检索算法或自动 Prompt 优化器。

### 4.1 研究一：构建测试数据集并建立评测基线

#### 4.1.1 评测边界

本任务只评价“注入的工具描述能否让模型在正确时机选择正确工具”。模型调用工具后立即结束该样本，不评价工具返回资产的质量，也不把参数执行、最终答案质量或任务完成率加入任务一指标。

每条样本只有四种 gold：

```text
memory | skill | knowledge | none
```

- `memory`：当前上下文不足，必须查询用户历史、偏好、过去决定或跨会话状态；
- `skill`：必须查找已有的团队/仓库操作流程、SOP 或验证步骤；
- `knowledge`：必须查询团队知识库、wiki 或与当前 repo 匹配的代码图谱；
- `none`：当前对话和代码上下文已经足够，不应该调用以上三类资产工具。

所有题目都应提供完成决策所需的基本信息，避免把“是否应该先追问”混进本任务。若样本本身有歧义，应在数据审阅阶段修改或删除。

#### 4.1.2 数据集规模与构成

第一版建议构建 200 条样本，dev/test 各 100 条。相同问题模板的所有改写必须放在同一 split，避免根据 dev 措辞调整 Prompt 后在 test 中遇到近乎相同的句子。

| 类别 | Dev | Test | 主要覆盖内容 |
|---|---:|---:|---|
| Memory 正例 | 20 | 20 | 用户历史、偏好、上次决定、跨会话状态 |
| Skill 正例 | 20 | 20 | 仓库 SOP、发布流程、固定验证步骤、团队约定的操作方法 |
| Knowledge 正例 | 20 | 20 | wiki、设计文档、代码关系图、团队知识资产 |
| None 负例 | 40 | 40 | 纯 coding、公共知识、当前源码已有答案、术语误触发 |

`none` 比单个正例类别更多，是因为任务明确要求避免纯 coding 场景误调用。负例中至少一半应为 hard negative，而不是与工具毫无关系的简单问题。

hard negative 具体包括：

- `memory allocator`、缓存、堆内存等包含 memory 词但与用户历史无关的 coding 请求；
- 类名、函数名或变量名中出现 `Skill`、`KnowledgeBase`；
- “记得补一个测试”中的“记得”只是自然语言命令；
- 用户说“继续修改”，但所需上下文已经完整包含在当前会话；
- 当前已打开源码能够直接回答，不需要代码图谱；
- 问题涉及通用 TypeScript、SQL 或 Git 知识，而不是团队内部知识；
- Skill 列表中有关键词相似项，但请求只是普通代码实现；
- 同一句请求同时出现 database、cache、memory 等容易误导模型的技术术语。

每条数据建议采用以下最小结构：

```json
{
  "case_id": "T1-none-001",
  "template_family": "memory-terminology-negative",
  "messages": [],
  "enabled_families": ["memory", "skill", "knowledge"],
  "expected_family": "none",
  "reason": "memory 表示内存管理，不需要查询用户历史"
}
```

其中 `reason` 用于人工复核，不直接提供给被测模型。正例还要准备固定的工具返回 fixture，但评分在第一次资产工具调用出现时即可完成，避免把资产质量带入本实验。

#### 4.1.3 四项指标的唯一口径

任务一只报告以下四项核心指标：

1. **有效调用率**

```text
在 memory/skill/knowledge 正例中实际调用了任一注入工具的样本数
÷ 全部正例样本数
```

它回答“该调用时有没有调用”。即使调用了错误工具，也算发生了调用，但会在工具选择正确率中扣分。两个指标分开后，才能区分“模型过于保守”和“模型愿意调用但选错工具”。

2. **误调用率**

```text
在 none 样本中调用了任一注入工具的样本数
÷ 全部 none 样本数
```

它重点衡量纯 coding 和术语 hard negative 是否被注入内容干扰。

3. **工具选择正确率**

```text
正例中首次调用的工具家族与 expected_family 一致的样本数
÷ 正例中实际发生工具调用的样本数
```

调用 Memory 的具体 endpoint 仍可以记录到错误分析中，但任务一的主指标只判断 Memory/Skill/Knowledge 家族是否正确，防止指标范围扩张。

4. **注入 Token 量**

```text
Memory 工具描述
+ Memory guide/画像包装
+ Skill 工具描述与 available_skills 包装
+ Knowledge 工具描述
```

动态画像正文和具体 Skill 内容受用户数据影响，应分别报告，不与“工具描述 Token”混成一个数。正式结果使用目标模型实际 tokenizer 或 API usage；字符数只能作为开发阶段快速检查，不能替代 Token 指标。

#### 4.1.4 基线运行方法

P0 使用基线 commit `50f33f5` 的原始注入内容。固定以下条件：

- 相同 system prompt 主体、工具开关、agent adapter 和工具返回 fixture；
- 相同模型版本、温度和最大输出长度；
- 每条样本从新会话开始，防止前一条样本污染下一条；
- 每个模型至少运行 3 个 seed，报告均值以及逐类别原始计数；
- 原始 trace 保存首次工具调用、未调用结果、输入 Token 和 Prompt 版本 hash。

数据集先做双人或两轮独立复核：第一轮检查 gold 是否唯一，第二轮只看 query 判断是否能在不查看 `reason` 的情况下得到相同标签。无法一致判断的样本不进入 test。

### 4.2 研究二：构建 prompt cache 前缀稳定的工具注入结构

参考 [Anthropic Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) 的核心原则：缓存依赖序列化后的相同前缀。这里只采用“稳定前缀”的工程原则，不增加额外评测指标；cache 正确性通过结构测试和真实请求验证。

#### 4.2.1 目标结构

工具描述、用户画像和每轮动态召回不能交错排列。建议把 system 注入划分为两层，把逐轮内容移出 system：

```text
System 静态前缀（同一 Prompt 版本和工具开关下完全固定）
├── <asset-tool-routing>
├── <tdai_memory_tools>
├── <skill_tools>
└── <knowledge_tools>                 [cache breakpoint A]

System 会话快照（session_init 时生成，此后会话内固定）
├── <tdai_profile_memory>
└── <available_skills>                [cache breakpoint B]

User/Message 动态区
└── 每轮 L1 recall 或其他 query-dependent 内容
```

设计理由：

- 静态工具说明放在最前面，画像或 Skill 列表发生变化时，不会改变它们之前的前缀；
- 画像和 available skills 只在 session 初始化时取一次，会话内不因每条 query 改写；
- 当前 query 相关的召回放在 user/message 区域，不回写 system；
- Memory、Skill、Knowledge 仍为独立块，某类能力关闭时可以单独省略，不需要重写一个巨大混合块。

`breakpoint A` 用于复用跨会话不变的静态工具前缀；`breakpoint B` 用于复用当前会话内不变的画像和 Skill 目录。实际 adapter 不支持两个缓存点时，至少保留静态前缀的 breakpoint A，并通过能力检测选择降级路径，不能静默改变 block 顺序。

#### 4.2.2 稳定性规则

1. 固定 injector 注册顺序、priority 和最终 block 顺序，不能依赖对象遍历或网络返回顺序。
2. 静态块内容由 `prompt_version + enabled_tool_set` 决定；同一组合必须字节一致。
3. cache breakpoint 只放在明确的块边界，不能由某个动态 renderer 随机决定。
4. 动态列表在渲染前使用稳定排序，例如 score 相同时按 name/id 排序。
5. 不向静态块写入时间戳、trace ID、session ID、随机数或本轮 query。
6. Prompt 文案更新时显式提升 `prompt_version`；新版本首次 cache miss 是正常现象。
7. prewarm 命中和 cache miss 后的 self-heal 必须生成完全相同的会话快照。
8. adapter parse→inject→serialize 必须保留原 block 的 metadata 和 `cache_control`。

#### 4.2.3 对现有 pipeline 的具体处理

当前 `pipeline.ts` 在语义 anchor 路径中会把 system 内容重建成单一 text block。这可能使 adapter 已解析出的 block metadata 丢失。批准实施后，PR2 需要：

- 在原 block 结构上定位 anchor，而不是先把全部 block 拼成一个字符串；
- 只拆分或替换实际命中的 text block；
- 未命中的 text/non-text block 原样保留；
- 新注入块携带自己的稳定 metadata；
- 不改变原有 `cache_control` 的位置和值；
- 对不支持结构化 system block 的 adapter 使用明确的降级序列化路径。

#### 4.2.4 Cache 验证

Cache 不增加第五个任务指标，但必须通过以下工程验收：

- 同一 Prompt 版本、相同工具开关，两次序列化的静态前缀 byte-for-byte 相同；
- 相同 session 的不同用户 query 不改变 system 会话快照；
- parse→inject→serialize 后原 block 数量、相对顺序和 metadata 保持；
- 首次真实请求允许创建缓存，第二次相同前缀请求必须产生 cache read；
- 修改画像或 Skill 库后，当前 session 前缀不热更新，新 session 才读取新快照；
- Prompt 升版后首次 miss、随后命中，证明版本切换行为符合预期。

这些结果写入 cache 专项测试记录，不与有效调用率、误调用率、工具选择正确率和注入 Token 量合成总分。

### 4.3 研究三：对工具描述进行提示词工程

提示词工程不能直接从旧 Prompt 删到一个“看起来更短”的版本。建议采用“信息盘点→去重→标准化→触发边界→Token 压缩→dev 回放”的固定流程。

#### 4.3.1 第一步：盘点每条信息并分类

先把五个 renderer 的每一句拆入表格，标记为：

| 类型 | 含义 | 处理原则 |
|---|---|---|
| 触发规则 | 什么时候应该/不应该调用 | 必须保留，但只保留一份 |
| 工具边界 | Memory/Skill/Knowledge 的区别 | 必须保留并集中表达 |
| 必需参数 | endpoint、method、必填 body/header | 必须保留最短可执行形式 |
| 前置条件 | repo match、先 list 后 call、写权限 | 必须保留，不能因压缩删除 |
| 恢复规则 | 鉴权失败、版本冲突、未找到 | 只保留模型可以采取行动的分支 |
| 示例 | 演示请求或返回 | 只有能消除歧义时保留一个 |
| 重复说明 | 已在其他块表达的规则 | 删除或改为单一引用 |
| 装饰性文字 | 背景介绍、鼓励性措辞、同义反复 | 删除 |

这个信息表同时作为 review checklist。每删除一条必需约束，都必须说明由哪个新位置承接。

#### 4.3.2 第二步：合并重复内容

当前最明确的重复是 `<tdai_memory_tools>` 与 `<memory-tools-guide>` 都描述 Memory 的调用时机和限制。建议：

- 删除独立 `<memory-tools-guide>`；
- 把 Memory 与其他工具的选择边界集中到一个短 `<asset-tool-routing>`；
- `<tdai_profile_memory>` 只保存画像与索引，不再追加工具使用规则；
- 每个工具族的 base URL、通用 header、JSON 约定只写一次；
- 具体 endpoint 只写相对路径、method 和必填字段；
- `available_skills` 只列 Skill metadata，不重复 `skill_view/search` 的完整用法。

去重版本单独作为 P1。P1 不改变原有触发语义，目的是测出“机械去重”能节省多少 Token，以及是否意外丢失约束。

#### 4.3.3 第三步：统一最小工具描述模板

每个工具或工具组只保留以下结构：

```text
Name: 稳定名称
Use: 一句话说明能获取什么缺失信息
Call when: 一句话正触发条件
Do not call when: 一句话最容易混淆的负条件
Requires: 必需前置条件和必填参数
Call: 一条最短且可执行的 curl 模板
```

不重复写“你可以使用这个工具”“请在合适的时候调用”等没有判别信息的句子。返回字段只描述会影响下一步选择的字段，不复制完整响应 schema。

#### 4.3.4 第四步：明确三个工具族的触发边界

公共路由块控制在短表格或 6–8 行内：

| 工具族 | 应调用 | 不应调用 |
|---|---|---|
| Memory | 需要用户过去的事实、偏好、决定、跨会话状态 | 当前对话已有信息；代码中的 memory/cache 术语 |
| Skill | 明确需要已有团队/仓库 SOP、固定操作步骤或验证方法 | 普通 coding；模型自己可以从当前源码推导的方法 |
| Knowledge | 明确需要团队 wiki、设计文档或匹配当前 repo 的代码关系数据 | 公共知识；本地源码已经足够；repo 不匹配 |

措辞遵循两个原则：

- “必须、总是、优先”只用于安全和调用前置条件，不用来推销某个工具；
- 先说明“不需要工具时直接编码”，再说明三个正触发条件，降低纯 coding 误调用。

#### 4.3.5 第五步：逐块精简

**Memory 工具块**

- 6 个 endpoint 保留，但每个只写功能、路径、必填 body；
- L0/L1/L2/L3 用四行选择表代替多段解释；
- tenant/session header 提到一次；
- 删除重复的“不要编造”“相关时必须调用”等同义句，只在公共约束保留一次；
- 错误处理压缩为：鉴权失败停止、未找到不编造、可恢复错误最多重试一次。

**Skill 工具块**

- 先写只读主路径：`available_skills → skill_view`，未命中且明确需要 SOP 时 `skill_search`；
- manifest/files 只有正文引用资源时才读取；
- 写工具说明只在当前 agent 有写权限时注入；
- 版本冲突统一写成“重新 view 最新版本后使用 expected_version 重试”；
- 删除长错误码清单和重复 curl 结构。

**Available Skills 块**

- 每条只放 `name + 一句 description`；若已有 scope，则增加最短 repo/path 信息；
- 删除“部分相关也必须加载”“宁可多加载”等扩大调用范围的措辞；
- description 中的换行和装饰性 Markdown 清理掉；
- 总预算不足时只加入完整条目，不能切断半条。

**Knowledge 工具块**

- 保留 code graph 的 repo match，这是正确调用的核心边界；
- 保留 `tools/list → tools/call` 顺序，这是协议要求；
- wiki 与 code graph 的适用范围各用一句话；
- 公共 header 和 telemetry 只写一次；
- 删除重复示例、完整返回体和不能指导恢复的错误码。

#### 4.3.6 第六步：分版本实验，避免无法归因

| 版本 | 只改变什么 | 目的 |
|---|---|---|
| P0 | 当前基线 | 得到四项基线指标 |
| P1 | 合并重复内容 | 测机械去重的 Token 收益和行为影响 |
| P2 | P1 + 最小工具描述模板 | 测描述结构化和进一步精简的影响 |
| P3 | P2 + 正负触发边界优化 | 测有效调用率、误调用率和选择正确率变化 |

Prompt cache 结构改造不作为 P4 混入四指标实验，而是独立 PR2。这样 P1–P3 的行为变化来自提示词工程，cache 改造只负责前缀稳定与 metadata 保真。

Prompt 只能根据 dev 集错误修改，test 集在最终版本确定前保持封存。每次改动记录：删除了什么、为什么删除、由什么内容承接、对应修复哪个 dev 失败案例、Token 变化是多少。

#### 4.3.7 暂定选择标准

最终版本必须同时展示四项指标，不建立掩盖权衡的综合分数。暂定门槛：

- 注入 Token 量相对 P0 至少降低 30%；
- 有效调用率相对 P0 不下降超过 3 个百分点；
- 误调用率相对 P0 不上升超过 3 个百分点，并优先选择误调用更低的版本；
- 工具选择正确率相对 P0 不下降超过 3 个百分点。

如果 P3 的 Token 更低但有效调用率或工具选择正确率下降超过门槛，应恢复造成退化的具体触发句，而不是整体回滚或继续盲目压缩。

### 4.4 具体代码落点（批准后才修改）

| 文件 | 拟修改内容 |
|---|---|
| `MemoryProxy/src/injection/injectors/tdai-tools-injector.ts` | Memory 描述去重、最小调用模板和公共路由规则 |
| `MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts` | 删除重复 guide，只渲染画像/索引 |
| `MemoryProxy/src/injection/injectors/skill-tools-injector.ts` | 精简 curl/错误信息，保留读写权限、资源顺序和版本恢复 |
| `MemoryProxy/src/injection/injectors/skill-injector.ts` | 收紧触发措辞，渲染紧凑且完整的 Skill metadata |
| `MemoryProxy/src/injection/injectors/knowledge-tools-injector.ts` | 精简描述，保留 repo match 与 `list→call` 协议 |
| `MemoryProxy/src/injection/index.ts` | 固定静态工具块与会话快照的注册顺序 |
| `MemoryProxy/src/injection/pipeline.ts` | 独立 PR 做 block-preserving 注入，确保缓存 metadata 不丢失 |
| 各 adapter 测试 | 校验 block 顺序、metadata、cache_control 和序列化前缀稳定 |

## 5. 任务二：Skill 机制优化

### 5.1 目标与边界

Skill 的目标是让模型复用同类 coding 任务中已经验证过的做法，跳过无效探索路径。任务二不预设某种论文机制或固定架构，而是从整条链路出发做实验：

```text
对话达到触发条件
  → 从 Transcript 提取或更新 Skill
  → 后续任务检索并注入相关 Skill
  → 根据复用情况更新、失效或淘汰 Skill
```

优化目标是在 SWE-bench 同仓任务序列上提高 `pass@1`，同时降低包含蒸馏开销的平均总 Token 和平均 Turn。Skill 提取率用于寻找最佳生成强度，Skill 命中率用于判断生成出的 Skill 是否真的被后续任务使用；两者都不能脱离任务效果和成本单独最大化。

为避免概念混淆，统一使用以下定义：

- **归档触发**：达到 `toolCallThreshold` 或 `bytesThreshold`，进入 Skill 提取流程；
- **Skill 提取**：本次归档最终新建或有效更新至少一条 Skill；
- **Skill 注入**：Skill 正文被放入模型上下文，或被模型通过 `skill_view` 实际读取；只出现在候选列表中不算；
- **Skill 命中**：某条已提取 Skill 在后续另一道 SWE-bench 任务中发生了 Skill 注入。

### 5.2 同类机制调研：只做对比，不做论文迁移实现

删除论文方案的逐项迁移设计。机制调研只比较现有 coding Agent/规则系统如何管理可复用上下文，不直接把外部方案转成实现任务，也不引用外部收益作为本项目预期结果。

调研对象采用原任务给出的同类方案：

| 方案 | 重点观察 |
|---|---|
| Cursor Rules | 规则的项目/路径作用域、自动附加与手动调用 |
| CLAUDE.md | 仓库级长期指令的组织方式、层级覆盖和上下文成本 |
| Windsurf Memory | 记忆的生成、可见性、更新与用户控制 |
| Cline Memory Bank | 跨任务信息如何拆分、维护和读取 |
| Aider Conventions | 仓库约定如何进入上下文以及如何控制长度 |
| Continue Context | 上下文选择、规则路由和按需加载 |
| OpenHands | Agent 轨迹、工作区上下文与任务复用方式 |

对比报告统一回答六个问题：Skill/规则由谁生成、何时生成、如何确定适用范围、如何检索和注入、如何更新或去重、如何失效或删除。调研结论只形成机制侧的实验假设，是否采用必须由 SWE-bench 指标验证。

### 5.3 提取侧优化

提取侧按“触发 → 输入整理 → 抽取 → 写入”拆分，先单变量消融，再组合最优项。

#### 5.3.1 触发条件

当前基线为 `toolCallThreshold=10`、`bytesThreshold=40KB`。实验比较不同阈值组合，回答触发过早是否产生大量低复用 Skill、触发过晚是否错过可复用过程。

建议首轮网格：

| 参数 | 候选值 |
|---|---|
| `toolCallThreshold` | 6 / 10 / 14 |
| `bytesThreshold` | 24KB / 40KB / 64KB |

两个条件仍保持 OR 语义。每组使用相同 SWE-bench 任务顺序、模型、seed 和初始空 Skill 库；不能只比较触发次数，必须比较五项主指标。

#### 5.3.2 抽取 Prompt

以当前 `SKILL_REVIEW_PROMPT` 为基线，设计两个可归因版本：

- **E1 精简版**：删除重复说明、示例和可由 schema 表达的格式要求；
- **E2 精简结构化版**：在 E1 基础上明确“可复用步骤、适用条件、验证方式、跳过原因”，允许不生成 Skill。

Prompt 优化只依据 SWE-bench 结果判断。若文本更短但 `pass@1` 或 Skill 命中率下降，则不采用；不能用 Prompt 字符数替代真实 Token。

#### 5.3.3 `maxIterations`

将当前 `maxIterations=16` 与 2 / 4 / 8 对比，记录每次抽取的真实迭代数和 Token。迭代上限与 Prompt 版本交叉实验，但先固定其他提取参数，避免把 Prompt 收益和迭代次数收益混在一起。

#### 5.3.4 Transcript 截断

比较以下策略：

- **T0 基线**：`head=8000`、`tail=32000 chars`；
- **T1 等预算结构化保留**：仍使用约 40K 字符预算，优先保留用户目标、关键 tool call/result、最终修改和验证结果；
- **T2 缩小预算**：在 T1 基础上比较 16K / 24K / 32K 字符。

结构化策略必须成对保留 tool call 与 result，长日志只保留退出码、通过/失败摘要和关键错误。截断策略最终仍由五项主指标选择，不新增“压缩率”作为优化目标。

### 5.4 注入侧优化

注入实验使用同一份冻结 Skill 快照，使路由和预算变化不会受到提取数量变化干扰。

#### 5.4.1 路由精度

依次比较：

1. 当前 BM25；
2. embedding；
3. hybrid。

实验前先确认对应后端真实执行了声明的路由模式；当前 SQLite 的 embedding/hybrid 回退 BM25，不能把 fallback 结果记为 embedding 或 hybrid。每组保留检索日志用于错误分析，但最终选择仍以五项主指标为准。

#### 5.4.2 注入量控制

同时搜索 `topK` 与 `charBudgetPercent`：

| 参数 | 候选值 |
|---|---|
| `topK` | 1 / 3 / 5 / 10 / 20 |
| `charBudgetPercent` | 0.5% / 1% / 2% / 4% |

在开始实验前必须确认 `charBudgetPercent` 已被实际消费，并记录每题最终注入的 Skill 数和 Token。注入时按完整 Skill 条目装箱，预算不足时不截断出半条 Skill。实验要覆盖“有相关 Skill”和“无相关 Skill”两类 SWE-bench 任务，允许路由返回 0 条。

### 5.5 机制侧优化

机制侧不直接采用外部论文设计，而是围绕现有 Skill 生命周期提出最小可验证改动：

| 机制问题 | 当前对照 | 待测方案 |
|---|---|---|
| 新建与更新 | 抽取 Agent 直接 CRUD | 先查重；同类 Skill 优先更新，避免近义副本 |
| 质量控制 | 达到归档阈值即可进入抽取写入 | 写入前检查是否有可复用步骤、适用条件和验证证据 |
| 适用范围 | 主要依赖名称、描述和关键词 | 增加 repo、路径、语言或版本范围，并在路由前过滤 |
| 失效与淘汰 | 缺少统一闭环 | 对长期未命中、版本不兼容或验证失败的 Skill 标记失效 |
| 可观测性 | 难以串联提取与后续使用 | 为每条 Skill 记录来源任务、提取版本和后续命中任务 |

机制侧至少保留两个对照：M0 为当前直接写入与现有生命周期，M1 为加入查重、范围、失效和审计后的方案。若需要进一步测试“候选/审核/正式”多阶段状态，应作为独立消融项，不在文档阶段预设为必选架构。

### 5.6 SWE-bench 数据集与任务组织

任务二只使用 [SWE-bench](https://github.com/princeton-nlp/SWE-bench) 数据集，并使用[官方评测 harness](https://www.swebench.com/SWE-bench/guides/evaluation/)判断补丁是否通过。HumanEval、MBPP、自建任务和论文数据集不进入任务二主实验或补充结果。

为观察 Skill 累积效应，按以下方式组织样本：

1. 选择包含多条可运行 instance 的 SWE-bench 仓库，优先保证仓库内任务数量和官方镜像可用性；
2. 在每个仓库内按固定顺序运行任务，前序任务允许提取 Skill，后序任务可以检索和使用这些 Skill；
3. 将任务序列划分为 dev 与 test；只在 dev 上选择参数，test 配置一次锁定；
4. 每个实验组从相同初始代码状态和独立空 Skill 库开始，任务顺序完全一致；
5. 固定模型、temperature、最大上下文、工具集和单题预算，至少运行 3 个 seed；
6. Skill 只能来自此前任务的真实轨迹，禁止读取 gold patch、隐藏测试答案或未来任务轨迹。

主实验采用严格时间顺序的在线累积方式。另保留一组冻结 Skill 快照的注入侧实验，仅用于隔离路由和注入预算的影响，不能替代主实验。

### 5.7 实验组与消融顺序

| 组 | 条件 | 目的 |
|---|---|---|
| S0 | 关闭 Skill 提取与注入 | 测量无 Skill 的 Agent 基线 |
| S1 | 当前生产机制与默认参数 | 测量现有 Skill 基线 |
| S2 | 仅使用提取侧最优配置 | 判断提取优化贡献 |
| S3 | 仅使用注入侧最优配置 | 判断路由与注入量贡献 |
| S4 | 仅使用机制侧最优配置 | 判断生命周期优化贡献 |
| S5 | 提取侧 + 注入侧 + 机制侧最佳组合 | 测量整条链路的最终效果 |

执行顺序：

1. 跑 S0、S1，确认 SWE-bench 环境、日志与五项指标可复现；
2. 在 S1 上分别做触发、Prompt、iterations、Transcript 单变量实验，得到 S2；
3. 冻结同一 Skill 库，比较路由、`topK` 和 `charBudgetPercent`，得到 S3；
4. 比较 M0/M1 及必要的机制消融，得到 S4；
5. 组合 S2/S3/S4 为 S5，在未参与调参的 test 序列上运行；
6. 若组合效果低于单项最优，回退并做交互项实验，不强行上线整套方案。

### 5.8 五项评测指标

任务二正式报告只使用原任务指定的五项指标：

| 指标 | 计算口径 | 方向 |
|---|---|---|
| 任务通过率 | `pass@1 = 首次 Agent 运行通过官方 SWE-bench harness 的任务数 / 总任务数` | ↑ |
| 平均 Token 消耗 | `总 Token / 总任务数`；总 Token 包含任务求解 input/output、Skill 抽取和其他产生 Token 的 Skill 链路调用，失败任务也计入 | ↓ |
| 平均 Turn 数 | 从任务开始到最终回答的 Agent 模型请求次数均值；一次模型请求记 1 turn，tool call 不单独记 turn，失败任务也计入 | ↓ |
| Skill 提取率 | `产生至少一条新建或有效更新 Skill 的归档任务数 / 触发归档的任务数` | 寻找最优值，不以越高越好 |
| Skill 命中率 | `被后续另一任务实际注入的去重 Skill 数 / 已提取的去重 Skill 总数` | ↑ |

所有比例同时报告分子、分母和 95% 置信区间；平均值同时报告标准差或 bootstrap 置信区间。这些是统计呈现方式，不增加新的优化指标。

为保证 Token 口径可比，每个 Skill 的抽取成本计入产生它的任务；如果需要展示整批任务的累积成本，则直接对整批总 Token 求和后再除以任务数，不把蒸馏开销摊到未来假设复用次数。Skill 只出现在 metadata 列表、但未注入正文或未被 `skill_view` 读取，不计为命中。

### 5.9 参数选择与“多生成还是少生成”的回答方式

参数选择使用 dev 集 Pareto 规则：

1. 优先保留 `pass@1` 不低于 S1 的配置；
2. 在剩余配置中选择平均总 Token 更低者；
3. Token 接近时选择平均 Turn 更低者；
4. 用 Skill 提取率—Skill 命中率曲线解释为什么该点优于“多生成”或“少生成”。

最终结论必须展示不同提取强度下的五项指标，而不是只给一个阈值。只有当“提高提取率”同时带来更高命中率或更好的 pass@1，并且覆盖新增蒸馏 Token 后仍降低平均总 Token，才支持多生成；否则应减少生成。推荐配置只能来自锁定 test 之前的 dev 选择，不能事后根据 test 改参数。

### 5.10 任务二交付物

1. **同类机制调研对比报告**：对比 Cursor Rules、CLAUDE.md、Windsurf Memory、Cline Memory Bank、Aider Conventions、Continue Context、OpenHands；不包含论文迁移实现；
2. **SWE-bench 实验报告**：给出 S0–S5 的五项指标、参数配置、seed、任务清单和失败案例；
3. **最佳配置结论**：明确触发阈值、Prompt 版本、`maxIterations`、Transcript 策略、路由方式、`topK`、`charBudgetPercent` 和生命周期方案；
4. **“多生成还是少生成”结论**：用提取率、命中率、pass@1、Token 和 Turn 的联合结果回答；
5. **代码 PR**：仅在方案和实验基线确认后实施；本轮只修改文档，不修改代码。

### 5.11 预期代码落点（后续实施参考）

| 文件 | 可能涉及的实验变量 |
|---|---|
| `MemoryCore/src/core/skill/skill-config.ts` | 触发阈值、iterations、Transcript、路由和注入预算配置 |
| `MemoryCore/src/core/skill/skill-extractor.ts` | 抽取入口、Prompt 版本、迭代上限和输入整理 |
| `MemoryCore/src/core/skill/skill-tools.ts` | 抽取阶段工具权限、新建/更新/查重行为 |
| `MemoryCore/src/core/skill/skill-core.ts` | Skill 更新、去重、范围、失效与审计 |
| `MemoryCore/src/core/skill/skill-fast-path.ts` | BM25 / embedding / hybrid 路由实验；接入前不得宣称生效 |
| `MemoryCore/src/core/skill/prompts/skill-review-prompt.ts` | E0/E1/E2 抽取 Prompt |
| `MemoryCore/src/core/skill/conversation-add/add-handler.ts` | 归档触发条件 |
| `MemoryCore/src/core/skill/conversation-add/extract-worker.ts` | 抽取流程与 Token/iterations 记录 |
| `MemoryCore/src/core/skill/conversation-add/worker-pool.ts` | 并发执行对实验稳定性的影响控制 |
| `MemoryCore/src/core/skill/types.ts` | 实验所需 scope、来源和命中关联字段 |

## 6. 统一评测基础设施

建议新增 `experiments/agent-memory-optimization/`，但 PR0 只加评测和 fixture，不改生产代码。

目录建议：

```text
experiments/agent-memory-optimization/
├── README.md
├── schemas/
│   ├── tool-decision-case.schema.json
│   ├── agent-run.schema.json
│   └── skill-event.schema.json
├── datasets/
│   ├── proxy-dev.jsonl
│   ├── proxy-test.jsonl
│   └── skill-task-manifest.jsonl
├── runners/
│   ├── run-proxy-eval.ts
│   └── run-skill-eval.ts
├── scorers/
│   ├── normalize-curl-trace.ts
│   ├── score-tool-decision.ts
│   └── score-skill-coding.ts
└── reports/
    └── templates/
```

每次运行至少保存：

```text
run_id, timestamp, git_commit, prompt_version, config_hash,
model/provider, temperature/seed, storage_backend,
repo_commit, case_id, pass, model_turns, tool_calls,
solve_input/solve_output/extraction/routing token,
extracted/injected skill ids, archive_triggered, trace path
```

任务一的运行记录额外保存 `expected_family`、`actual_first_family`、`did_call` 和各注入块 Token，并由 `score-tool-decision.ts` 只汇总有效调用率、误调用率、工具选择正确率和注入 Token 量四项指标。

报告生成器只读取原始 JSONL。任务二汇总器只输出 pass@1、平均总 Token、平均 Turn、Skill 提取率和 Skill 命中率，真实凭据和租户信息在采集时脱敏。

## 7. Prompt cache 专项验证

缓存修复单独成 PR 的原因是它改变 adapter/pipeline 的序列化行为，风险与文案优化不同。专项测试包括：

1. 原 system 含多个 text block 与非 text block，注入后 block 数和相对顺序保持；
2. 每个原 block 的 metadata、尤其 `cache_control` 能 parse→inject→serialize 往返；
3. 相同 session、不同用户 query 的静态工具块序列化字节完全相同；
4. 动态 L1 recall 只出现在预期的 user 点，不回写静态 system 前缀；
5. prewarm 命中和 cache miss 自愈产生相同内容；
6. 至少对 Anthropic adapter 做真实两轮 usage 验证，其他 adapter 做结构快照；
7. 新版本首次 miss 是预期行为，第二轮仍 miss 才判定失败。

如 block-preserving 改造影响某个 agent serializer，先回滚 PR2，不影响已经独立验证的 PR1 文案版本。

## 8. 计划、里程碑与每阶段交付物

### 第 1 周：基线与评测

- 冻结 commit、模型、adapter、工具返回 fixture 和数据 schema；
- 完成 200 条工具决策 dev/test 集；
- 选定 SWE-bench 仓库和固定 dev/test 任务序列，验证官方 harness；
- 跑 P0、S0、S1 基线；
- 输出原始 trace、基线报告和已知限制。

### 第 2 周：任务一 Prompt

- 实现 P1/P2/P3 renderer；
- 跑三模型或至少两模型配对回放；
- 只根据 dev 集的四项指标和错误样本恢复必要约束；
- 提交 PR1 与任务一实验报告。

### 第 3 周：缓存与 Skill 提取侧实验

- block metadata 保真和真实 cache usage；
- 确认触发阈值、`maxIterations`、Transcript 截断参数真实生效；
- 比较触发阈值、E0/E1/E2 Prompt、iterations 和 Transcript 策略，得到 S2。

### 第 4 周：Skill 注入侧实验

- 修复 `charBudgetPercent` 未生效和 Skill 条目被截断的问题；
- 冻结同一 Skill 快照，比较 BM25 / embedding / hybrid；
- 联合搜索 `topK` 与 `charBudgetPercent`，得到 S3。

### 第 5 周：机制侧与整链路实验

- 比较当前生命周期 M0 与加入查重、范围、失效和审计的 M1，得到 S4；
- 组合 S2/S3/S4，在 SWE-bench test 序列上运行 S5；
- 汇总五项指标、失败案例和最终推荐参数；
- 形成同类机制调研、实验报告、结论和后续代码 PR 计划。

## 9. 风险、降级与回滚

| 风险 | 预警信号 | 降级/回滚 |
|---|---|---|
| Prompt 过短导致漏调用 | Memory/Skill/Knowledge 的有效调用率下降 | 恢复对应正触发条件，不回滚全部压缩 |
| 触发规则过强导致误调用 | none 样本误调用率上升 | 恢复或加强对应负触发条件；不改 API 模板 |
| 工具边界过度压缩 | 工具选择正确率下降 | 恢复 Memory/Skill/Knowledge 之间的差异说明 |
| system 重排破坏 cache | 第二轮 cache read 为 0、TTFT 上升 | 单独回滚 PR2，保留 PR1 文案 |
| 提取过少 | Skill 提取率过低且后续几乎无可命中 Skill | 放宽触发阈值或恢复信息更完整的抽取 Prompt |
| 提取过多 | Skill 提取率高但命中率低、平均总 Token 上升 | 收紧触发或抽取条件，减少低复用 Skill |
| 结构化切片丢失关键信息 | pass@1 或 Skill 命中率下降 | 回退 head/tail，增加 Transcript 预算 |
| hybrid 名义生效实际 fallback | telemetry 显示 backend/mode 不一致 | 报告按后端拆分，禁止合并为 hybrid 结果 |
| Token 降低但 pass@1 下降 | 效率提升伴随更多任务失败 | 以 pass@1 为先，不接受该配置 |
| SWE-bench 任务信息泄漏 | Skill 含 gold patch、未来任务或隐藏测试信息 | 丢弃该 run，重建独立 Skill 库并重新运行 |

所有新行为都应有配置开关；提取、注入和生命周期改动分别可关闭，保证能逐项回滚到 S1。

## 10. 审阅时需要确认的决策

请重点审阅下面六项。若无特别调整，建议采用“推荐”列：

| 决策 | 推荐 | 备选及代价 |
|---|---|---|
| D1 Prompt 结构 | 静态工具前缀 + 会话快照 + user/message 动态区 | 动态内容与静态工具交错：实现简单但前缀更容易变化 |
| D2 缓存修复 | 独立 PR2 | 混入 Prompt PR：改动少一个 PR，但无法隔离行为与缓存收益 |
| D3 Skill 提取实验 | 触发、Prompt、iterations、Transcript 依次单变量消融 | 一次组合所有参数：运行少，但无法归因 |
| D4 生命周期实验 | M0 当前机制对比 M1 查重/范围/失效/审计 | 预设多阶段状态机：实现更重，且尚无指标支持 |
| D5 检索实验 | 在同一冻结 Skill 快照上比较 BM25 / embedding / hybrid | 边提取边比较：Skill 库变化会混淆结果 |
| D6 主数据集 | 只使用 SWE-bench，同仓固定顺序观察累积效应 | 不再引入自建任务、HumanEval、MBPP 或论文数据集 |

任务一已经按 **PR0（评测骨架）→ Prompt P3 → cache-stable 结构** 的审阅范围完成本地实现。正式提交 PR 前仍应使用同一模型和解码参数回放 P0/P3；任务二继续遵守“先拿到 S0/S1 基线，再分别优化提取侧、注入侧和机制侧”的顺序。

## 11. 交付报告模板

任务一最终报告必须填写真实数据：

| 版本/模型 | 有效调用率 | 误调用率 | 工具选择正确率 | 注入 Token 量 |
|---|---:|---:|---:|---:|
| P0 / glm-5.2 / 3 seeds | 100.00% | 17.50% | 91.67% | 4246 |
| P1 | 待测 | 待测 | 待测 | 待测 |
| P2 | 待测 | 待测 | 待测 | 待测 |
| P3 / glm-5.2 / 3 seeds | 98.33% | 0.00% | 100.00% | 1694 |

Prompt cache 结构以单独的工程验收清单交付，不向上表增加第五项指标。

### 11.1 任务一本地实施结果（2026-09-04）

已完成的内容：

1. 生成固定 200 条决策数据：dev/test 各 100 条，每份均为 Memory 20、Skill 20、Knowledge 20、None 40；两份使用不同的 `template_family`，None 中包含 memory/skill/cache/knowledge 代码术语 hard negative。
2. 实现统一 JSONL schema 与评分器。评分器只输出有效调用率、误调用率、工具选择正确率和注入 Token 量，并公开三个行为指标的分母。
3. 实现 P3 Prompt：新增一个公共 `<asset_tool_routing>` 决策块；Memory、Skill、Knowledge 各自只保留 endpoint、必要参数、调用顺序、权限和失败处理。删除重复的 `<memory-tools-guide>`，并移除“部分相关也必须加载 Skill”这类扩大误调用的措辞。
4. 实现 cache-stable 结构：公共规则固定在 `system.prefix`；各 injector 使用 `session_init`；缓存块带 `cacheVersion`，Prompt 版本变化时拒绝旧缓存并自愈写入；语义 anchor 只修改命中的 text block，不再把多 block system 压成一个 block，因此保留 Anthropic `cache_control` 和未命中 block 的字节内容。
5. 新增 8 个任务一专项测试；MemoryProxy 全量测试共 16 个通过。

静态 Token 夹具固定为“1 个 code-graph、1 个 wiki、1 个 Skill 列表项、Skill 只读模式”，使用 `o200k_base` 对完整注入文本计数：

| 对比 | P0 | P3 | 节省 | 降幅 |
|---|---:|---:|---:|---:|
| 静态代表性夹具 | 4468 | 1716 | 2752 | 61.59% |

真实模型回放使用 `glm-5.2`、temperature=0、seed 1/2/3，共 600 次 P0/P3 请求；另用 100 次无注入请求扣除公共 Prompt 开销。P0→P3 的 pooled 结果为：有效调用率 100.00%→98.33%，误调用率 17.50%→0，工具选择正确率 91.67%→100%，provider 实测注入 Token 4246→1694（-60.10%）。完整原始计数和失败案例见 `experiments/agent-memory-optimization/reports/TASK_ONE_GLM_5_2_REPORT_CN.md`。

任务二最终报告：

| 组 | pass@1 | 平均总 Token | 平均 Turn | Skill 提取率 | Skill 命中率 |
|---|---:|---:|---:|---:|---:|
| S0 无 Skill | 待测 | 待测 | 待测 | — | — |
| S1 当前机制 | 待测 | 待测 | 待测 | 待测 | 待测 |
| S2 提取侧优化 | 待测 | 待测 | 待测 | 待测 | 待测 |
| S3 注入侧优化 | 待测 | 待测 | 待测 | 待测 | 待测 |
| S4 机制侧优化 | 待测 | 待测 | 待测 | 待测 | 待测 |
| S5 整链路组合 | 待测 | 待测 | 待测 | 待测 | 待测 |

报告还要附失败案例，不允许只展示平均数：至少列出 5 个未命中或错误注入案例，并记录对应 SWE-bench instance、配置、seed 和原始 trace。

## 12. 简历亮点应该怎样形成

当前可写“完成 200 条四指标评测集、cache-stable 注入结构和静态 Token 降幅”；在真实模型回放完成前，不能填写调用率提升。可按下列模板替换占位符：

- **工具调用注入优化：** 面向 Memory/Skill/Knowledge 构建 `[N]` 条含纯 coding hard negative 的测试集，通过合并重复内容、最小工具描述和正负触发边界优化，将注入从 `[A]` 降至 `[B]` Token（`-[C]%`），同时把有效调用率由 `[D]` 提升至 `[E]`、误调用率由 `[F]` 降至 `[G]`、工具选择正确率由 `[H]` 提升至 `[I]`；重构静态工具前缀与会话快照，保证跨轮 prompt cache 前缀稳定。
- **Skill 整链路优化：** 基于 SWE-bench 同仓任务序列，对触发阈值、抽取 Prompt、iterations、Transcript、路由与注入预算做可归因消融，将 pass@1 从 `[A]` 提升至 `[B]`、包含蒸馏的平均总 Token 降低 `[C]%`、平均 Turn 降低 `[D]%`，并将 Skill 命中率由 `[E]` 提升至 `[F]`。
- **Agent 评测工程：** 建立可归因的 Prompt P0–P3 与 Skill S0–S5 配对实验；任务一固定报告有效调用率、误调用率、工具选择正确率和注入 Token 量，任务二固定报告 pass@1、平均总 Token、平均 Turn、Skill 提取率和 Skill 命中率。

不能写入简历的内容：题目中的“理想 20 turn→8 turn”、外部方案的提升数字、开发集最佳值、单元测试 fixture 分数，以及尚未执行的推荐参数。

## 13. 参考资料与调研边界

- [Anthropic: Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)：用于最小工具契约与评测驱动迭代，不搬运其任务收益。
- [Anthropic Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)：用于前缀稳定性和 usage 验证。
- 同类机制调研范围：Cursor Rules、CLAUDE.md、Windsurf Memory、Cline Memory Bank、Aider Conventions、Continue Context、OpenHands。调研只做机制对比，不直接形成论文迁移实现或项目收益结论。
- [SWE-bench](https://github.com/princeton-nlp/SWE-bench) 与[官方评测 harness](https://www.swebench.com/SWE-bench/guides/evaluation/)：任务二唯一评测数据集和通过判定依据。

---

**审阅/实施结论栏：**

- [ ] 同意按 PR0→PR5 顺序推进
- [x] 任务一已按“公共决策策略 + 独立契约”实现
- [x] Prompt cache 修复已实现并由专项测试验证；提交时仍可拆为独立 commit/PR
- [ ] 同意任务二按提取侧 → 注入侧 → 机制侧 → 整链路组合的顺序实验
- [ ] 同意任务二只使用 SWE-bench，并只报告五项指定指标
- [ ] 已确认实验模型、预算和 SWE-bench 任务清单

任务二在对应范围得到确认前不修改业务代码；任务一已依据本轮用户指令进入实现阶段。
