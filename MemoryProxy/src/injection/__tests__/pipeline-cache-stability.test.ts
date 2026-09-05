import { describe, expect, it, vi } from "vitest";

import type { HookCacheRepo } from "../../db/hookCacheRepo.js";
import { AnthropicAdapter } from "../adapters/anthropic.js";
import { AssetToolRoutingInjector } from "../injectors/asset-tool-routing-injector.js";
import type { AgentProfile, PromptSegment } from "../agents/interface.js";
import { InjectionPipeline } from "../pipeline.js";
import { HookRegistryImpl } from "../registry.js";
import type { AgentContextMetadata, InjectionHook } from "../types.js";

const metadata = (custom?: Record<string, unknown>): AgentContextMetadata => ({
  protocol: "anthropic",
  traceId: "trace-1",
  keyId: "key-1",
  modelId: "model-1",
  stream: false,
  agentSource: "test-agent",
  userId: "user-1",
  spaceId: "space-1",
  custom,
});

function adapters() {
  return new Map([["anthropic", new AnthropicAdapter()]]);
}

describe("prompt-cache stability", () => {
  it("emits the shared routing policy as a stable Anthropic cache breakpoint", async () => {
    const registry = new HookRegistryImpl();
    registry.register(new AssetToolRoutingInjector(["memory", "skill", "knowledge"]));
    const pipeline = new InjectionPipeline(registry, adapters());
    const result = await pipeline.process({ system: "BASE", messages: [] }, metadata());
    const system = result.system as Array<Record<string, unknown>>;
    expect(system[0].text).toContain("<asset_tool_routing>");
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(system[1]).toEqual({ type: "text", text: "BASE" });
  });

  it("preserves provider metadata and unrelated system blocks on semantic injection", async () => {
    const profile: AgentProfile = {
      id: "test-agent",
      protocol: "anthropic",
      detect: () => true,
      parse: (text) => text.includes("<memory>")
        ? [{ id: "memory", kind: "xml_tag", key: "memory", rawText: text, innerText: text, index: 0 }]
        : [{ id: "plain", kind: "plain", key: null, rawText: text, innerText: text, index: 0 }],
      resolveSlot: (slot) => slot === "memory" ? "memory" : null,
      applyAnchor: (segments, _anchor, text) => [{ ...segments[0], rawText: `${segments[0].rawText}\n${text}` }],
      rebuild: (segments: PromptSegment[]) => segments.map((segment) => segment.rawText).join("\n"),
    };
    const hook: InjectionHook = {
      id: "anchored",
      description: "test anchored injection",
      point: "system.suffix",
      anchor: { slot: "memory", relation: "inside_append" },
      priority: 1,
      execute: () => [{ type: "text", content: "INJECTED" }],
    };
    const registry = new HookRegistryImpl();
    registry.register(hook);
    const pipeline = new InjectionPipeline(registry, adapters(), { agentProfiles: new Map([[profile.id, profile]]) });
    const result = await pipeline.process({
      system: [
        { type: "text", text: "<memory>stable</memory>", cache_control: { type: "ephemeral" } },
        { type: "text", text: "UNCHANGED" },
      ],
      messages: [{ role: "user", content: "hello" }],
    }, metadata());
    const system = result.system as Array<Record<string, unknown>>;
    expect(system).toHaveLength(2);
    expect(system[0].text).toContain("INJECTED");
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(system[1]).toEqual({ type: "text", text: "UNCHANGED" });
  });

  it("rejects a stale session block and stores the newly versioned block", async () => {
    const put = vi.fn();
    const cache: HookCacheRepo = {
      get: vi.fn().mockResolvedValue([{ type: "text", content: "STALE", metadata: { cacheVersion: "old" } }]),
      put,
      putMany: vi.fn(),
      getAllForSession: vi.fn().mockResolvedValue([]),
      clearBySession: vi.fn(),
    };
    const execute = vi.fn().mockReturnValue([{ type: "text", content: "FRESH" }]);
    const hook: InjectionHook = {
      id: "versioned",
      description: "test version invalidation",
      point: "system.prefix",
      priority: 1,
      cacheStrategy: "session_init",
      cacheVersion: "new",
      execute,
    };
    const registry = new HookRegistryImpl();
    registry.register(hook);
    const pipeline = new InjectionPipeline(registry, adapters(), { hookCacheRepo: cache });
    const result = await pipeline.process({ system: "BASE", messages: [] }, metadata({ session: { session_id: "session-1" } }));
    const system = result.system as Array<Record<string, unknown>>;
    expect(execute).toHaveBeenCalledOnce();
    expect(system[0].text).toBe("FRESH");
    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0][5][0].metadata.cacheVersion).toBe("new");
  });
});
