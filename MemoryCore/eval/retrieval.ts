import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { VectorStore } from "../src/core/store/sqlite.js";
import { executeMemorySearch } from "../src/core/tools/memory-search.js";
import type { IMemoryStore } from "../src/core/store/types.js";
import type { EmbeddingService } from "../src/core/store/embedding.js";
import type { Query, RecordItem, Strategy, Vectors } from "./schema.js";
import { hash } from "./shared.js";

const require = createRequire(import.meta.url);
let cachedRuntime: Record<string, string> | undefined;
function packageVersion(name: string): string {
  let directory = dirname(require.resolve(name));
  while (true) {
    const file = join(directory, "package.json");
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
      if (pkg.name === name && pkg.version) return pkg.version;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot identify installed package: ${name}`);
    directory = parent;
  }
}
export function runtimeInfo() {
  // A native Jieba dictionary is large. Validate it once per process, not once
  // per question/database (the full LongMemEval run creates 1,000 databases).
  if (cachedRuntime) return cachedRuntime;
  // Fail rather than quietly switch tokenizers and compare incompatible baselines.
  const { Jieba } = require("@node-rs/jieba");
  const { dict } = require("@node-rs/jieba/dict");
  Jieba.withDict(dict).cutForSearch("中文分词验证", true);
  cachedRuntime = { node: process.version, platform: process.platform, arch: process.arch,
    tokenizer: "@node-rs/jieba:cutForSearch",
    jieba_version: packageVersion("@node-rs/jieba"),
    sqlite_vec_version: packageVersion("sqlite-vec"),
    zod_version: packageVersion("zod"),
    tsx_version: packageVersion("tsx") };
  return cachedRuntime;
}
type RetrievalDataset = { records: RecordItem[]; queries: Query[]; dataset_hash: string };
export function validateVectors(vectors: Vectors, dataset: RetrievalDataset): void {
  if (vectors.dataset_hash !== dataset.dataset_hash) throw new Error("Embedding snapshot belongs to another dataset");
  const expected = new Set([...dataset.records.map(r => hash(r.content)), ...dataset.queries.map(q => hash(q.query))]);
  if (Object.keys(vectors.vectors).length !== expected.size) throw new Error("Embedding cache contains missing/extra texts");
  for (const key of expected) {
    const v = vectors.vectors[key];
    if (!v || v.length !== vectors.dimensions || v.some(n => !Number.isFinite(n)) || !v.some(n => n !== 0))
      throw new Error(`Invalid embedding vector: ${key}`);
    const norm = Math.hypot(...v);
    if (Math.abs(norm - 1) > 1e-4) throw new Error(`Embedding vector is not normalized: ${key}`);
  }
}

export function createRetriever(dataset: RetrievalDataset, vectors?: Vectors) {
  runtimeInfo();
  if (vectors) validateVectors(vectors, dataset);
  const warnings: string[] = [];
  const logger = { info: () => {}, warn: (msg: string) => warnings.push(msg), error: (msg: string) => warnings.push(msg) };
  // Never open a user's database. Reconstruct this immutable snapshot in memory once.
  const store = new VectorStore(":memory:", vectors?.dimensions ?? 0, logger);
  try {
    store.init(vectors ? { provider: vectors.provider, model: vectors.model } : undefined);
    if (store.isDegraded() || !store.isFtsAvailable() || warnings.length) throw new Error(`SQLite init failed: ${warnings.join("; ")}`);
    for (const r of dataset.records) {
      const vector = vectors ? new Float32Array(vectors.vectors[hash(r.content)]) : undefined;
      if (!store.upsertL1(r, vector) || warnings.length) throw new Error(`Snapshot indexing failed: ${r.id}: ${warnings.join("; ")}`);
    }
    const db = store.getRawDb();
    const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    if (count("l1_records") !== dataset.records.length || count("l1_fts") !== dataset.records.length ||
      (vectors && count("l1_vec") !== dataset.records.length)) throw new Error("Snapshot index count mismatch");
  } catch (e) { store.close(); throw e; }
  const embeddingService: EmbeddingService | undefined = vectors ? {
    embed: async text => {
      const v = vectors.vectors[hash(text)];
      if (!v) throw new Error("Query is not in frozen embedding cache");
      return new Float32Array(v);
    },
    embedBatch: async texts => texts.map(text => new Float32Array(vectors.vectors[hash(text)])),
    getDimensions: () => vectors.dimensions,
    getProviderInfo: () => ({ provider: vectors.provider, model: vectors.model }),
    isReady: () => true, startWarmup: () => {},
  } : undefined;
  return {
    close: () => store.close(),
    search: async (query: Pick<Query, "query" | "scope">, strategy: Strategy, k: number) => {
      if (strategy !== "bm25" && !vectors) throw new Error("Embedding cache required; fallback is not a baseline");
      warnings.length = 0;
      const lanes: Record<string, string[]> = {};
      // Only select capabilities and capture actual candidates; ranking stays in production code.
      const adapter = new Proxy(store, {
        get(target, property) {
          if (property === "isFtsAvailable") return () => strategy !== "dense" && target.isFtsAvailable();
          if (property === "searchL1Fts" || property === "searchL1Vector") {
            return (...args: unknown[]) => {
              const rows = Reflect.apply(target[property], target, args);
              lanes[property] = rows.map((r: { record_id: string }) => r.record_id);
              return rows;
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as IMemoryStore;
      const start = performance.now();
      const result = await executeMemorySearch({ query: query.query, limit: k, filter: query.scope,
        vectorStore: adapter, embeddingService: strategy === "bm25" ? undefined : embeddingService, logger });
      const elapsed_ms = performance.now() - start;
      const effective = result.strategy === "fts" ? "bm25" : result.strategy === "embedding" ? "dense" : result.strategy;
      return { results: result.results, actual_strategy: effective, production_strategy: result.strategy,
        candidate_ids: [...new Set(Object.values(lanes).flat())], lanes, elapsed_ms, warnings: [...warnings],
        backend: strategy === "bm25" ? "sqlite-fts5-bm25" : strategy === "dense" ? "sqlite-vec-cosine" : "sqlite-fts5+vec-client-rrf" };
    },
  };
}
