import { z } from "zod";
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { fileHash, hash, readJson } from "./shared.js";
import type { RecordItem } from "./schema.js";

export const LONGMEMEVAL_SOURCE = {
  dataset: "xiaowu0162/longmemeval-cleaned", revision: "98d7416c24c778c2fee6e6f3006e7a073259d48f",
  filename: "longmemeval_s_cleaned.json", bytes: 277383467,
  sha256: "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442",
  repository: "https://github.com/xiaowu0162/LongMemEval", repository_commit: "9e0b455f4ef0e2ab8f2e582289761153549043fc",
  evaluator_sha256: "c98b8d1096877a15aa755c9de44fe33c195298466a2eb6f3c0f9f6bde8c72349",
  license: "MIT", license_copyright: "Copyright (c) 2024 Di Wu",
} as const;
export const longmemConfigSchema = z.object({
  schema_version: z.literal(1), dataset_file: z.string().min(1), output_dir: z.string().min(1),
  roles: z.array(z.enum(["all", "user"])).min(1).refine(xs => xs.length === new Set(xs).size),
  strategy: z.literal("bm25"), granularity: z.literal("session"), top_k: z.literal(5),
  seed: z.number().int().nonnegative(), bootstrap_samples: z.number().int().min(100).max(10000),
}).strict();
export const officialItemSchema = z.object({
  question_id: z.string().min(1), question: z.string().min(1), answer: z.union([z.string(), z.number()]),
  question_type: z.enum(["single-session-user", "single-session-assistant", "single-session-preference", "temporal-reasoning", "knowledge-update", "multi-session"]),
  question_date: z.string().min(1), haystack_session_ids: z.array(z.string().min(1)).min(1),
  haystack_dates: z.array(z.string().min(1)).min(1),
  haystack_sessions: z.array(z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string(), has_answer: z.boolean().optional() }))).min(1),
  answer_session_ids: z.array(z.string().min(1)),
}).superRefine((q, ctx) => {
  if (q.haystack_dates.length !== q.haystack_session_ids.length || q.haystack_sessions.length !== q.haystack_session_ids.length)
    ctx.addIssue({ code: "custom", message: "Misaligned session IDs, dates, and messages" });
  if (!q.question_id.endsWith("_abs") && (!q.answer_session_ids.length || q.answer_session_ids.some(id => !q.haystack_session_ids.includes(id))))
    ctx.addIssue({ code: "custom", message: "Non-abstention gold sessions missing from supplied history" });
});
export type OfficialItem = z.infer<typeof officialItemSchema>;
export type RoleMode = "all" | "user";

/** The source supplies naive wall times, not a timezone. Z is a sortable surrogate only. */
export function parseOfficialDate(raw: string): string {
  const m = /^(\d{4})\/(\d{2})\/(\d{2}) \([A-Za-z]{3}\) (\d{2}):(\d{2})$/.exec(raw);
  if (!m) throw new Error(`Unsupported LongMemEval date format: ${raw}`);
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00.000Z`;
  if (!Number.isFinite(Date.parse(iso)) || new Date(iso).toISOString() !== iso) throw new Error("Invalid LongMemEval date");
  return iso;
}
export function loadOfficialData(file: string): OfficialItem[] {
  if (statSync(file).size !== LONGMEMEVAL_SOURCE.bytes || fileHash(file) !== LONGMEMEVAL_SOURCE.sha256)
    throw new Error("LongMemEval checksum mismatch; only the pinned official full S-cleaned file is accepted");
  const raw = readJson(file);
  if (!Array.isArray(raw) || raw.length !== 500) throw new Error("Expected all 500 official questions");
  const data = raw.map(item => officialItemSchema.parse(item));
  if (new Set(data.map(q => q.question_id)).size !== data.length) throw new Error("Duplicate official question ID");
  return data;
}
export async function downloadOfficialData(file: string, mirror = false) {
  if (existsSync(file)) { loadOfficialData(file); return { file, reused: true, sha256: LONGMEMEVAL_SOURCE.sha256 }; }
  const host = mirror ? "https://hf-mirror.com" : "https://huggingface.co";
  const url = `${host}/datasets/${LONGMEMEVAL_SOURCE.dataset}/resolve/${LONGMEMEVAL_SOURCE.revision}/${LONGMEMEVAL_SOURCE.filename}`;
  mkdirSync(dirname(resolve(file)), { recursive: true });
  const partial = `${resolve(file)}.${randomUUID()}.download`;
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok || !response.body) throw new Error(`Dataset download HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(partial, { flags: "wx" }));
  if (statSync(partial).size !== LONGMEMEVAL_SOURCE.bytes || fileHash(partial) !== LONGMEMEVAL_SOURCE.sha256)
    throw new Error("Downloaded bytes do not match the official SHA-256; partial file retained, not accepted");
  if (existsSync(file)) throw new Error("Destination appeared while downloading; refusing overwrite");
  renameSync(partial, file);
  return { file, reused: false, download_url: url, sha256: LONGMEMEVAL_SOURCE.sha256 };
}

