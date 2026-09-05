import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEncoding } from "../../MemoryCore/node_modules/js-tiktoken/dist/index.js";

import { p0Prompt, p3Prompt } from "./measure-prompt-tokens.mts";

type PromptVersion = "p0" | "p3" | "pnone";
type EvalCase = {
  case_id: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  expected_family: "memory" | "skill" | "knowledge" | "none";
};

function argsOf(argv: string[]) {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) out.set(argv[i].replace(/^--/, ""), argv[i + 1]);
  return out;
}

function loadEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) continue;
    const at = line.indexOf("=");
    result[line.slice(0, at)] = line.slice(at + 1).replace(/^['"]|['"]$/g, "");
  }
  return result;
}

function completionsUrl(base: string): string {
  const clean = base.replace(/\/$/, "");
  return clean.endsWith("/v1") ? `${clean}/chat/completions` : `${clean}/v1/chat/completions`;
}

function commandOf(call: Record<string, unknown>): string {
  const fn = call.function as Record<string, unknown> | undefined;
  if (!fn || typeof fn.arguments !== "string") return "";
  try {
    const parsed = JSON.parse(fn.arguments) as Record<string, unknown>;
    return [parsed.command, parsed.cmd, parsed.script].find((value) => typeof value === "string") as string ?? fn.arguments;
  } catch {
    return fn.arguments;
  }
}

function classifyAssetCall(toolCalls: unknown): { family: "memory" | "skill" | "knowledge"; tool: string } | null {
  if (!Array.isArray(toolCalls)) return null;
  for (const raw of toolCalls) {
    const call = raw as Record<string, unknown>;
    const command = commandOf(call);
    if (/memory-bridge\/v3\/(?:atomic|conversation|scenario)\//i.test(command)) return { family: "memory", tool: command };
    if (/skill-bridge\/v3\/skill\//i.test(command)) return { family: "skill", tool: command };
    if (/\/tools\/(?:list|call)\b/i.test(command)) return { family: "knowledge", tool: command };
  }
  return null;
}

async function postWithRetry(url: string, apiKey: string, body: Record<string, unknown>) {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
      return JSON.parse(text) as Record<string, unknown>;
    } catch (error) {
      lastError = error as Error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw lastError;
}

const options = argsOf(process.argv.slice(2));
const version = (options.get("version") ?? "p3") as PromptVersion;
if (!(["p0", "p3", "pnone"] as string[]).includes(version)) throw new Error("--version must be p0, p3, or pnone");
const split = options.get("split") ?? "dev";
const limit = Number(options.get("limit") ?? "0");
const samplePerFamily = Number(options.get("sample-per-family") ?? "0");
const concurrency = Math.max(1, Number(options.get("concurrency") ?? "2"));
const seed = Number(options.get("seed") ?? "1");
const root = path.resolve(import.meta.dirname, "../..");
const env = loadEnv(await readFile(path.join(root, "deploy/global-images/.env"), "utf8"));
const model = options.get("model") ?? env.PROXY_UPSTREAM_MODEL ?? env.MEMORY_LLM_MODEL;
const baseUrl = env.PROXY_UPSTREAM_URL ?? env.MEMORY_LLM_BASE_URL;
const apiKey = env.PROXY_UPSTREAM_API_KEY ?? env.MEMORY_LLM_API_KEY;
if (!model || !baseUrl || !apiKey) throw new Error("Local model configuration is incomplete");

const source = await readFile(path.join(import.meta.dirname, `datasets/proxy-${split}.jsonl`), "utf8");
const allCases = source.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as EvalCase);
const sampled = samplePerFamily > 0
  ? (["memory", "skill", "knowledge", "none"] as const).flatMap((family) =>
      allCases.filter((item) => item.expected_family === family).slice(0, samplePerFamily))
  : allCases;
const cases = limit > 0 ? sampled.slice(0, limit) : sampled;
const injectedPrompt = version === "p0" ? p0Prompt : version === "p3" ? p3Prompt : "";
const system = [
  "You are a coding agent working in repository org/repo. Decide whether the user request requires one of the injected cloud assets.",
  "When an asset is needed, immediately call the Bash tool with the documented curl command. Do not merely print the command.",
  injectedPrompt,
].join("\n\n");
const encoding = getEncoding("o200k_base");
const injectedTokens = encoding.encode(injectedPrompt).length;
const promptHash = createHash("sha256").update(injectedPrompt).digest("hex").slice(0, 16);
const results = new Array<Record<string, unknown>>(cases.length);
let cursor = 0;

async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= cases.length) return;
    const item = cases[index];
    const response = await postWithRetry(completionsUrl(baseUrl), apiKey, {
      model,
      temperature: 0,
      seed,
      max_tokens: 512,
      messages: [{ role: "system", content: system }, ...item.messages],
      tools: [{
        type: "function",
        function: {
          name: "Bash",
          description: "Execute a shell command. Use this when injected asset instructions require a curl call.",
          parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
        },
      }],
      tool_choice: "auto",
    });
    const choices = response.choices as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.message as Record<string, unknown> | undefined;
    const asset = classifyAssetCall(message?.tool_calls);
    const nativeCalls = Array.isArray(message?.tool_calls)
      ? message.tool_calls.map((raw) => {
          const call = raw as Record<string, unknown>;
          const fn = call.function as Record<string, unknown> | undefined;
          return { name: fn?.name ?? null, command: commandOf(call).slice(0, 500) };
        })
      : [];
    const usage = response.usage as Record<string, unknown> | undefined;
    results[index] = {
      case_id: item.case_id,
      did_call: asset !== null,
      actual_first_family: asset?.family ?? null,
      actual_first_tool: asset?.tool.slice(0, 500) ?? null,
      native_tool_calls: nativeCalls,
      assistant_text: typeof message?.content === "string" ? message.content.slice(0, 1000) : null,
      injected_tokens: injectedTokens,
      provider_prompt_tokens: usage?.prompt_tokens ?? null,
      provider_completion_tokens: usage?.completion_tokens ?? null,
      prompt_version: version,
      prompt_hash: promptHash,
      model,
      seed,
    };
    console.log(`[${index + 1}/${cases.length}] ${item.case_id}: ${asset?.family ?? "none"}`);
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, () => worker()));
const output = options.get("output")
  ? path.resolve(options.get("output")!)
  : path.join(import.meta.dirname, "runs", `${model}-${version}-${split}-seed${seed}.jsonl`);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${results.map(JSON.stringify).join("\n")}\n`, "utf8");
console.log(`Wrote ${results.length} rows to ${output}`);
