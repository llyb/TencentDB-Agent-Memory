import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { LONGMEMEVAL_SOURCE, buildSessionCorpus, loadOfficialData, longmemConfigSchema, officialGold, parseOfficialDate, type RoleMode } from "./longmemeval-data.js";
import { createRetriever, runtimeInfo } from "./retrieval.js";
import { bootstrapCI, mean, quantile } from "./metrics.js";
import { hash, readJson, sourceInfo, writeJson, writeJsonl } from "./shared.js";
import { runSchema, traceSchema, type Run } from "./schema.js";

export function loadLongmemConfig(file: string) {
  const config = longmemConfigSchema.parse(readJson(file));
  return { ...config, dataset_file: resolve(dirname(file), config.dataset_file), output_dir: resolve(dirname(file), config.output_dir) };
}

/** The upstream DCG convention assigns rank 1 AND rank 2 a weight of 1. */
export function scoreSessions(ranked: string[], candidates: string[], corpus: string[], goldIds: string[]) {
  const gold = new Set(goldIds);
  if (!gold.size) throw new Error("Empty gold has no retrieval score; exclude abstention/no-target questions first");
  const top = ranked.slice(0, 5);
  const hits = new Set(top.filter(id => gold.has(id)));
  const pool = new Set(candidates.filter(id => gold.has(id)));
  const weight = (rank: number) => rank === 0 ? 1 : 1 / Math.log2(rank + 1);
  const dcg = top.reduce((n, id, rank) => n + (gold.has(id) ? weight(rank) : 0), 0);
  const idealCount = Math.min(5, corpus.filter(id => gold.has(id)).length);
  const ideal = Array.from({ length: idealCount }, (_, i) => weight(i)).reduce((a, b) => a + b, 0);
  const first = top.findIndex(id => gold.has(id));
  return { recall_at_5: hits.size / gold.size, hit_at_5: Number(hits.size > 0),
    mrr_at_5: first < 0 ? 0 : 1 / (first + 1), recall_all_at_5: Number(hits.size === gold.size),
    ndcg_at_5: ideal ? dcg / ideal : 0, candidate_recall: pool.size / gold.size,
    missed_session_ids: [...gold].filter(id => !hits.has(id)),
    candidate_miss_session_ids: [...gold].filter(id => !pool.has(id)),
    ranking_miss_session_ids: [...pool].filter(id => !hits.has(id)) };
}
type SessionScores = ReturnType<typeof scoreSessions>;
export interface OfficialResult {
  question_id: string; question_type: string; roles: RoleMode; status: "ok" | "error";
  exclusion: string | null; reason: string | null; actual_strategy: string;
  corpus_hash: string; corpus_sessions: number; indexed_chars: number;
  future_session_count: number; duplicate_session_id_count: number; empty_document_count: number;
  gold_session_ids: string[]; retrieved: { record_id: string; session_id: string; evaluation_id: string; score: number }[];
  candidate_record_ids: string[]; candidate_evaluation_ids: string[];
  elapsed_ms: number; index_ms: number; warnings: string[]; scores: SessionScores | null;
}
export function summarizeLongmem(rows: OfficialResult[], samples: number, seed: number) {
  const keys = ["recall_at_5", "hit_at_5", "mrr_at_5", "recall_all_at_5", "ndcg_at_5", "candidate_recall"] as const;
  return (["all", "user"] as const).flatMap(mode => {
    const selected = rows.filter(r => r.roles === mode);
    if (!selected.length) return [];
    const subsets = ["all", ...new Set(selected.map(r => r.question_type)), "no_future_history"];
    return subsets.map(subset => {
      const group = selected.filter(r => subset === "all" || (subset === "no_future_history" ? !r.future_session_count : r.question_type === subset));
      const eligible = group.filter(r => !r.exclusion);
      const scored = eligible.filter(r => r.status === "ok" && r.scores);
      const counts = (xs: string[]) => Object.fromEntries([...new Set(xs)].map(key => [key, xs.filter(x => x === key).length]));
      return { roles: mode, subset, total: group.length, eligible: eligible.length, scored: scored.length,
        comparable: scored.length === eligible.length && eligible.length > 0,
        excluded: counts(group.flatMap(r => r.exclusion ? [r.exclusion] : [])), error_count: group.filter(r => r.status === "error").length,
        metrics: Object.fromEntries(keys.map(key => [key, { value: mean(scored.map(r => r.scores![key])), n: scored.length,
          ci95: bootstrapCI(scored.map(r => ({ group_id: r.question_id, value: r.scores![key] })), samples, seed) }])),
        latency_ms_p50: quantile(group.filter(r => r.status === "ok").map(r => r.elapsed_ms), 0.5),
        latency_ms_p95: quantile(group.filter(r => r.status === "ok").map(r => r.elapsed_ms), 0.95),
        index_ms_p50: quantile(group.filter(r => r.status === "ok").map(r => r.index_ms), 0.5),
        unsupported_retrieval: { value: mean(group.filter(r => r.exclusion === "abstention" && r.status === "ok").map(r => Number(r.retrieved.length > 0))),
          n: group.filter(r => r.exclusion === "abstention" && r.status === "ok").length },
        candidate_miss_count: scored.filter(r => r.scores!.candidate_miss_session_ids.length).length,
        ranking_miss_count: scored.filter(r => r.scores!.ranking_miss_session_ids.length).length };
    });
  });
}
type LongmemSummary = ReturnType<typeof summarizeLongmem>;
export function renderLongmemReport(run: Run, rows: OfficialResult[], summary: LongmemSummary, full: boolean) {
  const f = (value: number | null) => value == null ? "—" : value.toFixed(5);
  const lines = ["# LongMemEval-S 官方数据检索测试", "", `Run: ${run.run_id}`, "",
    `数据：[作者发布的 cleaned S](https://huggingface.co/datasets/${LONGMEMEVAL_SOURCE.dataset}/tree/${LONGMEMEVAL_SOURCE.revision})；${full ? "全部 500 题" : "冒烟子集，不是全量结果"}。`,
    `SHA-256: \`${LONGMEMEVAL_SOURCE.sha256}\``, `源码哈希：\`${run.source_hash}\`；配置哈希：\`${run.config_hash}\`。`, "",
    "## 口径", "", "- all：索引每个会话的 user+assistant 原文，以 answer_session_ids 为会话级 gold；排除拒答题。",
    "- user：复用官方 flat retrieval 的 user-only 文本和用户证据筛选规则，额外排除没有用户证据的题目。",
    "- 两种模式均使用本项目生产 SQLite FTS5 BM25，不是官方 rank_bm25 实现；没有 L1 模型抽取、语义 Embedding 或回答生成。",
    "- 单题单库，保留全部干扰会话；不索引问题、参考答案、has_answer 或 gold ID。Top5 会话记录中重复的原始 session ID 占据原位置，证据命中用集合去重。",
    "- 原始时间没有时区，按原始墙上时间解析；Z 仅用于存储和排序，不声称源数据是 UTC。按官方给定历史保留晚于 question_date 的会话，单列 no_future_history 子集。",
    "- recall_all@5、recall_any@5（即 Hit@5）、nDCG@5 参照官方 eval_utils；nDCG 第二位权重也是 1。Recall@5/MRR@5 为本项目补充诊断指标。", "",
    "## 主结果", "", "| 模式 | 总题数 | 计分/应计分 | Recall@5 | Hit@5 | MRR@5 | Recall-all@5 | nDCG@5 | 候选 Recall |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|" ];
  for (const s of summary.filter(s => s.subset === "all")) lines.push(`| ${s.roles} | ${s.total} | ${s.scored}/${s.eligible} | ${f(s.metrics.recall_at_5.value)} | ${f(s.metrics.hit_at_5.value)} | ${f(s.metrics.mrr_at_5.value)} | ${f(s.metrics.recall_all_at_5.value)} | ${f(s.metrics.ndcg_at_5.value)} | ${f(s.metrics.candidate_recall.value)} |`);
  lines.push("", "## 分类结果", "", "| 模式 | 类别/子集 | 计分题数 | Recall@5 | MRR@5 | Recall-all@5 |", "|---|---|---:|---:|---:|---:|");
  for (const s of summary.filter(s => s.subset !== "all")) lines.push(`| ${s.roles} | ${s.subset} | ${s.scored} | ${f(s.metrics.recall_at_5.value)} | ${f(s.metrics.mrr_at_5.value)} | ${f(s.metrics.recall_all_at_5.value)} |`);
  lines.push("", "## 异常、耗时与不确定性", "");
  for (const s of summary.filter(s => s.subset === "all")) lines.push(
    `- ${s.roles}：排除=${JSON.stringify(s.excluded)}，运行错误=${s.error_count}，完整可比=${s.comparable}。`,
    `- ${s.roles}：Recall@5 95% CI=${JSON.stringify(s.metrics.recall_at_5.ci95)}；MRR@5 CI=${JSON.stringify(s.metrics.mrr_at_5.ci95)}；按问题 bootstrap（非策略差值检验）。`,
    `- ${s.roles}：检索 P50/P95=${f(s.latency_ms_p50)}/${f(s.latency_ms_p95)} ms；建库 P50=${f(s.index_ms_p50)} ms。`,
    `- ${s.roles}：候选遗漏=${s.candidate_miss_count}题，排序遗漏=${s.ranking_miss_count}题；两者可重叠。拒答题无支持返回率=${f(s.unsupported_retrieval.value)}，n=${s.unsupported_retrieval.n}；不是答案拒答率。`);
  const oneMode = rows.filter(r => r.roles === rows[0]?.roles);
  lines.push(`- 原始数据中包含未来墙上时间的题目：${oneMode.filter(r => r.future_session_count > 0).length}；会话位置总数：${oneMode.reduce((n, r) => n + r.future_session_count, 0)}。`,
    `- 原始 session ID 重复的题目：${oneMode.filter(r => r.duplicate_session_id_count > 0).length}。未静默清理、去重或替换官方数据。`,
    "", "## 复现", "", "在 MemoryCore 目录执行：", "", "```powershell", "npm run eval:memory -- download-longmemeval --mirror", "npm run eval:memory -- longmemeval", "```", "",
    "下载脚本固定官方版本和校验值；--mirror 仅改变下载地址，必须通过官方 SHA-256。完整数据保存在 eval/private，不纳入 Git。",
    "逐题列表 samples.jsonl；每模式一行结果 results.jsonl；完整记录来源映射 record-map.jsonl；共享 trace.jsonl；配置和源码指纹见 run.json/config.resolved.json/source-files.json。",
    "没有运行 QA Judge，不报告论文的端到端回答准确率；本结果仅衡量官方数据上的会话检索。", "");
  return lines.join("\n");
}

