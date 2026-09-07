import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type Row = Record<string, unknown>;
type Skill = {
  id: string;
  name: string;
  description: string;
  content: string;
  source_task_id: string;
  sequence_index: number;
  embedding?: number[];
};

const root = path.resolve(import.meta.dirname, "..", "..");
const experiment = path.resolve(import.meta.dirname);

function parseEnv(file: string) {
  const result: Record<string, string> = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index > 0) result[line.slice(0, index)] = line.slice(index + 1);
  }
  return result;
}

function arg(name: string, fallback?: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const group = arg("group", "S0")!;
const split = arg("split", "dev")!;
const seed = Number(arg("seed", "1"));
const offset = Number(arg("offset", "0"));
const limit = Number(arg("limit", "0"));
const evaluate = process.argv.includes("--evaluate");
const skillEnabled = group !== "S0";
const extractionEnabled = !process.argv.includes("--disable-extraction");
const skillSnapshot = arg("skill-snapshot");
const runLabel = arg("run-label")?.replace(/[^a-zA-Z0-9_-]/g, "-");
const routingMode = arg("routing", "bm25")!;
const topK = Number(arg("top-k", "20"));
const routingThreshold = Number(arg("routing-threshold", "0"));
const charBudgetPercent = Number(arg("char-budget-percent", "0.01"));
const contextWindowChars = Number(arg("context-window-chars", "800000"));
const toolCallThreshold = Number(arg("tool-call-threshold", "10"));
const bytesThreshold = Number(arg("bytes-threshold", "40960"));
const maxTokens = Number(arg("max-tokens", "4096"));
const extractionMaxTokens = Number(arg("extraction-max-tokens", "2048"));

if (!/^S[0-5]$/.test(group) || !["dev", "test"].includes(split)) {
  throw new Error("--group must be S0..S5 and --split must be dev or test");
}
if (!["bm25", "embedding", "hybrid"].includes(routingMode)) {
  throw new Error("--routing must be bm25, embedding, or hybrid");
}

const env = parseEnv(path.join(root, "deploy", "global-images", ".env"));
const chatBase = env.MEMORY_LLM_BASE_URL?.replace(/\/$/, "");
const chatKey = env.MEMORY_LLM_API_KEY;
const chatModel = env.MEMORY_LLM_MODEL;
const embeddingBase = env.MEMORY_EMBEDDING_BASE_URL?.replace(/\/$/, "");
const embeddingKey = env.MEMORY_EMBEDDING_API_KEY || chatKey;
const embeddingModel = env.MEMORY_EMBEDDING_MODEL;
if (!chatBase || !chatKey || !chatModel) throw new Error("incomplete local chat model config");
if ((routingMode === "embedding" || routingMode === "hybrid")
  && (!embeddingBase || !embeddingKey || !embeddingModel)) {
  throw new Error("incomplete local embedding model config");
}

async function jsonl(file: string) {
  return (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function chat(messages: Array<{role: string; content: string}>, tokenLimit: number) {
  const response = await fetch(`${chatBase}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${chatKey}` },
    body: JSON.stringify({ model: chatModel, messages, temperature: 0, seed, max_tokens: tokenLimit }),
  });
  const body = await response.json() as any;
  if (!response.ok) throw new Error(`chat ${response.status}: ${body.error?.message ?? "unknown error"}`);
  return {
    text: String(body.choices?.[0]?.message?.content ?? ""),
    inputTokens: Number(body.usage?.prompt_tokens ?? 0),
    outputTokens: Number(body.usage?.completion_tokens ?? 0),
  };
}

async function embed(inputs: string[]) {
  if (inputs.length === 0) return { vectors: [] as number[][], tokens: 0 };
  const response = await fetch(`${embeddingBase}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${embeddingKey}` },
    body: JSON.stringify({ model: embeddingModel, input: inputs }),
  });
  const body = await response.json() as any;
  if (!response.ok) throw new Error(`embedding ${response.status}: ${body.error?.message ?? "unknown error"}`);
  return {
    vectors: [...body.data].sort((a, b) => a.index - b.index).map((item) => item.embedding as number[]),
    tokens: Number(body.usage?.total_tokens ?? body.usage?.prompt_tokens ?? 0),
  };
}

