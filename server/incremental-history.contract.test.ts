import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { forgetTranscriptState } from "./conversation.ts";
import { herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { ConversationResponse } from "../shared/protocol.ts";

describe("incremental conversation HTTP reads", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-incremental-history-"));
  const originalHome = process.env["HOME"];
  const directory = join(root, ".omp", "agent", "sessions", "synthetic");
  const path = join(directory, "history.jsonl");
  let workspaceId: string;
  let paneId: string;
  let server: ReturnType<typeof createServer>;
  const row = (role: string, text: string) => JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } }) + "\n";
  const initial = JSON.stringify({ type: "session", version: 3, id: "00000000-0000-4000-8000-000000000001", cwd: "/synthetic" }) + "\n"
    + Array.from({ length: 60 }, (_, index) => row("user", `Fictional question ${index}`) + row("assistant", `Fictional answer ${index}: ${"synthetic text ".repeat(1500)}`)).join("");

  beforeAll(async () => {
    forgetTranscriptState();
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, initial);
    const executable = join(root, "omp");
    writeFileSync(executable, "#!/bin/sh\nsleep 600\n");
    chmodSync(executable, 0o755);
    const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-incremental-history" });
    workspaceId = created.workspace.workspace_id;
    paneId = created.root_pane.pane_id;
    await herdrRpc("pane.send_text", { pane_id: paneId, text: `${executable}\n` });
    for (const deadline = Date.now() + 10_000;;) {
      if ((await sessionSnapshot()).panes.find((pane) => pane.pane_id === paneId)?.agent === "omp") break;
      if (Date.now() > deadline) throw new Error("Owned synthetic omp process did not start");
      await Bun.sleep(20);
    }
    await herdrRpc("pane.report_agent_session", { pane_id: paneId, source: "herdr:omp", agent: "omp", seq: Date.now(), agent_session_path: path, session_start_source: "startup" });
    process.env["HOME"] = root;
    server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), terminalAttach: false });
  });
  afterAll(async () => {
    server?.stop();
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    if (workspaceId) await workspaceClose(workspaceId);
    forgetTranscriptState();
    rmSync(root, { recursive: true, force: true });
  });

  it("transfers only changed turns, reloads a stale prefix, and preserves legacy responses", async () => {
    const url = `http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`;
    const legacy = await (await fetch(url)).json() as ConversationResponse;
    expect(legacy.turns).toHaveLength(100);
    expect(legacy).not.toHaveProperty("delta_cursor");
    const first = await (await fetch(`${url}&incremental=1`)).json();
    expect(typeof first.delta_cursor).toBe("string");
    expect(first.turns).toEqual(legacy.turns);
    const reopen = await (await fetch(`${url}&incremental=1&delta=${encodeURIComponent(first.delta_cursor)}`)).text();
    expect(JSON.parse(reopen).turns).toEqual([]);
    expect(JSON.parse(reopen).replace_from).toBe(100);
    expect(Buffer.byteLength(reopen)).toBeLessThan(10000);
    appendFileSync(path, row("user", "Fictional appended question") + row("assistant", "Fictional appended answer"));
    const changed = await (await fetch(`${url}&incremental=1&delta=${encodeURIComponent(first.delta_cursor)}`)).text();
    const delta = JSON.parse(changed);
    expect(delta.drop_before).toBe(2);
    expect(delta.replace_from).toBe(98);
    expect(delta.turns).toHaveLength(2);
    expect(Buffer.byteLength(changed)).toBeLessThan(Buffer.byteLength(JSON.stringify(first)) / 100);
    const whole = await (await fetch(url)).json();
    expect([...first.turns.slice(delta.drop_before, delta.drop_before + delta.replace_from), ...delta.turns]).toEqual(whole.turns);
    // Same path, a rewritten earlier prompt, and a larger replacement evade size-only checks.
    writeFileSync(path, initial.replace("Fictional question 20", "Rewritten fictional question twenty") + row("user", "Replacement ending") + row("assistant", "fictional replacement ".repeat(100)));
    const stale = await (await fetch(`${url}&incremental=1&delta=${encodeURIComponent(first.delta_cursor)}`)).json();
    expect(stale.replace_from).toBe(0);
    expect(stale.turns.some((turn: ConversationResponse["turns"][number]) => turn.parts.some((part) => part.kind === "text" && part.text === "Rewritten fictional question twenty"))).toBe(true);
    const unchanged = await fetch(url);
    expect((await fetch(url, { headers: { "if-none-match": unchanged.headers.get("etag")! } })).status).toBe(304);
    const malformed = await (await fetch(`${url}&incremental=1&delta=interrupted-cursor`)).json();
    expect(malformed.replace_from).toBe(0);
    expect(malformed.turns).toEqual((await (await fetch(url)).json()).turns);
    // A fresh bridge has no in-memory revision history. Saved page checksums must still detect a rewrite.
    writeFileSync(path, initial);
    forgetTranscriptState();
    const baseline = await (await fetch(`${url}&incremental=1`)).json();
    const olderUrl = `${url}&incremental=1&before=${encodeURIComponent(baseline.cursor)}`;
    const prefix = await (await fetch(olderUrl)).json();
    server.stop();
    forgetTranscriptState();
    writeFileSync(path, initial.replace("Fictional question 0", "Rewritten question 0"));
    server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "restarted-state"), terminalAttach: false });
    const restartedUrl = `http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`;
    const rewritten = await (await fetch(`${restartedUrl}&incremental=1&before=${encodeURIComponent(baseline.cursor)}&delta=${encodeURIComponent(prefix.delta_cursor)}`)).json();
    expect(rewritten.history_id).toBe(prefix.history_id);
    expect(rewritten.cache_session).toBe(prefix.cache_session);
    expect(rewritten.replace_from).toBe(0);
    expect(rewritten.turns[0].parts[0].text).toBe("Rewritten question 0");
    const stable = await (await fetch(`${restartedUrl}&incremental=1&delta=${encodeURIComponent(baseline.delta_cursor)}`)).json();
    expect(stable.turns).toEqual([]);
    expect(stable.cache_session).toBe(baseline.cache_session);
    // Rotation/compaction starts a different native history at the same path.
    renameSync(path, join(directory, "previous.jsonl"));
    writeFileSync(path, JSON.stringify({ type: "session", version: 3, id: "00000000-0000-4000-8000-000000000002", cwd: "/synthetic" }) + "\n" + row("user", "New fictional session") + row("assistant", "Compacted fictional history"));
    const replaced = await (await fetch(`${restartedUrl}&incremental=1&delta=${encodeURIComponent(first.delta_cursor)}`)).json();
    expect(replaced.replace_from).toBe(0);
    expect(replaced.history_id).not.toBe(first.history_id);
    expect(replaced.turns).toHaveLength(2);
    console.log(`Incremental HTTP: initial=${Buffer.byteLength(JSON.stringify(first))}B, reopen=${Buffer.byteLength(reopen)}B, append=${Buffer.byteLength(changed)}B`);
  });
});
