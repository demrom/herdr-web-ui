import { describe, expect, it } from "bun:test";
import { parseClaudeTranscript } from "./conversation.ts";
import { splitTurn } from "../src/lib/workBlocks.ts";

const jsonl = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");
const assistant = (content: unknown[], stop_reason: string) => ({ type: "assistant", message: { role: "assistant", content, stop_reason } });

describe("Claude replies followed by injected context", () => {
  for (const [name, content] of [
    ["Stop hook feedback", "Stop hook feedback: Verify the fictional catalog before stopping."],
    ["hook additionalContext", [{ type: "text", text: "<system-reminder>Additional hook context: verify the fictional catalog.</system-reminder>" }]],
    ["task notification", "<task-notification><task-id>catalog-check</task-id><status>completed</status><summary>Catalog check finished.</summary></task-notification>"],
  ] as const) {
    it(`keeps the reply outside work when ${name} continues the same turn`, () => {
      const turns = parseClaudeTranscript(jsonl(
        { type: "user", message: { role: "user", content: "Check the fictional library." } },
        assistant([{ type: "text", text: "Checking the catalog." }, { type: "tool_use", id: "read", name: "Read", input: { file_path: "catalog.txt" } }], "tool_use"),
        { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "read", content: "Three books" }] } },
        assistant([{ type: "text", text: "The library has three books." }, { type: "text", text: "Two are available." }], "end_turn"),
        { type: "user", isMeta: true, userType: "external", message: { role: "user", content } },
        { type: "system", subtype: "stop_hook_summary" },
        assistant([{ type: "text", text: "Verifying the catalog." }, { type: "tool_use", id: "verify", name: "Read", input: { file_path: "catalog.txt" } }], "tool_use"),
        { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "verify", content: "Three books confirmed" }] } },
        assistant([{ type: "text", text: "Verified." }], "end_turn"),
      ));
      expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
      const parts = turns[1]!.parts;
      expect(parts.map((part) => part.kind === "text" ? part.text : part.kind)).toEqual(["Checking the catalog.", "tool", "The library has three books.", "Two are available.", "Verifying the catalog.", "tool", "Verified."]);
      const split = splitTurn(parts);
      expect(split.answer.map((part) => part.text)).toEqual(["The library has three books.", "Two are available.", "Verified."]);
      expect(split.work.map((part) => part.kind === "text" ? part.text : part.kind)).toEqual(["Checking the catalog.", "tool", "Verifying the catalog.", "tool"]);
      expect(split.work.filter((part) => part.kind === "tool").map((part) => part.output)).toEqual(["Three books", "Three books confirmed"]);
    });
  }
});
