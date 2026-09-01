import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { StandaloneLLMRunner } from "../src/adapters/standalone/llm-runner.js";
import { createEmbeddingService, type EmbeddingService } from "../src/core/store/embedding.js";
import type { LLMRunner, Logger } from "../src/core/types.js";
import { hash } from "./shared.js";

export const stageContext = new AsyncLocalStorage<{ question_id: string; stage: string }>();
export function modelRuntime(envFile: string, output: string) {
  const env = parseEnv(readFileSync(envFile, "utf8"));
  const need = (k: string) => { if (!env[k] || env[k] === "REPLACE_ME") throw new Error(`Missing ${k}`); return env[k]; };
  const config = { baseUrl: need("MEMORY_LLM_BASE_URL"), apiKey: need("MEMORY_LLM_API_KEY"), model: need("MEMORY_LLM_MODEL"), maxTokens: 8192, timeoutMs: 180000 };
  const embedConfig = { provider: "openai", baseUrl: need("MEMORY_EMBEDDING_BASE_URL"), apiKey: need("MEMORY_EMBEDDING_API_KEY"), model: need("MEMORY_EMBEDDING_MODEL"), dimensions: Number(need("MEMORY_EMBEDDING_DIMENSIONS")), sendDimensions: false, maxInputChars: 12000, timeoutMs: 60000 };
  const secretValues = [config.apiKey, embedConfig.apiKey];
  const safe = (text: string) => secretValues.reduce((s, key) => s.split(key).join("[REDACTED]"), text).replace(/sk-[\w-]+/g, "[REDACTED]");
  const logger: Logger = { info() {}, warn: msg => appendFileSync(join(output, "warnings.jsonl"), JSON.stringify({ ...stageContext.getStore(), level: "warn", message: safe(msg) }) + "\n"), error: msg => appendFileSync(join(output, "warnings.jsonl"), JSON.stringify({ ...stageContext.getStore(), level: "error", message: safe(msg) }) + "\n") };
  // Trace only the configured model endpoints, never request headers or credentials.
  const original = globalThis.fetch;
  const origins = [config.baseUrl, embedConfig.baseUrl].map(v => new URL(v).origin);
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!origins.includes(new URL(url).origin)) throw new Error("Evaluation disallows unconfigured outbound endpoints");
    const start = performance.now();
    const request = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    // Fixed experimental decoding settings, logged in the manifest. Do not
    // change deployment defaults; GLM enables thinking by default otherwise.
    if (request?.messages) {
      request.temperature = 0;
      if (/^glm-/i.test(request.model)) request.thinking = { type: "disabled" };
      init = { ...init, body: JSON.stringify(request) };
    }
    const context = stageContext.getStore();
    try {
      const response = await original(input, { ...init, redirect: "error" });
      const text = await response.clone().text();
      let body: any; try { body = JSON.parse(text); } catch { body = null; }
      appendFileSync(join(output, "api-calls.jsonl"), JSON.stringify({ ...context, endpoint: new URL(url).pathname,
        model: request?.model, status: response.status, elapsed_ms: performance.now() - start,
        request_hash: hash(request), response_hash: hash(text), usage: body?.usage ?? null,
        // Embedding vectors remain in the cache; text/tool traces make generation reproducible.
        request: request?.messages ? request : undefined, response: body?.choices ? body : undefined }) + "\n");
      if (body?.choices?.some((c: any) => c.finish_reason === "length")) throw new Error("Model output truncated");
      return response;
    } catch (e) { appendFileSync(join(output, "api-calls.jsonl"), JSON.stringify({ ...context, endpoint: new URL(url).pathname, status: "error", elapsed_ms: performance.now() - start }) + "\n"); throw new Error(safe(e instanceof Error ? e.message : String(e))); }
  };
  const makeRunner = (enableTools: boolean): LLMRunner => {
    const runner = new StandaloneLLMRunner({ config, enableTools, logger });
    return { run: p => runner.run({ ...p, timeoutMs: 180000 }) };
  };
  const embedding = createEmbeddingService(embedConfig, logger);
  if (!embedding) throw new Error("Embedding service unavailable; refusing silent BM25 fallback");
  const cacheDir = join(output, "embedding-cache"); mkdirSync(cacheDir, { recursive: true });
  const cache = new Map<string, Float32Array>();
  const cached: EmbeddingService = {
    getDimensions: () => embedding.getDimensions(), getProviderInfo: () => embedding.getProviderInfo(),
    isReady: () => true, startWarmup() {},
    embed: async text => (await cached.embedBatch([text]))[0],
    embedBatch: async texts => {
      const missing = [...new Set(texts)].filter(t => !cache.has(hash(t)));
      for (let i = 0; i < missing.length; i += 16) {
        const part = missing.slice(i, i + 16); const vectors = await embedding.embedBatch(part);
        if (vectors.length !== part.length) throw new Error("Embedding batch length mismatch");
        vectors.forEach((v, index) => {
          if (v.length !== embedConfig.dimensions || [...v].some(n => !Number.isFinite(n)) || !v.some(n => n !== 0)) throw new Error("Invalid embedding vector");
          cache.set(hash(part[index]), v);
          appendFileSync(join(cacheDir, "vectors.jsonl"), JSON.stringify({ text_hash: hash(part[index]), vector: [...v] }) + "\n");
        });
      }
      return texts.map(t => cache.get(hash(t))!);
    },
  };
  try { for (const line of readFileSync(join(cacheDir, "vectors.jsonl"), "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(line); cache.set(r.text_hash, new Float32Array(r.vector)); } } catch (e: any) { if (e.code !== "ENOENT") throw e; }
  async function chat(messages: any[], options: { model?: string; tools?: any[]; max_tokens?: number } = {}) {
    const response = await fetch(config.baseUrl.replace(/\/$/, "") + "/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: options.model ?? config.model, messages, temperature: 0, max_tokens: options.max_tokens ?? 2048, stream: false, ...(options.tools?.length ? { tools: options.tools } : {}) }), signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) throw new Error(`Chat HTTP ${response.status}`);
    const json: any = await response.json();
    if (!json.choices?.[0]?.message) throw new Error("Missing model message");
    if (json.choices[0].finish_reason === "length") throw new Error("Model output truncated");
    return json.choices[0].message;
  }
  return { logger, textRunner: makeRunner(false), toolRunner: makeRunner(true), embedding: cached, chat, safe,
    identity: { llm: config.model, llm_base: config.baseUrl, embedding: embedConfig.model, embedding_base: embedConfig.baseUrl, dimensions: embedConfig.dimensions, embedding_max_input_chars: embedConfig.maxInputChars, extraction_max_tokens: config.maxTokens, temperature: 0, glm_thinking: "disabled" },
    close: () => { globalThis.fetch = original; } };
}
export type ModelRuntime = ReturnType<typeof modelRuntime>;
