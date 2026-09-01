import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { VectorStore } from "../src/core/store/sqlite.js";
import type { IMemoryStore, L0Record } from "../src/core/store/types.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";
import { recordConversation } from "../src/core/conversation/l0-recorder.js";
import { extractL1Memories } from "../src/core/record/l1-extractor.js";
import { SceneExtractor } from "../src/core/scene/scene-extractor.js";
import { PersonaGenerator } from "../src/core/persona/persona-generator.js";
import { readSceneIndex } from "../src/core/scene/scene-index.js";
import { stripSceneNavigation } from "../src/core/scene/scene-navigation.js";
import { executeMemorySearch } from "../src/core/tools/memory-search.js";
import { executeConversationSearch } from "../src/core/tools/conversation-search.js";
import type { ModelRuntime } from "./system-model.js";
import { stageContext } from "./system-model.js";
import { hash } from "./shared.js";

export interface History { sessions: { id: string; date: string; messages: { role: "user" | "assistant"; content: string }[] }[] }
export interface MemorySnapshot {
  history_hash: string; l0: L0Record[]; l1: MemoryRecord[];
  scenes: { filename: string; summary: string; content: string }[]; persona: string;
  build_ms: number; input_messages: number; captured_messages: number; l1_extracted: number;
  invalid_source_ids: number; source_ids: number; l2_empty_batches: number;
}
const scope = { teamId: "eval", userId: "eval-user", agentId: "eval-agent" };
const save = (file: string, data: unknown) => writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
export async function buildMemory(history: History, dir: string, runtime: ModelRuntime): Promise<MemorySnapshot> {
  const snapshotPath = join(dir, "snapshot.json");
  if (existsSync(snapshotPath)) {
    const snapshot: MemorySnapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    if (snapshot.history_hash !== hash(history)) throw new Error("History changed; cannot resume this snapshot");
    return snapshot;
  }
  mkdirSync(dir, { recursive: true });
  const started = performance.now();
  const store = new VectorStore(":memory:", 0, runtime.logger); store.init();
  if (store.isDegraded() || !store.isFtsAvailable()) throw new Error("Production SQLite FTS unavailable");
  const l0: L0Record[] = []; let records = new Map<string, MemoryRecord>(); let extracted = 0;
  try {
    for (const [index, session] of history.sessions.entries()) {
      const file = join(dir, `session-${index}.json`);
      if (existsSync(file)) {
        const saved = JSON.parse(readFileSync(file, "utf8"));
        if (saved.input_hash !== hash(session)) throw new Error("Session checkpoint mismatch");
        l0.push(...saved.l0); extracted += saved.extracted;
        for (const r of saved.l1) { records.set(r.id, r); store.upsertL1(r, undefined); }
        continue;
      }
      const attemptDir = join(dir, `capture-${index}-${Date.now()}`); mkdirSync(attemptDir);
      const before = new Set(records.keys()); let sessionExtracted = 0;
      const messages = await recordConversation({ sessionKey: session.id, sessionId: session.id,
        userId: scope.userId, agentId: scope.agentId, baseDir: attemptDir, logger: runtime.logger,
        rawMessages: session.messages.map((m, i) => ({ ...m, timestamp: Date.parse(session.date) + i })), afterTimestamp: 0 });
      const raw = messages.map(m => ({ ...scope, id: m.id, sessionKey: session.id, sessionId: session.id,
        role: m.role, messageText: m.content, timestamp: m.timestamp, recordedAt: new Date(m.timestamp).toISOString() }));
      l0.push(...raw);
      // Ten new messages + five background messages matches the production extractor defaults.
      for (let offset = 0; offset < messages.length; offset += 10) {
        const part = messages.slice(Math.max(0, offset - 5), offset + 10);
        const newCount = Math.min(10, messages.length - offset);
        const result = await extractL1Memories({ ...scope, messages: part, sessionKey: session.id, sessionId: session.id,
          baseDir: attemptDir, config: {}, logger: runtime.logger, options: { maxMessagesPerExtraction: newCount,
            maxBackgroundMessages: 5, maxMemoriesPerSession: 10, enableDedup: true,
            vectorStore: store, llmRunner: runtime.textRunner } });
        if (!result.success) throw new Error(`L1 extraction failed at session ${index}, batch ${offset}`);
        sessionExtracted += result.extractedCount;
        for (const record of result.records) records.set(record.id, record);
      }
      const alive = new Set((store.getRawDb().prepare("SELECT record_id FROM l1_records").all() as { record_id: string }[]).map(r => r.record_id));
      records = new Map([...records].filter(([id]) => alive.has(id)));
      save(file, { input_hash: hash(session), l0: raw, l1: [...records.values()].filter(r => !before.has(r.id)), extracted: sessionExtracted });
      extracted += sessionExtracted;
      console.log(JSON.stringify({ ...stageContext.getStore(), sessions_complete: index + 1, sessions_total: history.sessions.length, l1_records: records.size }));
    }
  } finally { store.close(); }
  const l1 = [...records.values()];
  if (!l1.length) throw new Error("No L1 records generated; full memory build failed");
  const profileDir = join(dir, "profiles"); mkdirSync(profileDir, { recursive: true });
  const scene = new SceneExtractor({ dataDir: profileDir, config: {}, maxScenes: 20,
    llmRunner: runtime.toolRunner, logger: runtime.logger, timeoutMs: 180000 });
  let empty = 0;
  for (let i = 0; i < l1.length; i += 50) {
    const marker = join(dir, `l2-${i}.json`);
    if (existsSync(marker)) { empty += Number(JSON.parse(readFileSync(marker, "utf8")).emptyExtraction); continue; }
    const result = await stageContext.run({ ...stageContext.getStore()!, stage: "l2" }, () => scene.extract(l1.slice(i, i + 50).map(r => ({ id: r.id, content: r.content, created_at: r.timestamps[0] ?? r.createdAt }))));
    if (!result.success) throw new Error("L2 scene extraction failed");
    empty += Number(!!result.emptyExtraction); save(marker, result);
  }
  const index = await readSceneIndex(profileDir);
  if (!index.length) throw new Error("No L2 scenes produced");
  const generated = await stageContext.run({ ...stageContext.getStore()!, stage: "l3" }, () => new PersonaGenerator({ dataDir: profileDir, config: {}, llmRunner: runtime.toolRunner, logger: runtime.logger }).generate("All official history has been ingested; evaluation barrier"));
  if (!generated && !existsSync(join(profileDir, "persona.md"))) throw new Error("L3 persona missing");
  const scenes = (await readSceneIndex(profileDir)).map(e => {
    if (basename(e.filename) !== e.filename) throw new Error("Unsafe scene path");
    return { filename: e.filename, summary: e.summary, content: readFileSync(join(profileDir, "scene_blocks", e.filename), "utf8") };
  });
  const ids = new Set(l0.map(r => r.id)); const sourceIds = l1.flatMap(r => r.source_message_ids);
  const snapshot: MemorySnapshot = { history_hash: hash(history), l0, l1, scenes,
    persona: stripSceneNavigation(readFileSync(join(profileDir, "persona.md"), "utf8")),
    build_ms: performance.now() - started, input_messages: history.sessions.reduce((n, s) => n + s.messages.length, 0), captured_messages: l0.length,
    l1_extracted: extracted, source_ids: sourceIds.length, invalid_source_ids: sourceIds.filter(id => !ids.has(id)).length, l2_empty_batches: empty };
  save(snapshotPath, snapshot); return snapshot;
}

