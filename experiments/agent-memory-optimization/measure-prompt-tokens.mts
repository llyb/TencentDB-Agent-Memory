import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import ts from "../../MemoryProxy/node_modules/typescript/lib/typescript.js";
import { getEncoding } from "../../MemoryCore/node_modules/js-tiktoken/dist/index.js";

import { renderAssetToolRoutingBlock } from "../../MemoryProxy/src/injection/injectors/asset-tool-routing-injector.ts";
import { renderKnowledgeToolsBlock } from "../../MemoryProxy/src/injection/injectors/knowledge-tools-injector.ts";
import { renderSkillToolsBlock } from "../../MemoryProxy/src/injection/injectors/skill-tools-injector.ts";
import { wrapAvailableSkillsBlock } from "../../MemoryProxy/src/injection/injectors/skill-injector.ts";
import { renderTdaiMemoryToolsBlock } from "../../MemoryProxy/src/injection/injectors/tdai-tools-injector.ts";

const root = path.resolve(import.meta.dirname, "../..");
const isMain = Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
const baselineRef = (isMain ? process.argv[2] : undefined) ?? process.env.PROMPT_BASELINE_REF ?? "50f33f5";
const oldSource = (file: string) => execFileSync("git", ["show", `${baselineRef}:${file}`], { cwd: root, encoding: "utf8" });

function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`Cannot extract ${start} ... ${end}`);
  return source.slice(from, to).replaceAll("export ", "");
}

function evaluate(source: string, names: string[]): Record<string, unknown> {
  const exposed = names.map((name) => `globalThis.${name} = ${name};`).join("\n");
  const js = ts.transpileModule(`${source}\n${exposed}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const context: Record<string, unknown> = {};
  vm.runInNewContext(js, context);
  return context;
}

const oldMemory = evaluate(
  section(oldSource("MemoryProxy/src/injection/injectors/tdai-tools-injector.ts"), "export function renderTdaiMemoryToolsBlock", "export class TdaiMemoryToolsInjector"),
  ["renderTdaiMemoryToolsBlock"],
).renderTdaiMemoryToolsBlock as typeof renderTdaiMemoryToolsBlock;
const oldGuide = evaluate(
  section(oldSource("MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts"), "export const MEMORY_TOOLS_GUIDE", "interface AgentProfileBundle"),
  ["MEMORY_TOOLS_GUIDE"],
).MEMORY_TOOLS_GUIDE as string;
const oldSkillTools = evaluate(
  section(oldSource("MemoryProxy/src/injection/injectors/skill-tools-injector.ts"), "export function renderSkillToolsBlock", "/**\n * Skill tools injector."),
  ["renderSkillToolsBlock"],
).renderSkillToolsBlock as typeof renderSkillToolsBlock;
const oldListing = evaluate(
  section(oldSource("MemoryProxy/src/injection/injectors/skill-injector.ts"), "const SKILL_LISTING_HEADER", "/**\n * Build a search query"),
  ["wrapAvailableSkillsBlock"],
).wrapAvailableSkillsBlock as typeof wrapAvailableSkillsBlock;
const oldKnowledge = evaluate(
  section(oldSource("MemoryProxy/src/injection/injectors/knowledge-tools-injector.ts"), "function shellQuote", "/**\n * Knowledge tools injector."),
  ["renderKnowledgeToolsBlock"],
).renderKnowledgeToolsBlock as typeof renderKnowledgeToolsBlock;

const resource = {
  knowledge_id: "kg-1", type: "code-graph" as const, service_url: "http://knowledge/v3",
  name: "repo graph", summary: null, team_id: "team-1", user_id: null,
  repo_slug: "org/repo", created_at: "2026-01-01", updated_at: "2026-01-01",
};
const wikiResource = {
  knowledge_id: "wiki-1", type: "wiki" as const, service_url: "http://knowledge/v3",
  name: "engineering design wiki", summary: "Architecture rationale, historical decisions, team definitions, and migration tradeoffs.",
  team_id: "team-1", user_id: null, created_at: "2026-01-01", updated_at: "2026-01-01",
};
const resources = [resource, wikiResource];
const listing = "<available_skills>\n- deploy: release service safely\n</available_skills>";
const args = ["http://proxy", "session-1", "space-1"] as const;

export const p0Prompt = [
  oldMemory(...args),
  oldGuide,
  oldSkillTools("http://proxy", false, "session-1", "space-1"),
  oldListing(listing),
  oldKnowledge(resources, "space-1") ?? "",
].join("\n");
export const p3Prompt = [
  renderAssetToolRoutingBlock(["memory", "skill", "knowledge"]),
  renderTdaiMemoryToolsBlock(...args),
  renderSkillToolsBlock("http://proxy", false, "session-1", "space-1"),
  wrapAvailableSkillsBlock(listing),
  renderKnowledgeToolsBlock(resources, "space-1") ?? "",
].join("\n");

const encoding = getEncoding("o200k_base");
const baseline = encoding.encode(p0Prompt).length;
const optimized = encoding.encode(p3Prompt).length;
const report = {
  tokenizer: "o200k_base",
  baseline_ref: baselineRef,
  fixture: "one code-graph, one wiki, one listed skill, read-only skill tools",
  p0_injected_tokens: baseline,
  p3_injected_tokens: optimized,
  tokens_saved: baseline - optimized,
  reduction_rate: (baseline - optimized) / baseline,
  note: "Static representative fixture. Live evaluation must record provider-reported prompt tokens per case.",
};
if (isMain) {
  await mkdir(path.join(import.meta.dirname, "reports"), { recursive: true });
  await writeFile(path.join(import.meta.dirname, "reports", "prompt-token-baseline.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}