export async function runLongmem(configFile: string, limit?: number, progress: (message: string) => void = console.log) {
  const config = loadLongmemConfig(configFile);
  const raw = loadOfficialData(config.dataset_file);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > raw.length)) throw new Error("limit must be an integer between 1 and 500");
  const items = limit ? raw.slice(0, limit) : raw;
  const runtime = runtimeInfo();
  const source = sourceInfo(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const { dataset_file: _path, output_dir: _out, ...logical } = config;
  const snapshotRecipe = { dataset_sha256: LONGMEMEVAL_SOURCE.sha256, method: "verbatim-session-index-v1", roles: config.roles,
    concatenate: "space-joined content only", timestamp_policy: "preserve-all-official-history-naive-wall-clock",
    question_ids: items.map(q => q.question_id) };
  const resolved = { ...logical, source: LONGMEMEVAL_SOURCE, sample_count: items.length, selection: limit ? "first-N-smoke-only" : "all-500-no-tuning",
    source_hash: source.source_hash, runtime, snapshot_recipe: snapshotRecipe,
    backend: "production-sqlite-fts5-bm25", candidates: "top_k*3=15 per query", model: null,
    official_user_filter: "Exclude _abs and questions lacking user has_answer; gold from answer-labeled user sessions" };
  const run: Run = runSchema.parse({ schema_version: 1, run_id: `longmemeval-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
    config_hash: hash(resolved), model: null, repo_commit: source.repo_commit, source_hash: source.source_hash,
    prompt_version: "none-verbatim-session-v1", dataset_hash: LONGMEMEVAL_SOURCE.sha256, snapshot_hash: hash(snapshotRecipe),
    started_at: new Date().toISOString(), repo_dirty: source.repo_dirty, runtime });
  mkdirSync(config.output_dir, { recursive: true });
  const output = join(config.output_dir, run.run_id); mkdirSync(output);
  writeJson(join(output, "run.json"), run); writeJson(join(output, "config.resolved.json"), resolved);
  writeJson(join(output, "source-files.json"), source.source_files);
  writeJsonl(join(output, "samples.jsonl"), items.map(q => ({ question_id: q.question_id, question_type: q.question_type,
    question: q.question, answer: q.answer, question_date: q.question_date, answer_session_ids: q.answer_session_ids,
    session_count: q.haystack_session_ids.length, abstention: q.question_id.endsWith("_abs") })));
  for (const name of ["results.jsonl", "trace.jsonl", "record-map.jsonl"]) writeFileSync(join(output, name), "", { flag: "wx" });
  const append = (name: string, row: unknown) => appendFileSync(join(output, name), JSON.stringify(row) + "\n");
  const rows: OfficialResult[] = [];
  for (const [itemIndex, item] of items.entries()) {
    for (const mode of config.roles) {
      // Explicitly strip evaluation fields before any indexing code sees the history.
      const corpus = buildSessionCorpus({ question_id: item.question_id, haystack_session_ids: item.haystack_session_ids,
        haystack_dates: item.haystack_dates, haystack_sessions: item.haystack_sessions.map(s => s.map(({ role, content }) => ({ role, content }))) }, mode);
      const labels = officialGold(item, mode);
      const map = new Map(corpus.mapping.map((m, i) => [m.record_id, { ...m, evaluation_id: labels.evaluationIds[i] }]));
      append("record-map.jsonl", { question_id: item.question_id, roles: mode, corpus_hash: corpus.corpus_hash, records: [...map.values()] });
      const row: OfficialResult = { question_id: item.question_id, question_type: item.question_type, roles: mode,
        status: "error", exclusion: labels.exclusion, reason: null, actual_strategy: "none", corpus_hash: corpus.corpus_hash,
        corpus_sessions: corpus.records.length, indexed_chars: corpus.records.reduce((n, r) => n + r.content.length, 0),
        future_session_count: item.haystack_dates.filter(d => parseOfficialDate(d) > parseOfficialDate(item.question_date)).length,
        duplicate_session_id_count: item.haystack_session_ids.length - new Set(item.haystack_session_ids).size,
        empty_document_count: corpus.records.filter(r => !r.content.trim()).length, gold_session_ids: labels.gold,
        retrieved: [], candidate_record_ids: [], candidate_evaluation_ids: [], elapsed_ms: 0, index_ms: 0, warnings: [], scores: null };
      let retriever: ReturnType<typeof createRetriever> | undefined;
      try {
        const start = performance.now();
        retriever = createRetriever({ records: corpus.records, queries: [], dataset_hash: LONGMEMEVAL_SOURCE.sha256 });
        row.index_ms = performance.now() - start;
        const result = await retriever.search({ query: item.question, scope: corpus.scope }, "bm25", 5);
        Object.assign(row, { actual_strategy: result.actual_strategy, elapsed_ms: result.elapsed_ms, warnings: result.warnings,
          candidate_record_ids: result.candidate_ids });
        if (result.warnings.length || result.actual_strategy !== "bm25") throw new Error("Production retrieval warning or strategy mismatch");
        row.retrieved = result.results.map(r => {
          const m = map.get(r.id);
          if (!m || !Number.isFinite(r.score)) throw new Error("Unknown record ID or invalid score");
          return { record_id: r.id, session_id: m.source_session_id, evaluation_id: m.evaluation_id, score: r.score };
        });
        row.candidate_evaluation_ids = result.candidate_ids.map(id => {
          const m = map.get(id); if (!m) throw new Error("Unknown candidate ID"); return m.evaluation_id;
        });
        if (!labels.exclusion) row.scores = scoreSessions(row.retrieved.map(r => r.evaluation_id), row.candidate_evaluation_ids, labels.evaluationIds, labels.gold);
        row.status = "ok";
      } catch (error) { row.reason = error instanceof Error ? error.message : String(error); }
      finally { retriever?.close(); }
      rows.push(row); append("results.jsonl", row);
      append("trace.jsonl", traceSchema.parse({ run_id: run.run_id, config_hash: run.config_hash, model: null,
        repo_commit: run.repo_commit, prompt_version: run.prompt_version, sample_id: `${item.question_id}:${mode}`,
        timestamp: new Date().toISOString(), suite: "memory_retrieval", event: row.status === "error" ? "error" : "retrieval",
        trace: { requested_strategy: "bm25", actual_strategy: row.actual_strategy, backend: `sqlite-fts5-bm25/session/${mode}`,
          returned_record_ids: row.retrieved.map(r => r.record_id), candidate_record_ids: row.candidate_record_ids,
          elapsed_ms: row.elapsed_ms, warnings: row.warnings, reason: row.reason ?? (labels.exclusion ? `metric exclusion: ${labels.exclusion}` : null) } }));
    }
    if ((itemIndex + 1) % 25 === 0 || itemIndex + 1 === items.length) progress(`LongMemEval: ${itemIndex + 1}/${items.length} questions; ${rows.filter(r => r.status === "error").length} errors`);
  }
  const summary = summarizeLongmem(rows, config.bootstrap_samples, config.seed);
  const failed = rows.some(r => r.status === "error");
  writeJson(join(output, "summary.json"), { run, source: LONGMEMEVAL_SOURCE, expected_rows: items.length * config.roles.length,
    completed_rows: rows.length, full_dataset: items.length === 500, failed,
    finished_at: new Date().toISOString(), memory_retrieval: summary, qa: "not_run", dense_hybrid: "not_run_no_embedding" });
  writeFileSync(join(output, "report.md"), renderLongmemReport(run, rows, summary, items.length === 500), { flag: "wx" });
  return { output, run_id: run.run_id, questions: items.length, rows: rows.length, failed };
}
