import { describe, expect, it } from "vitest";

import {
  formatStructuredTranscript,
  formatTranscript,
  truncateHeadTail,
} from "./skill-extractor.js";
import type { ExtractMessage } from "./types.js";

describe("structured Skill transcript selection", () => {
  it("keeps role indexes and the end-of-transcript guard", () => {
    const output = formatTranscript([
      { role: "user", content: "fix the parser" },
      { role: "assistant", content: "done" },
    ]);

    expect(output).toContain("<<past-user>>\n<<message-index:0>>");
    expect(output).toContain("<<past-assistant>>\n<<message-index:1>>");
    expect(output).toContain("<<end-of-transcript>>");
  });

  it("retains complete adjacent tool pairs and the final outcome within budget", () => {
    const messages: ExtractMessage[] = [
      { role: "user", content: "fix the failing parser and verify it" },
      { role: "assistant", content: "x".repeat(700) },
      { role: "tool_call", content: "npm test parser" },
      { role: "tool_result", content: "1 test passed" },
      { role: "assistant", content: "parser fixed and tests pass" },
    ];

    const output = formatStructuredTranscript(messages, 520);

    expect(output.length).toBeLessThanOrEqual(520);
    expect(output).toContain("fix the failing parser");
    expect(output).toContain("<<past-tool_call>>\n<<message-index:2>>");
    expect(output).toContain("<<past-tool_result>>\n<<message-index:3>>");
    expect(output).toContain("parser fixed and tests pass");
    expect(output).toContain("<<end-of-transcript>>");
    expect(output).not.toContain("x".repeat(100));
  });

  it("supports a zero-sized head or tail without accidentally retaining the full transcript", () => {
    expect(truncateHeadTail("abcdefghij", 0, 3)).toContain("hij");
    expect(truncateHeadTail("abcdefghij", 0, 0)).not.toContain("abcdefghij");
  });
});
