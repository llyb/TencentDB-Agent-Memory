import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function parseEnv(file) {
  const result = {};
  for (const raw of file.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index > 0) result[line.slice(0, index)] = line.slice(index + 1);
  }
  return result;
}

function cosine(a, b) {
  let dot = 0; let aa = 0; let bb = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index]; aa += a[index] ** 2; bb += b[index] ** 2;
  }
  return dot / Math.sqrt(Math.max(Number.EPSILON, aa * bb));
}

const input = arg("input");
const output = arg("output");
const threshold = Number(arg("threshold", "0.78"));
if (!input || !output || !Number.isFinite(threshold) || threshold < -1 || threshold > 1) {
  throw new Error("usage: node dedupe-skill-snapshot.mjs --input snapshot.json --output deduped.json [--threshold 0.78]");
}

const experiment = path.resolve(import.meta.dirname);
const root = path.resolve(experiment, "..", "..");
const env = parseEnv(await readFile(path.join(root, "deploy", "global-images", ".env"), "utf8"));
const base = env.MEMORY_EMBEDDING_BASE_URL?.replace(/\/$/, "");
const key = env.MEMORY_EMBEDDING_API_KEY || env.MEMORY_LLM_API_KEY;
const model = env.MEMORY_EMBEDDING_MODEL;
if (!base || !key || !model) throw new Error("incomplete local embedding model config");

const skills = JSON.parse(await readFile(path.resolve(input), "utf8"));
const response = await fetch(`${base}/embeddings`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
  body: JSON.stringify({ model, input: skills.map((skill) => `${skill.name}\n${skill.description}\n${skill.content}`) }),
});
const body = await response.json();
if (!response.ok) throw new Error(`embedding ${response.status}: ${body.error?.message ?? "unknown error"}`);
const vectors = [...body.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);

const kept = [];
const removed = [];
for (let index = 0; index < skills.length; index += 1) {
  const duplicate = kept.find((entry) => cosine(vectors[index], entry.vector) >= threshold);
  if (duplicate) {
    removed.push({ id: skills[index].id, name: skills[index].name, duplicate_of: duplicate.skill.id });
  } else {
    const { embedding: _embedding, ...skill } = skills[index];
    kept.push({ skill, vector: vectors[index] });
  }
}

await writeFile(path.resolve(output), `${JSON.stringify(kept.map((entry) => entry.skill), null, 2)}\n`, "utf8");
console.log(JSON.stringify({ input, output, threshold, before: skills.length, after: kept.length, removed }, null, 2));
