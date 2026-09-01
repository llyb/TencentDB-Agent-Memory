import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { hash, readJson, sourceInfo } from "./shared.js";
import type { MemorySnapshot } from "./system-memory.js";

/** Reuse only frozen, verified memory content. Never copy reader answers or judge labels. */
export function loadFrozenRun(run: string, ids: string[], source: ReturnType<typeof sourceInfo>, models: unknown, dataset: unknown) {
  const manifest = readJson(join(run, "manifest.json")) as any;
  const summary = readJson(join(run, "summary.json")) as any;
  if (manifest.snapshot_source) throw new Error("Use the original memory-building run as --snapshot-run, not another replay");
  if (hash(manifest.models) !== hash(models) || hash(manifest.dataset) !== hash(dataset)) {
    throw new Error("Snapshot model/data mismatch");
  }
  const buildFile = (file: string) => file.startsWith("src/") || [
    "package.json", "eval/system-memory.ts", "eval/system-model.ts", "eval/shared.ts", "eval/longmemeval-data.ts",
  ].includes(file);
  const buildSources = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).filter(([file]) => buildFile(file)));
  if (hash(buildSources(manifest.source_files)) !== hash(buildSources(source.source_files))) {
    throw new Error("Snapshot builder source mismatch; rebuild memories");
  }
  const snapshots = ids.map(id => {
    if (!manifest.selected_question_ids.includes(id)) throw new Error(`Question absent from snapshot run: ${id}`);
    const snapshot = readJson(join(run, hash(id).slice(0, 20), "snapshot.json")) as MemorySnapshot;
    const expected = summary.builds.find((b: any) => b.question_id === id)?.snapshot_hash;
    if (!expected || hash(snapshot) !== expected) throw new Error(`Frozen snapshot hash mismatch: ${id}`);
    return { question_id: id, snapshot, snapshot_hash: expected };
  });
  // Historical build cost is separate from calls in the new run; no double counting.
  const trace = join(run, "api-calls.jsonl");
  const calls: any[] = existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const buildCalls = calls.filter(c => ids.includes(c.question_id) && ["l0-l1", "l2", "l3"].includes(c.stage));
  return { snapshots, provenance: {
    run: basename(run), fingerprint: manifest.fingerprint, source_hash: manifest.source_hash,
    snapshot_hashes: Object.fromEntries(snapshots.map(s => [s.question_id, s.snapshot_hash])),
    historical_build_cost: { requests: buildCalls.length, failed: buildCalls.filter(c => c.status !== 200).length, total_tokens: buildCalls.reduce((n, c) => n + (c.usage?.total_tokens ?? 0), 0),
      note: "Reused L0-L3 build only; excluded from this run API total. Embeddings and all answers are recomputed." },
  } };
}

export function installFrozenSnapshots(output: string, snapshots: ReturnType<typeof loadFrozenRun>["snapshots"]) {
  for (const { question_id, snapshot } of snapshots) {
    const dir = join(output, hash(question_id).slice(0, 20)); mkdirSync(dir, { recursive: true });
    const file = join(dir, "snapshot.json");
    if (existsSync(file)) {
      if (hash(readJson(file)) !== hash(snapshot)) throw new Error("Resume snapshot differs from frozen source");
    } else writeFileSync(file, JSON.stringify(snapshot, null, 2) + "\n", { flag: "wx" });
  }
}

/** Preserve every scene filename before allocating remaining profile space to L3. */
export function profileContext(snapshot: Pick<MemorySnapshot, "scenes" | "persona">, cap: number) {
  const header = "L2 scene navigation (read_scene accepts filename):\n";
  const personaHeader = "\nL3 persona:\n";
  const names = snapshot.scenes.map(s => s.filename).join("\n");
  const navigationCap = Math.max(names.length + header.length, Math.floor(cap / 2));
  if (navigationCap + personaHeader.length > cap) throw new Error("Scene filenames exceed profile budget");
  const perSummary = snapshot.scenes.length ? Math.max(0, Math.floor((navigationCap - header.length - names.length) / snapshot.scenes.length) - 2) : 0;
  const navigation = header + snapshot.scenes.map(s => s.filename + (perSummary ? `: ${s.summary.slice(0, perSummary)}` : "")).join("\n");
  const persona = snapshot.persona.slice(0, Math.max(0, cap - navigation.length - personaHeader.length));
  return { text: navigation + personaHeader + persona, navigation_chars: navigation.length, persona_chars: persona.length,
    persona_truncated: persona.length < snapshot.persona.length, visible_scenes: snapshot.scenes.length };
}

/** Keep valid JSON and interleave both layers; crop content, never cut JSON syntax. */
export function retrievalContext(l0: { id: string; content: string }[], l1: { id: string; content: string }[], cap: number) {
  const records: { layer: string; id: string; content: string }[] = [];
  for (let i = 0; i < Math.max(l0.length, l1.length); i++) {
    if (l0[i]) records.push({ ...l0[i], layer: "L0" });
    if (l1[i]) records.push({ ...l1[i], layer: "L1" });
  }
  const encode = (limit: number) => JSON.stringify({ evidence: records.map(r => ({ ...r,
    content: r.content.slice(0, limit), content_truncated: r.content.length > limit })) });
  // Small user-specified budgets may not even fit all metadata. Drop lowest ranks first.
  while (records.length && encode(0).length + 64 * records.length > cap) records.pop();
  if (encode(0).length > cap) throw new Error("Retrieval budget too small");
  let low = 0; let high = Math.max(0, ...records.map(r => r.content.length));
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encode(mid).length <= cap) low = mid; else high = mid - 1;
  }
  return { text: encode(low), delivered: records.map(r => ({ layer: r.layer, id: r.id })),
    dropped_records: l0.length + l1.length - records.length, truncated_records: records.filter(r => r.content.length > low).length };
}
