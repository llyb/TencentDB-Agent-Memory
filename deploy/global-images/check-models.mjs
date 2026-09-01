#!/usr/bin/env node
// Read .env as data, never execute it. No network unless --live is explicit.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";

const { values } = parseArgs({ options: {
  "env-file": { type: "string" }, live: { type: "boolean", default: false },
} });
const envFile = values["env-file"] ?? fileURLToPath(new URL(".env", import.meta.url));
const required = (env, key) => {
  const value = env[key]?.trim();
  if (!value || value === "REPLACE_ME") throw new Error(`请手动填写 ${key}`);
  return value;
};
const baseUrl = (env, key) => {
  const value = required(env, key).replace(/\/+$/, "");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error(`${key} 必须是无内嵌凭证、无查询参数的 HTTP(S) base URL`);
  return value;
};
async function request(url, key, body) {
  let response;
  try {
    response = await fetch(url, { method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  } catch { throw new Error("模型连接失败或超时，请检查内网/VPN及服务地址（不输出凭证）"); }
  if (!response.ok) throw new Error(`模型接口 HTTP ${response.status}（响应正文未输出，避免泄露凭证）`);
  try { return await response.json(); }
  catch { throw new Error("模型接口未返回有效 JSON（响应正文未输出）"); }
}

try {
  const env = parseEnv(readFileSync(envFile, "utf8"));
  const embedding = { url: baseUrl(env, "MEMORY_EMBEDDING_BASE_URL"), model: required(env, "MEMORY_EMBEDDING_MODEL"),
    dimensions: Number(required(env, "MEMORY_EMBEDDING_DIMENSIONS")) };
  if (!Number.isInteger(embedding.dimensions) || embedding.dimensions <= 0)
    throw new Error("MEMORY_EMBEDDING_DIMENSIONS 必须是正整数");
  if (!["true", "false"].includes(env.MEMORY_EMBEDDING_SEND_DIMENSIONS))
    throw new Error("MEMORY_EMBEDDING_SEND_DIMENSIONS 必须是 true 或 false");
  const chat = { url: baseUrl(env, "MEMORY_LLM_BASE_URL"), model: required(env, "MEMORY_LLM_MODEL") };
  const proxy = { url: baseUrl(env, "PROXY_UPSTREAM_URL"), model: required(env, "PROXY_UPSTREAM_MODEL") };
  console.log(JSON.stringify({ embedding, chat, proxy, network: values.live ? "live" : "not_called" }, null, 2));
  const keyNames = ["MEMORY_EMBEDDING_API_KEY", "MEMORY_LLM_API_KEY", "PROXY_UPSTREAM_API_KEY"];
  const missing = keyNames.filter(name => !env[name]?.trim() || env[name].trim() === "REPLACE_ME");
  if (missing.length) throw new Error(`待手动填写：${missing.join(", ")}；未调用任何接口`);
  if (!values.live) {
    console.log("配置完整；未联网。添加 --live 才会发送两条测试句子和简短对话。");
  } else {
    const body = { model: embedding.model, input: ["这是一个用于测试 BGE-M3 embedding 的句子。", "验证批量输入兼容性。"] };
    if (env.MEMORY_EMBEDDING_SEND_DIMENSIONS === "true") body.dimensions = embedding.dimensions;
    const vectors = await request(`${embedding.url}/embeddings`, env.MEMORY_EMBEDDING_API_KEY.trim(), body);
    if (!Array.isArray(vectors.data) || vectors.data.length !== body.input.length)
      throw new Error("Embedding 返回数量不匹配");
    const indices = new Set();
    for (const row of vectors.data) {
      if (!Number.isInteger(row.index) || row.index < 0 || row.index >= body.input.length || indices.has(row.index))
        throw new Error("Embedding 返回的 index 缺失或重复");
      indices.add(row.index);
      if (!Array.isArray(row.embedding) || row.embedding.length !== embedding.dimensions ||
          !row.embedding.every(Number.isFinite) || !row.embedding.some(x => x !== 0))
        throw new Error("Embedding 返回的向量维度或数值无效");
    }
    console.log(`Embedding 通过：${vectors.data.length} 条，${embedding.dimensions} 维`);
    const checkChat = async (target, key, label) => {
      const result = await request(`${target.url}/chat/completions`, key, {
        model: target.model, messages: [{ role: "user", content: "你好，请介绍一下你自己。" }],
        temperature: 0.7, max_tokens: 512, stream: false,
        // GLM enables thinking by default; this short connectivity probe needs an
        // actual text reply, not an output budget consumed entirely by reasoning.
        ...(/^glm-/i.test(target.model) ? { thinking: { type: "disabled" } } : {}),
      });
      if (typeof result.choices?.[0]?.message?.content !== "string" || !result.choices[0].message.content.trim())
        throw new Error(`${label} 未返回有效 choices[0].message.content`);
      console.log(`${label} 通过：${target.model}`);
    };
    await checkChat(chat, env.MEMORY_LLM_API_KEY.trim(), "Memory/Hub 对话");
    if (proxy.url === chat.url && proxy.model === chat.model && env.PROXY_UPSTREAM_API_KEY.trim() === env.MEMORY_LLM_API_KEY.trim())
      console.log("Proxy 上游配置与 Memory 相同，复用对话核验结果；这不是 Proxy 中转链路测试。");
    else await checkChat(proxy, env.PROXY_UPSTREAM_API_KEY.trim(), "Proxy 上游直连");
  }
} catch (error) {
  // Do not include values of invalid configuration or raw upstream responses.
  console.error(error instanceof TypeError ? "配置 URL 无效或数据格式错误" : error.message);
  process.exitCode = 1;
}