function terms(text: string) {
  return new Set(text.toLowerCase().match(/[a-z_][a-z0-9_]+/g) ?? []);
}

function bm25Like(query: string, skill: Skill) {
  const q = terms(query);
  const d = terms(`${skill.name} ${skill.description} ${skill.content}`);
  let overlap = 0;
  for (const term of q) if (d.has(term)) overlap += 1;
  return overlap / Math.sqrt(Math.max(1, q.size * d.size));
}

function cosine(a: number[], b: number[]) {
  let dot = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i];
  }
  return dot / Math.sqrt(Math.max(Number.EPSILON, aa * bb));
}

async function route(query: string, skills: Skill[]) {
  if (!skillEnabled || skills.length === 0) return { selected: [] as Skill[], tokens: 0 };
  let routingTokens = 0;
  let embeddingScores = new Map<string, number>();
  if (routingMode !== "bm25") {
    const missing = skills.filter((skill) => !skill.embedding);
    if (missing.length > 0) {
      const result = await embed(missing.map((skill) => `${skill.name}\n${skill.description}\n${skill.content}`));
      routingTokens += result.tokens;
      missing.forEach((skill, index) => { skill.embedding = result.vectors[index]; });
    }
    const queryResult = await embed([query]);
    routingTokens += queryResult.tokens;
    embeddingScores = new Map(skills.map((skill) => [skill.id, cosine(queryResult.vectors[0], skill.embedding!)]));
  }
  const bm25Scores = new Map(skills.map((skill) => [skill.id, bm25Like(query, skill)]));
  const score = (skill: Skill) => routingMode === "bm25"
    ? bm25Scores.get(skill.id)!
    : routingMode === "embedding"
      ? embeddingScores.get(skill.id)!
      : bm25Scores.get(skill.id)! + embeddingScores.get(skill.id)!;
  const ranked = [...skills]
    .filter((skill) => score(skill) >= routingThreshold)
    .sort((a, b) => score(b) - score(a));
  const budget = Math.max(0, Math.floor(contextWindowChars * charBudgetPercent));
  const selected: Skill[] = [];
  let used = 0;
  for (const skill of ranked.slice(0, topK)) {
    const chars = skill.content.length;
    if (used + chars > budget) continue;
    selected.push(skill); used += chars;
  }
  return { selected, tokens: routingTokens };
}

function normalizeCompletion(text: string, prompt: string) {
  let value = text.trimEnd();
  const fenced = value.match(/^\s*```(?:python)?\r?\n([\s\S]*?)```$/i);
  if (fenced) value = fenced[1].trimEnd();
  if (value.startsWith(prompt)) value = value.slice(prompt.length);
  value = value.replace(/^\r?\n/, "");
  return `\n${value}`;
}

