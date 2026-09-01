import { describe, it, expect } from "vitest";
import { historyOnly, selectQuestions, judgeLabel, judgePrompt, recall, summarizeSystem, systemConfigSchema } from "./system-eval.js";
import { indexSnapshot, type MemorySnapshot } from "./system-memory.js";
import type { OfficialItem } from "./longmemeval-data.js";
import type { ModelRuntime } from "./system-model.js";
import { readJson, hash, sourceInfo } from "./shared.js";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { profileContext, retrievalContext, loadFrozenRun } from "./system-replay.js";

// Parser/contract fixtures only: never exposed as a runnable benchmark dataset.
const fixture: OfficialItem = { question_id: "unit-only", question_type: "single-session-user", question: "SECRET_QUERY", answer: "SECRET_GOLD",
  question_date: "2023/05/30 (Tue) 23:40", haystack_session_ids: ["answer_marker"], haystack_dates: ["2023/05/20 (Sat) 02:21"],
  haystack_sessions: [[{ role: "user", content: "alpha meeting", has_answer: true }]], answer_session_ids: ["answer_marker"] };
describe("Full memory evaluation contracts", () => {
  it("strips every gold/query field and source-ID hint before memory generation", () => {
    const h = historyOnly(fixture); const text = JSON.stringify(h);
    expect(text).not.toMatch(/SECRET|has_answer|answer_marker|question_id/);
    expect(h.sessions[0].messages[0].content).toBe("alpha meeting");
    expect(h.sessions[0].date).toBe("2023-05-20T02:21:00.000Z");
  });
  it("selects deterministic strata independently of answers and file order", () => {
    const data = Array.from({ length: 8 }, (_, i) => ({ ...fixture, question_id: `id-${i}${i % 2 ? "_abs" : ""}` }));
    expect(selectQuestions(data, 5, 1).map(q => q.question_id)).toEqual(selectQuestions(data.reverse().map(q => ({ ...q, answer: "changed" })), 5, 1).map(q => q.question_id));
    expect(selectQuestions(data, 5, 1)).toHaveLength(2);
  });
  it("uses official task-specific judging including abstention and off-by-one", () => {
    expect(judgePrompt({ ...fixture, question_id: "q_abs" }, "unknown")).toContain("unanswerable");
    expect(judgePrompt({ ...fixture, question_type: "temporal-reasoning" }, "19")).toContain("off-by-one");
    expect(judgeLabel("Yes.")).toBe(true); expect(judgeLabel("no")).toBe(false);
    expect(() => judgeLabel("not yes")).toThrow();
  });
  it("does not count duplicate evidence twice or score abstention as retrieval", () => {
    expect(recall(["a", "a"], ["a", "b"])).toBe(0.5); expect(recall(["a"], [])).toBeNull();
  });
  it("does not hide incomplete variants behind a successful-only accuracy", () => {
    const cfg = systemConfigSchema.parse(readJson(fileURLToPath(new URL("./configs/system-longmemeval.json", import.meta.url))));
    const report = summarizeSystem([{ question_id: "1", variant: "full_bm25", status: "ok", correct: true, audit_correct: true, judge_agreement: true }], cfg, ["1", "2"]);
    expect(report.complete).toBe(false); expect(report.variants.find(v => v.variant === "full_bm25")?.accuracy).toBeNull();
    expect(report.variants.find(v => v.variant === "full_bm25")).toMatchObject({ pending: 1, errors: 0 });
  });
  it("keeps every L2 filename visible when a long L3 persona exhausts the budget", () => {
    const scenes = Array.from({ length: 20 }, (_, i) => ({ filename: `scene-${i}.md`, summary: "summary ".repeat(100), content: "" }));
    const result = profileContext({ scenes, persona: "persona ".repeat(2000) }, 6000);
    expect(result.text.length).toBeLessThanOrEqual(6000);
    for (const scene of scenes) expect(result.text).toContain(scene.filename + ":");
    expect(result.visible_scenes).toBe(20); expect(result.persona_truncated).toBe(true); expect(result.persona_chars).toBeGreaterThan(0);
    expect(() => profileContext({ scenes: [{ filename: "x".repeat(500), summary: "", content: "" }], persona: "" }, 100)).toThrow(/budget/);
  });
  it("refuses modified frozen snapshots and changed build models or code", () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-replay-unit-"));
    try {
      const snapshot = { history_hash: "unit" }; const files = { "eval/system-memory.ts": "original" };
      const source = { source_files: files } as unknown as ReturnType<typeof sourceInfo>;
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({ models: {}, dataset: {}, source_files: files, selected_question_ids: ["unit"] }));
      writeFileSync(join(dir, "summary.json"), JSON.stringify({ builds: [{ question_id: "unit", snapshot_hash: hash(snapshot) }] }));
      const qdir = join(dir, hash("unit").slice(0, 20)); mkdirSync(qdir);
      writeFileSync(join(qdir, "snapshot.json"), JSON.stringify(snapshot));
      expect(loadFrozenRun(dir, ["unit"], source, {}, {}).snapshots).toHaveLength(1);
      expect(() => loadFrozenRun(dir, ["unit"], source, { llm: "changed" }, {})).toThrow(/model/);
      expect(() => loadFrozenRun(dir, ["unit"], { ...source, source_files: { "eval/system-memory.ts": "changed" } }, {}, {})).toThrow(/source/);
      writeFileSync(join(qdir, "snapshot.json"), JSON.stringify({ history_hash: "tampered" }));
      expect(() => loadFrozenRun(dir, ["unit"], source, {}, {})).toThrow(/hash/);
    } finally {
      if (!resolve(dir).startsWith(resolve(tmpdir()) + sep) || !dir.includes("memory-replay-unit-")) throw new Error("Unsafe test cleanup path");
      rmSync(dir, { recursive: true });
    }
  });
  it("keeps both retrieved layers and valid JSON under a strict content budget", () => {
    const l0 = Array.from({ length: 5 }, (_, i) => ({ id: `raw-${i}`, content: 'quote"\\中文\n'.repeat(2000) }));
    const l1 = Array.from({ length: 5 }, (_, i) => ({ id: `memory-${i}`, content: "short fact" }));
    const packed = retrievalContext(l0, l1, 1800);
    expect(packed.text.length).toBeLessThanOrEqual(1800);
    expect(JSON.parse(packed.text).evidence).toHaveLength(10);
    expect(packed.delivered.filter(r => r.layer === "L1")).toHaveLength(5);
    expect(packed.truncated_records).toBe(5); expect(packed.dropped_records).toBe(0);
    const tiny = retrievalContext(l0, l1, 300);
    expect(() => JSON.parse(tiny.text)).not.toThrow(); expect(tiny.dropped_records).toBeGreaterThan(0);
  });
  it("runs real SQLite BM25/dense/hybrid L0 and L1 with complete vectors and session provenance", async () => {
    const fields = { teamId: "eval", userId: "eval-user", agentId: "eval-agent", sessionId: "session-0000", sessionKey: "session-0000" };
    const snapshot: MemorySnapshot = { history_hash: "unit", input_messages: 1, captured_messages: 1, l1_extracted: 1, invalid_source_ids: 0, source_ids: 1, l2_empty_batches: 0, build_ms: 0,
      l0: [{ ...fields, id: "msg-unit", role: "user", messageText: "alpha meeting", recordedAt: "2023-01-01T00:00:00.000Z", timestamp: 1672531200000 }],
      l1: [{ ...fields, id: "mem-unit", content: "alpha meeting", type: "episodic", priority: 50, scene_name: "unit", source_message_ids: ["msg-unit"], metadata: {}, timestamps: ["2023-01-01T00:00:00.000Z"], createdAt: "2023-01-01T00:00:00.000Z", updatedAt: "2023-01-01T00:00:00.000Z", version: 1 }], scenes: [], persona: "" };
    const embedding = { getDimensions: () => 2, getProviderInfo: () => ({ provider: "unit", model: "unit" }), embed: async () => new Float32Array([1, 0]), embedBatch: async (ts: string[]) => ts.map(() => new Float32Array([1, 0])), isReady: () => true, startWarmup() {} };
    const idx = await indexSnapshot(snapshot, { embedding, logger: { info() {}, warn() {}, error() {} } } as unknown as ModelRuntime);
    try { for (const strategy of ["bm25", "dense", "hybrid"] as const) {
      const result = await idx.search("alpha", strategy); expect(result.l0.results[0].session_id).toBe("session-0000"); expect(result.l1.results[0].id).toBe("mem-unit");
    } expect(idx.coverage).toEqual({ l0: 1, l0_vec: 1, l1: 1, l1_vec: 1 }); } finally { idx.close(); }
  });
});