/** Indexing accepts NO question text, answer, answer_session_ids or has_answer labels. */
export function buildSessionCorpus(history: {
  question_id: string; haystack_session_ids: string[]; haystack_dates: string[];
  haystack_sessions: Array<Array<{ role: "user" | "assistant"; content: string }>>;
}, mode: RoleMode) {
  const scope = { teamId: "eval-longmemeval", userId: `user-${hash(history.question_id).slice(0, 20)}`, agentId: "eval-session-retrieval" };
  const records: RecordItem[] = [];
  const mapping = history.haystack_sessions.map((session, index) => {
    const selected = session.map((turn, i) => ({ turn, i })).filter(({ turn }) => mode === "all" || turn.role === "user");
    const content = selected.map(({ turn }) => turn.content).join(" ");
    const id = `lme-${hash({ question: history.question_id, index }).slice(0, 24)}`;
    const date = parseOfficialDate(history.haystack_dates[index]);
    const source_message_ids = selected.map(({ i }) => `${id}-m${i + 1}`);
    // Keep duplicate session IDs and empty user-only sessions as separate corpus positions.
    records.push({ id, content, type: "episodic", priority: 50, scene_name: "longmemeval-session",
      source_message_ids, source_session_ids: [history.haystack_session_ids[index]], evidence_ids: [],
      timestamps: [date], createdAt: date, updatedAt: date, metadata: {}, version: 1,
      sessionKey: scope.userId, sessionId: id, ...scope });
    return { record_id: id, source_session_id: history.haystack_session_ids[index], source_session_index: index,
      source_message_ids, source_message_indices: selected.map(({ i }) => i), raw_date: history.haystack_dates[index],
      normalized_wall_time: date, content_sha256: hash(content), content_chars: content.length };
  });
  return { records, mapping, scope, corpus_hash: hash(records.map(r => ({ id: r.id, content: r.content, timestamps: r.timestamps }))) };
}

/** Gold labels are computed only after the content-only corpus has been built. */
export function officialGold(item: OfficialItem, mode: RoleMode) {
  const evaluationIds = item.haystack_session_ids.map((sid, i) => {
    if (mode === "user" && sid.includes("answer") && !item.haystack_sessions[i].some(t => t.role === "user" && t.has_answer))
      return sid.replaceAll("answer", "noans");
    return sid;
  });
  const gold = mode === "all" ? [...new Set(item.answer_session_ids)] : [...new Set(evaluationIds.filter(id => id.includes("answer")))];
  const hasUserEvidence = item.haystack_sessions.some(s => s.some(t => t.role === "user" && t.has_answer));
  const exclusion = item.question_id.endsWith("_abs") ? "abstention" : mode === "user" && !hasUserEvidence ? "no_user_evidence" : null;
  if (!exclusion && !gold.length) throw new Error("No gold labels for an otherwise eligible question");
  return { evaluationIds, gold, exclusion };
}
