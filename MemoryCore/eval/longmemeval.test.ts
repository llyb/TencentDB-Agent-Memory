import { describe, expect, it } from "vitest";
import { buildSessionCorpus, officialGold, officialItemSchema, parseOfficialDate, type OfficialItem } from "./longmemeval-data.js";
import { scoreSessions, summarizeLongmem, type OfficialResult } from "./longmemeval.js";
import { createRetriever } from "./retrieval.js";

// Authored tiny fixture; no downloaded dataset or API access is required by CI.
const fixture: OfficialItem = {
  question_id: "unit-question", question_type: "multi-session", question: "alpha beta", answer: "GOLD ANSWER NEVER INDEXED",
  question_date: "2023/05/30 (Tue) 23:40", haystack_session_ids: ["answer_a", "answer_b", "filler"],
  haystack_dates: ["2023/05/20 (Sat) 02:21", "2023/05/21 (Sun) 03:00", "2023/06/01 (Thu) 00:00"],
  haystack_sessions: [
    [{ role: "user", content: "alpha meeting", has_answer: true }, { role: "assistant", content: "assistant alpha detail", has_answer: true }],
    [{ role: "user", content: "unrelated chat", has_answer: false }, { role: "assistant", content: "beta explanation", has_answer: true }],
    [{ role: "assistant", content: "filler only" }],
  ], answer_session_ids: ["answer_a", "answer_b"],
};
describe("LongMemEval ingestion and benchmark boundaries", () => {
  it("preserves all supplied sessions and future wall times instead of substituting oracle history", () => {
    const corpus = buildSessionCorpus(fixture, "all");
    expect(corpus.records).toHaveLength(3);
    expect(corpus.records[2].content).toBe("filler only");
    expect(corpus.mapping[2].raw_date).toBe("2023/06/01 (Thu) 00:00");
    expect(corpus.records[2].updatedAt > parseOfficialDate(fixture.question_date)).toBe(true);
  });
  it("cannot use gold, answer_session_ids or has_answer to select/index text", () => {
    const modified = structuredClone(fixture);
    modified.question = "OTHER QUESTION"; modified.answer = "OTHER GOLD"; modified.answer_session_ids = ["filler"];
    modified.haystack_sessions.forEach(s => s.forEach(t => { t.has_answer = !t.has_answer; }));
    expect(buildSessionCorpus(modified, "all")).toEqual(buildSessionCorpus(fixture, "all"));
    expect(buildSessionCorpus(modified, "user")).toEqual(buildSessionCorpus(fixture, "user"));
    for (const r of buildSessionCorpus(fixture, "all").records) {
      expect(r.content).not.toContain(fixture.answer);
      expect(r.id).not.toContain("answer"); expect(r.evidence_ids).toEqual([]);
    }
  });
  it("keeps only user content in the upstream role mode, including empty positions", () => {
    const corpus = buildSessionCorpus(fixture, "user");
    expect(corpus.records.map(r => r.content)).toEqual(["alpha meeting", "unrelated chat", ""]);
    expect(corpus.mapping[0].source_message_indices).toEqual([0]);
    expect(corpus.mapping[2].source_message_ids).toEqual([]);
  });
  it("preserves duplicate session IDs without primary-key overwrite", () => {
    const modified = structuredClone(fixture); modified.haystack_session_ids[2] = "answer_a";
    const corpus = buildSessionCorpus(modified, "all");
    expect(corpus.records).toHaveLength(3); expect(new Set(corpus.records.map(r => r.id)).size).toBe(3);
    expect(corpus.mapping.filter(m => m.source_session_id === "answer_a")).toHaveLength(2);
  });
  it("applies the user-only annotation filter only for scoring, not to corpus contents", () => {
    expect(officialGold(fixture, "all").gold).toEqual(["answer_a", "answer_b"]);
    const user = officialGold(fixture, "user");
    expect(user.gold).toEqual(["answer_a"]); expect(user.evaluationIds[1]).toBe("noans_b");
    const modified = structuredClone(fixture);
    modified.haystack_sessions[0][0].has_answer = false;
    expect(officialGold(modified, "user").exclusion).toBe("no_user_evidence");
    expect(officialGold(modified, "all").exclusion).toBeNull();
  });
  it("excludes abstention even if the original file still contains answer_session_ids", () => {
    const abstention = { ...fixture, question_id: "unit_abs" };
    expect(officialGold(abstention, "all").exclusion).toBe("abstention");
    expect(officialGold(abstention, "user").exclusion).toBe("abstention");
  });
  it("checks array alignment, missing gold, and dates without locale-dependent parsing", () => {
    expect(officialItemSchema.safeParse({ ...fixture, haystack_dates: [] }).success).toBe(false);
    expect(officialItemSchema.safeParse({ ...fixture, answer_session_ids: ["missing"] }).success).toBe(false);
    expect(parseOfficialDate("2023/05/20 (Sat) 02:21")).toBe("2023-05-20T02:21:00.000Z");
    expect(() => parseOfficialDate("2023/02/30 (Thu) 00:00")).toThrow();
    expect(() => parseOfficialDate("05/20/2023")).toThrow();
  });
  it("runs an isolated actual SQLite search with empty documents and repeated original session IDs", async () => {
    const corpus = buildSessionCorpus(fixture, "user");
    const retriever = createRetriever({ records: corpus.records, queries: [], dataset_hash: "fixture-only" });
    try {
      const result = await retriever.search({ query: "alpha", scope: corpus.scope }, "bm25", 5);
      expect(result.results.map(r => r.id)).toEqual([corpus.records[0].id]);
      expect(result.warnings).toEqual([]);
      const isolated = await retriever.search({ query: "alpha", scope: { ...corpus.scope, userId: "other-question" } }, "bm25", 5);
      expect(isolated.results).toEqual([]);
    } finally { retriever.close(); }
  });
});
describe("LongMemEval session metrics", () => {
  it("reports recall-any, recall-all and fractional recall separately", () => {
    const score = scoreSessions(["a", "noise"], ["a", "b", "noise"], ["a", "b", "noise"], ["a", "b"]);
    expect(score.hit_at_5).toBe(1); expect(score.recall_at_5).toBe(0.5); expect(score.recall_all_at_5).toBe(0);
    expect(score.candidate_recall).toBe(1); expect(score.ranking_miss_session_ids).toEqual(["b"]);
  });
  it("matches the official unusual nDCG weighting, including duplicate session positions", () => {
    expect(scoreSessions(["noise", "a"], ["a", "noise"], ["a", "noise"], ["a"]).ndcg_at_5).toBe(1);
    const score = scoreSessions(["a", "a", "noise"], ["a", "a", "b", "noise"], ["a", "a", "b", "noise"], ["a", "b"]);
    expect(score.recall_at_5).toBe(0.5);
    expect(score.ndcg_at_5).toBeCloseTo(2 / (2 + 1 / Math.log2(3)), 12);
  });
  it("excludes rank six from Top5 and distinguishes candidate misses", () => {
    const score = scoreSessions(["1", "2", "3", "4", "5", "a"], ["1", "2", "3", "4", "5", "a"], ["1", "2", "3", "4", "5", "a", "b"], ["a", "b"]);
    expect(score.mrr_at_5).toBe(0); expect(score.recall_at_5).toBe(0);
    expect(score.candidate_miss_session_ids).toEqual(["b"]); expect(score.ranking_miss_session_ids).toEqual(["a"]);
    expect(() => scoreSessions([], [], [], [])).toThrow("Empty gold");
  });
  it("does not let exclusions or search errors inflate the eligible denominator", () => {
    const base: OfficialResult = { question_id: "q", question_type: "multi-session", roles: "user", status: "ok", exclusion: null,
      reason: null, actual_strategy: "bm25", corpus_hash: "h", corpus_sessions: 1, indexed_chars: 5,
      future_session_count: 0, duplicate_session_id_count: 0, empty_document_count: 0, gold_session_ids: ["a"],
      retrieved: [], candidate_record_ids: [], candidate_evaluation_ids: [], elapsed_ms: 1, index_ms: 1, warnings: [],
      scores: scoreSessions(["a"], ["a"], ["a"], ["a"]) };
    const summary = summarizeLongmem([base, { ...base, question_id: "a_abs", exclusion: "abstention", scores: null },
      { ...base, question_id: "assistant", exclusion: "no_user_evidence", scores: null },
      { ...base, question_id: "err", status: "error", scores: null }], 100, 1)[0];
    expect(summary.total).toBe(4); expect(summary.eligible).toBe(2); expect(summary.scored).toBe(1);
    expect(summary.comparable).toBe(false); expect(summary.excluded).toEqual({ abstention: 1, no_user_evidence: 1 });
  });
});
