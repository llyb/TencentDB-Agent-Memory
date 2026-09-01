# LongMemEval-S 七题完整记忆链路对照归档

最终回答 run：`system-2026-08-31T11-25-49-703Z-c1edbd`。原始构建 run：`system-2026-08-31T10-40-01-421Z-2b076a`。

- manifest/summary：最终读取侧对照的身份、指标、调用成本。
- build-manifest/build-summary：原始 L0→L3 构建的身份与最终恢复状态；其中旧 reader 成绩仅供调试审计，不是本报告结论。
- reader-attempt-1-summary / build-attempt-1-summary：首次完成数与错误数，保留限流和超时造成的缺失。
- question-metrics：35 条逐题指标与工具/预算诊断；不包含原文、回答、提示词或凭据。
- api-ledger：本轮各次评测运行的已记录调用量；不将复用快照的历史成本重复累计。
- SHA256SUMS：本目录其余文件的字节校验和。

正式结论见 [系统测试报告](../../MEMORY_SYSTEM_TEST_REPORT_CN.md)，使用见 [教程](../../../MemoryCore/eval/SYSTEM_EVAL_CN.md)。七题是分层工程子集，不是全量成绩。

本地完整快照、向量、API 请求和返回位于 MemoryCore/eval/runs 的对应目录，已被 Git 忽略。复现全流程直接运行 system --live；复用本机快照运行 system --live --snapshot-run eval/runs/system-2026-08-31T10-40-01-421Z-2b076a，新生成内容可能受模型非确定性影响。
