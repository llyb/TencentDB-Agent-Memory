# 完整记忆链路与 Embedding 对照：使用教程

本入口使用真实模型和生产记忆模块；数据仅来自固定版本的 LongMemEval-S。默认七类各一题，每题完整历史。不要把七题结果称作 500 题全量成绩。

## 1. 环境与凭据

需要 Node.js ≥22.16、项目依赖、可用的 SQLite FTS5/sqlite-vec，以及能访问模型服务的网络。在仓库的 `deploy/global-images/.env` 手动填写 `MEMORY_LLM_API_KEY` 和 `MEMORY_EMBEDDING_API_KEY`；不会读取 `.admin-key`，不会调用运行中的 Proxy/Core，也不修改生产数据。

模型参数沿用 `.env` 中的 `MEMORY_LLM_BASE_URL/MODEL`、`MEMORY_EMBEDDING_BASE_URL/MODEL/DIMENSIONS`。本次模型为 GLM-5.2、BGE-M3/1024 维。judge 模型在评测配置中指定，必须可通过对话服务访问。

在 PowerShell 中：

```powershell
cd D:/TencentDB-Agent-Memory/MemoryCore
npm run eval:memory -- validate
npm run typecheck:eval
npm run test:eval
```

没有数据时先执行 `npm run eval:memory -- download-longmemeval`。下载器检查官方字节数和 SHA-256；必要时使用 `--mirror`，哈希校验不会放宽。

## 2. 运行真实测试

```powershell
# 七类各一题，保留每题所有干扰会话，五种对照
npm run eval:memory -- system --live

# 单题接通链路，仅为冒烟，不能代表各类别
npm run eval:memory -- system --live --limit 1

# 指定另一份本地凭据文件（路径相对当前目录）
npm run eval:memory -- system --live --env-file ../deploy/global-images/.env
```

`--live` 是显式模型调用开关；不带时拒绝运行。新运行创建独立的 `eval/runs/system-...` 目录；启动时打印完整路径及指纹。阶段完成后打印进度，不在终端输出密钥或整段历史。GLM 默认思考会增加批量抽取耗时，评测统一关闭 thinking 并设温度为 0，参数和调用正文均保存，不改变日常服务配置。

配置文件 [system-longmemeval.json](configs/system-longmemeval.json) 中：

| 参数 | 默认 | 说明 |
|---|---:|---|
| per_stratum | 1 | 六类可回答题及拒答，每类最多取此数量；500 表示覆盖各类全部题目 |
| seed | 20260831 | 根据题 ID 哈希预先固定题单，不按成绩选题 |
| concurrency | 3 | 同时构建的题数；单题内部按历史顺序推进 |
| top_k | 5 | L0/L1 各自记录数，不是五个会话 |
| context_chars | 18000 | reader 的记忆字符预算，包含 L3、导航、召回和场景读取 |
| judge_model | glm-5.2 | 官方 rubric 主裁判，需披露同模型自评偏差 |
| audit_judge_model | qwen3-235b-a22b-instruct-2507 | 独立模型复核全部回答 |

扩大到各类 5 题时，复制配置到同目录并将 `per_stratum` 改为 `5`，再通过 `--config` 指定。数据和输出路径相对于配置文件目录；不建议直接覆盖已用配置。全量需大量 API 调用，不能把 `--limit` 当作截短会话参数。

## 3. 中断与恢复

```powershell
npm run eval:memory -- system --live --resume eval/runs/system-实际目录名
```

恢复必须使用相同题单（包括 `--limit`）、配置、模型和源码指纹，否则拒绝混用实验。成功的会话抽取、L2 批次、完整快照与回答结果会复用；失败的未完成单元可能再次请求模型。恢复不保证失败单元的生成结果逐字一致。保留旧 run，不需要删除文件或生产数据库。

注意：`build_ms` 是该次构建函数的执行耗时，恢复时不包含已完成会话的原始耗时；API 日志则累计保留已记录的各次调用。不能把恢复后的 `build_ms` 当作从零构建耗时，也不能把重新使用向量缓存后的索引时间当作冷启动时间。

如果只改 reader 或检索配置，需要重新比较回答而不重复抽取，可从已有运行中导入冻结快照：

