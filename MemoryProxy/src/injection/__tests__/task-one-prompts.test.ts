import { describe, expect, it } from "vitest";

import { renderAssetToolRoutingBlock } from "../injectors/asset-tool-routing-injector.js";
import { renderKnowledgeToolsBlock } from "../injectors/knowledge-tools-injector.js";
import { renderSkillToolsBlock } from "../injectors/skill-tools-injector.js";
import { wrapAvailableSkillsBlock } from "../injectors/skill-injector.js";
import { renderTdaiMemoryToolsBlock } from "../injectors/tdai-tools-injector.js";

describe("task-one prompt contracts", () => {
  it("uses one precision-first routing policy with explicit negative boundaries", () => {
    const text = renderAssetToolRoutingBlock(["memory", "skill", "knowledge"]);
    expect(text).toContain("current conversation and workspace do not contain");
    expect(text).toContain("ordinary coding");
    expect(text).toContain("not by themselves reasons to call");
    expect(text.match(/<asset_tool_routing>/g)).toHaveLength(1);
  });

  it("keeps the memory execution contract without the duplicated guide", () => {
    const text = renderTdaiMemoryToolsBlock("http://proxy", "session-1", "space-1");
    for (const endpoint of ["atomic/search", "atomic/query", "conversation/search", "conversation/query", "scenario/ls", "scenario/read"]) {
      expect(text).toContain(endpoint);
    }
    expect(text).toContain("x-conversation-id: session-1");
    expect(text).toContain("x-tdai-service-id: space-1");
    expect(text).toContain("total <= 3");
    expect(text).not.toContain("<memory-tools-guide>");
  });

  it("does not encourage partially relevant skill calls", () => {
    const listing = wrapAvailableSkillsBlock("<available_skills>\n- deploy: release service\n</available_skills>");
    expect(listing).toContain("clearly matches");
    expect(listing).toContain("partial relevance is not enough");
    expect(listing).toContain("continue normally");
    expect(listing).not.toContain("Err on the side of loading");
  });

  it("gates skill writes and retains the manifest dependency", () => {
    const readOnly = renderSkillToolsBlock("http://proxy", false, "session-1", "space-1");
    const writable = renderSkillToolsBlock("http://proxy", true, "session-1", "space-1");
    expect(readOnly).toContain("call skill_view first");
    expect(readOnly).not.toContain('<tool name="skill_create">');
    expect(writable).toContain('<tool name="skill_create">');
    expect(writable).toContain("On stale version, skill_view then retry once");
  });

  it("keeps knowledge matching and the two-step protocol", () => {
    const text = renderKnowledgeToolsBlock([{
      knowledge_id: "kg-1",
      type: "code-graph",
      service_url: "http://knowledge/v3",
      name: "repo graph",
      summary: null,
      team_id: "team-1",
      user_id: null,
      repo_slug: "org/repo",
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
    }], "space-1");
    expect(text).toContain('match="org/repo"');
    expect(text).toContain("/tools/list");
    expect(text).toContain("/tools/call");
    expect(text).toContain("knowledge_id belongs in the JSON body");
    expect(text).toContain("x-tdai-service-id: space-1");
  });
});
