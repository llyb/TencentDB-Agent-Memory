import type {
  AgentContext,
  AssetCapabilityFlags,
  CacheStrategy,
  ContextBlock,
  HookPriority,
  InjectionHook,
  PrewarmInput,
} from "../types.js";
import { HOOK_PRIORITY } from "../types.js";

export type AssetToolFamily = "memory" | "skill" | "knowledge";

export const ASSET_TOOL_PROMPT_VERSION = "asset-tools-v1";

export function renderAssetToolRoutingBlock(families: readonly AssetToolFamily[]): string {
  const enabled = new Set(families);
  const lines = [
    "<asset_tool_routing>",
    "Use an asset tool only when the current conversation and workspace do not contain the required information.",
  ];
  if (enabled.has("memory")) {
    lines.push("- memory: user history, preferences, prior decisions, or cross-session state.");
  }
  if (enabled.has("skill")) {
    lines.push("- skill: an existing team/repository procedure, SOP, or established validation workflow.");
  }
  if (enabled.has("knowledge")) {
    lines.push("- knowledge: team wiki/design material or a code graph matching the current repository.");
  }
  lines.push(
    "For ordinary coding, public knowledge, or facts already present in local files, proceed without these asset tools.",
    "Words such as memory, skill, cache, or knowledge in code are not by themselves reasons to call a tool.",
    "</asset_tool_routing>",
  );
  return lines.join("\n");
}

function availableFamilies(
  configured: readonly AssetToolFamily[],
  caps: AssetCapabilityFlags | undefined,
): AssetToolFamily[] {
  return configured.filter((family) => {
    if (!caps) return true;
    if (family === "memory") return caps.chat_memory !== false;
    if (family === "skill") return caps.skill !== false;
    return caps.llm_wiki !== false || caps.code_graph !== false;
  });
}

export class AssetToolRoutingInjector implements InjectionHook {
  id = "asset-tool-routing-injector";
  point = "system.prefix" as const;
  priority: HookPriority = HOOK_PRIORITY.SYSTEM;
  description = "Inject the shared precision-first routing policy for asset tools.";
  cacheStrategy: CacheStrategy = "session_init";
  cacheVersion = ASSET_TOOL_PROMPT_VERSION;

  constructor(private readonly families: readonly AssetToolFamily[]) {}

  execute(ctx: AgentContext): ContextBlock[] {
    const caps = ctx.metadata.custom?.assetCapabilities as AssetCapabilityFlags | undefined;
    return this.render(availableFamilies(this.families, caps));
  }

  prewarm(input: PrewarmInput): ContextBlock[] {
    return this.render(availableFamilies(this.families, input.assetCapabilities));
  }

  private render(families: AssetToolFamily[]): ContextBlock[] {
    if (families.length === 0) return [];
    return [{
      type: "text",
      content: renderAssetToolRoutingBlock(families),
      metadata: {
        source: this.id,
        cacheKey: `${this.id}:${families.join(",")}`,
        // AnthropicAdapter restores this as a provider cache breakpoint. Other
        // adapters safely ignore it while retaining deterministic block order.
        cache_control: { type: "ephemeral" },
      },
    }];
  }
}