async function extractSkill(task: Row, completion: string, sequenceIndex: number) {
  const transcript = `${task.prompt}\n${completion}`;
  const bytes = Buffer.byteLength(transcript, "utf8");
  const archiveTriggered = 0 >= toolCallThreshold || bytes >= bytesThreshold;
  if (!skillEnabled || !extractionEnabled) {
    return { archiveTriggered: false, skill: null as Skill | null, tokens: 0 };
  }
  if (!archiveTriggered) {
    return { archiveTriggered, skill: null as Skill | null, tokens: 0 };
  }
  const result = await chat([
    { role: "system", content: "Extract at most one reusable Python problem-solving Skill. Return strict JSON: either {\"abstain\":true} or {\"name\":\"lowercase-hyphen-name\",\"description\":\"when it applies\",\"content\":\"ordered method, edge cases, and validation\"}. Do not copy the full solution or task ID. Abstain when the transcript contains no reusable method." },
    { role: "user", content: transcript },
  ], extractionMaxTokens);
  let parsed: any;
  try {
    parsed = JSON.parse(result.text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
  } catch {
    parsed = { abstain: true };
  }
  if (parsed.abstain || !parsed.name || !parsed.content) {
    return { archiveTriggered, skill: null, tokens: result.inputTokens + result.outputTokens };
  }
  const digest = createHash("sha256").update(`${task.task_id}\n${parsed.name}`).digest("hex").slice(0, 12);
  return {
    archiveTriggered,
    tokens: result.inputTokens + result.outputTokens,
    skill: {
      id: `skl-${digest}`,
      name: String(parsed.name),
      description: String(parsed.description ?? ""),
      content: String(parsed.content),
      source_task_id: String(task.task_id),
      sequence_index: sequenceIndex,
    } satisfies Skill,
  };
}

const manifestPath = path.join(experiment, "datasets", "humaneval", `${split}.jsonl`);
const allTasks = await jsonl(manifestPath);
const tasks = limit > 0 ? allTasks.slice(offset, offset + limit) : allTasks.slice(offset);
const runName = `${group.toLowerCase()}-${split}-seed${seed}${offset > 0 ? `-o${offset}` : ""}${limit > 0 ? `-n${limit}` : ""}${runLabel ? `-${runLabel}` : ""}`;
const runDir = path.join(experiment, "runs", "humaneval");
await mkdir(runDir, { recursive: true });
const samplesPath = path.join(runDir, `${runName}-samples.jsonl`);
const telemetryPath = path.join(runDir, `${runName}-telemetry.jsonl`);
const skillsPath = path.join(runDir, `${runName}-skills.json`);
const samples: Row[] = [];
const telemetry: Row[] = [];
const skills: Skill[] = skillSnapshot
  ? JSON.parse(await readFile(path.resolve(skillSnapshot), "utf8")) as Skill[]
  : [];
const snapshotSkillIds = skills.map((skill) => skill.id);

for (const task of tasks) {
  const routed = await route(String(task.prompt), skills);
  const injection = routed.selected.length === 0 ? "" : `\n\nReusable Skills (use only when applicable):\n${routed.selected.map((skill) => `<skill name="${skill.name}">\n${skill.content}\n</skill>`).join("\n")}`;
  const solved = await chat([
    { role: "system", content: "Complete the provided Python function. Return only the code that must be appended to the prompt. Do not use Markdown fences, repeat the prompt, or explain the answer." },
    { role: "user", content: `${task.prompt}${injection}` },
  ], maxTokens);
  const completion = normalizeCompletion(solved.text, String(task.prompt));
  samples.push({ task_id: task.task_id, completion });
  const extracted = await extractSkill(task, completion, Number(task.sequence_index));
  if (extracted.skill) skills.push(extracted.skill);
  telemetry.push({
    run_id: randomUUID(),
    task_id: task.task_id,
    family: task.family,
    sequence_index: task.sequence_index,
    group,
    seed,
    pass: false,
    turns: 1,
    solve_input_tokens: solved.inputTokens,
    solve_output_tokens: solved.outputTokens,
    skill_extraction_tokens: extracted.tokens,
    skill_routing_tokens: routed.tokens,
    archive_triggered: extracted.archiveTriggered,
    extracted_skill_ids: extracted.skill ? [extracted.skill.id] : [],
    injected_skill_ids: routed.selected.map((skill) => skill.id),
    snapshot_skill_ids: snapshotSkillIds,
    model: chatModel,
    embedding_model: routingMode === "bm25" ? null : embeddingModel,
    routing_mode: routingMode,
  });
  await writeFile(samplesPath, samples.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  await writeFile(telemetryPath, telemetry.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  await writeFile(skillsPath, JSON.stringify(skills, null, 2) + "\n", "utf8");
  process.stdout.write(`${task.task_id} completed\n`);
}

if (evaluate) {
  const image = "tdai-humaneval-evaluator:local";
  const mounted = path.resolve(runDir);
  execFileSync("docker", [
    "run", "--rm", "--network", "none", "--memory", "1g", "--cpus", "2",
    "--pids-limit", "256", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "-v", `${mounted}:/work`, image, `/work/${path.basename(samplesPath)}`,
  ], { stdio: "inherit" });
  const resultPath = `${samplesPath}_results.jsonl`;
  if (!existsSync(resultPath)) throw new Error(`missing evaluator output: ${resultPath}`);
  const results = readFileSync(resultPath, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const passed = new Map(results.map((row) => [row.task_id, Boolean(row.passed)]));
  for (const row of telemetry) row.pass = passed.get(row.task_id) ?? false;
  await writeFile(telemetryPath, telemetry.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

console.log(JSON.stringify({ runName, taskCount: tasks.length, samplesPath, telemetryPath, skills: skills.length }, null, 2));