export type SearchStrategy = "bm25" | "dense" | "hybrid";
export async function indexSnapshot(snapshot: MemorySnapshot, runtime: ModelRuntime) {
  const store = new VectorStore(":memory:", runtime.embedding.getDimensions(), runtime.logger);
  store.init(runtime.embedding.getProviderInfo());
  if (store.isDegraded() || !store.isFtsAvailable() || !store.getCapabilities().vectorSearch) throw new Error("Dense/FTS index unavailable");
  const start = performance.now();
  const texts = [...snapshot.l0.map(r => r.messageText), ...snapshot.l1.map(r => r.content)];
  const vectors = await runtime.embedding.embedBatch(texts);
  for (let i = 0; i < snapshot.l0.length; i++) if (!store.upsertL0(snapshot.l0[i], vectors[i])) throw new Error("L0 indexing failed");
  for (let i = 0; i < snapshot.l1.length; i++) if (!store.upsertL1(snapshot.l1[i], vectors[i + snapshot.l0.length])) throw new Error("L1 indexing failed");
  const db = store.getRawDb(); const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n);
  const coverage = { l0: count("l0_conversations"), l0_vec: count("l0_vec"), l1: count("l1_records"), l1_vec: count("l1_vec") };
  if (coverage.l0 !== coverage.l0_vec || coverage.l1 !== coverage.l1_vec) throw new Error("Incomplete embedding coverage");
  const search = async (query: string, strategy: SearchStrategy, k = 5) => {
    const lanes: Record<string, string[]> = {};
    const adapter = new Proxy(store, { get(target, prop) {
      if (prop === "isFtsAvailable") return () => strategy !== "dense";
      const value = Reflect.get(target, prop);
      if (["searchL0Fts", "searchL0Vector", "searchL1Fts", "searchL1Vector"].includes(String(prop))) return (...args: unknown[]) => {
        const rows = Reflect.apply(value, target, args) as { record_id: string }[]; lanes[String(prop)] = rows.map(r => r.record_id); return rows;
      };
      return typeof value === "function" ? value.bind(target) : value;
    } }) as IMemoryStore;
    const warnings: string[] = [];
    const searchLogger = { ...runtime.logger, warn: (msg: string) => { warnings.push(msg); runtime.logger.warn(msg); } };
    const params = { query, limit: k, vectorStore: adapter, embeddingService: strategy === "bm25" ? undefined : runtime.embedding, filter: scope, logger: searchLogger };
    const t = performance.now();
    const [l0, l1] = await Promise.all([executeConversationSearch(params), executeMemorySearch(params)]);
    const expected = { bm25: "fts", dense: "embedding", hybrid: "hybrid" }[strategy];
    // A valid empty FTS lane is not an outage. Preserve actual strategy labels;
    // exceptions caught by production fallback paths are fatal to evaluation.
    if (warnings.length || (strategy !== "hybrid" && (l0.strategy !== expected || l1.strategy !== expected))) throw new Error(`Retrieval degraded: ${l0.strategy}/${l1.strategy}, expected ${expected}`);
    return { l0, l1, lanes, elapsed_ms: performance.now() - t };
  };
  return { search, close: () => store.close(), coverage, index_ms: performance.now() - start };
}