```powershell
npm run eval:memory -- system --live --snapshot-run eval/runs/system-已有目录名
```

该命令创建新 run，不复用旧答案和裁判标签；Embedding 也重新计算。它核验官方数据、构建模型、生产模块/构建器源码及每题快照哈希，仅允许读取侧实验变化。请指向最初构建 L0→L3 的 run，不指向另一个只读回放 run。原构建成本写入 `snapshot_source.historical_build_cost`，本次调用成本仍写入 `api`，两者不能混为“这次实际调用量”。如果恢复这种运行，必须同时传入原来的 `--snapshot-run` 和新 run 的 `--resume`。快照来源 run 需要保留。

写入去重统一使用 BM25，随后冻结内容，再给 L0/L1 建完整向量索引；各策略共用同一份快照，因此这里测的是 Embedding 召回收益，不是向量去重改变写入内容后的收益。

## 4. 看结果与排错

- `report.md`：自动生成的简明报告。
- `summary.json`：完成/应完成数、QA/分类准确率、来源会话 Recall、按题配对区间、向量覆盖与 Token 成本。
- `manifest.json`：源码文件哈希、数据版本、题单、模型、参数及未来日期会话计数。
- 每题目录内 `snapshot.json`：规范冻结的 L0/L1/L2/L3 内容、消息来源与构建指标。
- 每策略 JSON、`results.jsonl`：实际提示词、回答、召回候选、场景读取和双裁判标签。
- `api-calls.jsonl`：模型请求/返回、Token、耗时和调用阶段，不含授权头；`embedding-cache/vectors.jsonl` 保存向量。
- `warnings.jsonl`：生产模块过滤、解析、降级等诊断。

L2/L3 生成没有产物、模型超时/输出截断、向量缺失和检索异常都会报告失败。某策略未全部完成时，总体准确率为 null，并另列 completed-only 值；不要仅展示后者。HTTP 200 本身不代表产物正确。

若出现 HTTP 429，等待服务恢复后用原配置 `--resume`，已成功的回答不重复调用，失败回答重新执行；API 日志保留先前失败。持续限流时，复制配置把 `concurrency` 降为 1，并使用新 run（可配合 `--snapshot-run`）；不要修改原配置后强行复用旧指纹。L2 的多轮工具写入有整批 180 秒上限，超时可能触发场景文件回滚，不能仅凭已有文件判定该批成功。

检索命中只验证来源会话，并不证明摘要保留了正确答案；需联合 QA 和具体提示词归因。拒答题只从检索分母排除，始终计入 QA。L0/L1 按层交错放入完整 JSON，按预算裁剪正文；只有极小预算连元数据都放不下时才舍弃低位条目。`evidence_context` 记录实际送达的记录 ID、裁剪数与舍弃数。实际发送文本保存在结果文件中，不按预算上限推测真实 Token。

画像与目录合用总预算的 1/3，检索结果最多使用 1/2，剩余供场景正文读取。所有 L2 文件名会优先保留，场景摘要与 L3 正文可裁剪；`profile_context` 记录目录/画像长度、画像是否裁剪和可见场景数。不能以“生成了 L2”代替“reader 确实能看到并读取 L2”。

原文、生成记忆及向量仅保存在本地 Git 忽略目录。共享报告时只复制汇总、指纹及必要的脱敏失败分析；不要把 `.env`、完整 API 日志或用户凭据提交到仓库。

## 5. 覆盖与限制

评测复用实际 `recordConversation`、`extractL1Memories`、`SceneExtractor`、`PersonaGenerator`、`executeMemorySearch` 和 `executeConversationSearch`，同时测试 L2 只读工具调用。为固定条件，离线执行器显式完成各阶段，reader 首先固定查询 L0/L1；不覆盖线上定时器/队列竞争、Proxy 逐字注入模板、ACL、UI 或负载性能。当前没有“整个项目所有功能均已通过”的含义。

官方 QA 脚本固定于作者仓库提交 `9e0b455f4ef0e2ab8f2e582289761153549043fc`，使用其五类判分模板；严格 yes/no 解析是本实现的加固，裁判模型与论文可能不同。结果需如实注明子集和模型，不能直接与论文榜单比较。
