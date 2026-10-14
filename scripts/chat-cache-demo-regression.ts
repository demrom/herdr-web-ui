/** Real app actions over synthetic HTTP conversations; no native sessions or model calls. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { conversationDelta } from "../shared/conversation-delta.ts";
import type { ConversationResponse } from "../shared/protocol.ts";
import { buildDemoApp } from "./demo-build.ts";
import { openSettingsPage } from "./settings-page.ts";

const app = mkdtempSync(join(tmpdir(), "herdr-chat-cache-demo-"));
const records: { pane: string; delta: boolean; incremental: boolean; bytes: number; cursor: string | null; turns: number; before: string | null; status?: number }[] = [];
const bodies = new Map<string, ConversationResponse>();
const earlier = new Map<string, ConversationResponse>();
let held = false;
let denied = false;
let refusals = 0;
let legacy = false;
let conditional = false;
let broken: "error" | "partial" | "drop" | null = null;
let brokenBefore: string | null = null;
const pending: (() => void)[] = [];
function release() { held = false; for (const resolve of pending.splice(0)) resolve(); }
function fixture(pane: string): ConversationResponse {
  return { source: "claude-transcript", history_id: `fictional-${pane}`, cursor: null,
    turns: Array.from({ length: 6 }, (_, n) => [
      { role: "user" as const, ts: null, parts: [{ kind: "text" as const, text: `Synthetic question ${n}` }] },
      { role: "assistant" as const, ts: null, parts: [{ kind: "text" as const, text: `Synthetic answer ${n}. ` + "Fictional transcript. ".repeat(3700) }] },
    ]).flat() };
}
async function settings(page: Page) {
  await page.locator(".conn-live").waitFor({ state: "attached" });
  if (!await page.locator(".settings-dialog").isVisible()) await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Chat");
}
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await buildDemoApp(app);
  // Keep the demo's status/terminal transport, but exercise conversation reads over real HTTP.
  writeFileSync(join(app, "cache-transport.js"), `const demoFetch = window.fetch; window.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    return url.pathname.endsWith("/pane/conversation") ? window.cacheNativeFetch(input, init) : demoFetch(input, init);
  };`);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script>window.cacheNativeFetch = window.fetch.bind(window);</script><script src="./demo-transport.js"></script><script src="./cache-transport.js"></script><script type="module"'));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/pane/conversation")) {
      if (held) await new Promise<void>((resolve) => pending.push(resolve));
      if (denied) { refusals += 1; return Response.json({ error: { code: "unauthorized", message: "Synthetic access refusal" } }, { status: 401 }); }
      const pane = url.searchParams.get("pane_id")!;
      const newest = bodies.get(pane) ?? fixture(pane); bodies.set(pane, newest);
      const body = earlier.get(url.searchParams.get("before") ?? "") ?? newest;
      const incremental = url.searchParams.get("incremental") === "1";
      const answer = incremental && !legacy ? await conversationDelta(body, url.searchParams.get("delta")) : body;
      const json = JSON.stringify(answer);
      const etag = `"${Bun.hash(JSON.stringify(body))}"`;
      const unchanged = conditional && request.headers.get("if-none-match") === etag;
      records.push({ pane, delta: url.searchParams.has("delta"), incremental, bytes: new TextEncoder().encode(json).byteLength, cursor: url.searchParams.get("delta"), turns: answer.turns.length, before: url.searchParams.get("before"), status: unchanged ? 304 : 200 });
      if (unchanged) return new Response(null, { status: 304, headers: { etag } });
      if (broken === "error") return Response.json({ error: { code: "synthetic_failure", message: "Synthetic server failure" } }, { status: 503 });
      if (broken === "partial" && (brokenBefore === null || url.searchParams.get("before") === brokenBefore)) return new Response(json.slice(0, json.length / 2), { headers: { "content-type": "application/json" } });
      if (broken === "drop") return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(json.slice(0, 64)));
        queueMicrotask(() => controller.error(new Error("Synthetic connection drop")));
      } }), { headers: { "content-type": "application/json" } });
      return new Response(json, { headers: { "content-type": "application/json", ...(conditional ? { etag } : {}) } });
    }
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (file.includes("..")) return new Response(null, { status: 404 });
    return new Response(Bun.file(join(app, file)));
  } });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox", "--host-resolver-rules=MAP cache.test 127.0.0.1", "--no-proxy-server"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  await context.addInitScript(() => {
    if (!localStorage.getItem("herdr-web-ui:settings")) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "chat", theme: "dark" }));
  });
  const page = await context.newPage();
  await page.goto(`http://cache.test:${server.port}/`);
  assert.equal(await page.evaluate(() => isSecureContext), false);
  assert.equal(await page.evaluate(() => typeof crypto.subtle), "undefined");
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.locator(".chat-turn-agent").first().waitFor();
  assert(records.length > 0 && records.every((r) => !r.incremental && !r.delta), "flag off keeps the existing request");
  const first = records[0]!.pane;
  await settings(page);
  const toggle = page.getByRole("switch", { name: "Cache chat history on this device", exact: true });
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  assert.equal(await page.getByLabel("Maximum chat cache (MB)", { exact: true }).inputValue(), "500");
  await toggle.click();
  await page.getByText(/MB in 1 chats/).waitFor();
  await page.keyboard.press("Escape");
  held = true;
  await page.reload();
  await page.locator(".chat-turn-agent").first().waitFor({ timeout: 5000 });
  assert(held, "cached chat renders before its HTTP validation completes");
  release();
  await until(() => records.some((r) => r.pane === first && r.delta), "reopen delta");
  const fullBytes = records.find((r) => r.pane === first && r.incremental && !r.delta)!.bytes;
  const deltaBytes = records.find((r) => r.pane === first && r.delta)!.bytes;
  assert(deltaBytes < fullBytes / 50);
  console.log(`PASS cached render before HTTP; full=${fullBytes}B reopen=${deltaBytes}B`);

  // A rewrite with the same native identity must discard the old prefix.
  bodies.get(first)!.turns[10]!.parts = [{ kind: "text", text: "Rewritten synthetic question" }];
  bodies.get(first)!.turns[11]!.parts = [{ kind: "text", text: "Rewritten synthetic answer" }];
  await page.reload();
  await page.getByText("Rewritten synthetic answer", { exact: true }).waitFor();
  console.log("PASS stale cached prefix reloads from HTTP");

  const paneChoices = await page.locator(".pane-select[data-pane]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-pane")!));
  for (const pane of paneChoices.filter((id) => id !== first).slice(0, 2)) {
    await page.locator(`.pane-select[data-pane="${pane}"]`).click();
    await page.locator(".chat-turn-agent").first().waitFor();
  }
  await settings(page);
  await page.getByText(/MB in 3 chats/).waitFor();
  const limit = page.getByLabel("Maximum chat cache (MB)", { exact: true });
  await limit.fill("1");
  await limit.pressSequentially("0000");
  await limit.press("Enter");
  await page.getByText(/MB in 3 chats/).waitFor();
  assert.equal(await limit.inputValue(), "10000");
  await limit.fill("20000"); await limit.press("Tab");
  assert.equal(await limit.inputValue(), "10000");
  console.log("PASS editing a larger limit retains saved chats and commits bounded values on Enter/blur");
  await page.keyboard.press("Escape");
  await page.locator(`.pane-select[data-pane="${first}"]`).click();
  await settings(page);
  await page.getByLabel("Maximum chat cache (MB)", { exact: true }).fill("0");
  await page.getByLabel("Maximum chat cache (MB)", { exact: true }).press("Enter");
  assert.equal(await page.getByLabel("Maximum chat cache (MB)", { exact: true }).inputValue(), "1");
  await page.keyboard.press("Escape");
  const panes = await page.locator(".pane-select[data-pane]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-pane")!));
  assert(panes.length >= 3);
  const others = panes.filter((pane) => pane !== first).slice(0, 2);
  async function visit(pane: string) {
    const before = records.length;
    await page.locator(`.pane-select[data-pane="${pane}"]`).click();
    await until(() => records.slice(before).some((r) => r.pane === pane), `read ${pane}`);
    await settings(page);
    await page.getByText(/MB in 2 chats/).waitFor();
    await page.keyboard.press("Escape");
  }
  await visit(others[0]!);
  await visit(first); // Touch the first chat, so the second one is the LRU victim.
  await visit(others[1]!);
  // Reload destroys the old memory-only answers; selecting the victim must load a complete page.
  await page.reload();
  await page.locator(".chat-turn-agent").first().waitFor();
  const beforeVictim = records.length;
  await page.locator(`.pane-select[data-pane="${others[0]}"]`).click();
  await until(() => records.slice(beforeVictim).some((r) => r.pane === others[0]), "evicted chat reload");
  assert.equal(records.slice(beforeVictim).find((r) => r.pane === others[0])!.delta, false);
  await settings(page);
  await page.getByText(/MB in 2 chats/).waitFor();
  console.log("PASS 1 MB limit evicts the least recently opened chat");

  const evidence = process.env.UI_EVIDENCE_DIR;
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      for (const theme of ["dark", "light"]) {
        await openSettingsPage(page, "Appearance");
        await page.getByRole("button", { name: theme === "dark" ? "Dark" : "Light", exact: true }).click();
        await openSettingsPage(page, "Chat");
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await page.locator('[data-section="history-cache"]').evaluate((node) => node.scrollIntoView({ block: "start" }));
        await page.getByRole("switch", { name: "Cache chat history on this device", exact: true }).waitFor();
        await page.screenshot({ path: join(evidence, `cache-${width === 390 ? "phone" : "desktop"}-${theme}.png`) });
      }
    }
  }
  await page.getByRole("button", { name: "Clear cache on this device", exact: true }).click();
  await page.getByText("0.00 MB in 0 chats", { exact: true }).waitFor();
  console.log("PASS Clear cache empties device storage");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.keyboard.press("Escape");
  await page.reload();
  await settings(page);
  await page.getByText(/MB in 1 chats/).waitFor();
  await page.keyboard.press("Escape");
  held = true;
  const begunRead = page.waitForRequest((request) => request.url().includes("/pane/conversation?"));
  await page.reload();
  await page.locator(".chat-turn-agent").first().waitFor();
  await begunRead;
  await settings(page);
  await page.getByRole("button", { name: "Clear cache on this device", exact: true }).click();
  await until(() => page.getByText("0.00 MB in 0 chats", { exact: true }).isVisible(), "clear while HTTP held");
  const beforeLate = records.length;
  const completed = page.waitForResponse((response) => response.url().includes("/pane/conversation?"));
  release();
  await until(() => records.length > beforeLate, "late read completion");
  await (await completed).finished();
  await until(() => page.getByText("0.00 MB in 0 chats", { exact: true }).isVisible(), "clear survives late HTTP completion");
  console.log("PASS pre-clear HTTP response cannot repopulate storage");
  await page.keyboard.press("Escape");
  await page.reload();
  await settings(page);
  await page.getByText(/MB in 1 chats/).waitFor();
  await toggle.click();
  await page.getByText("0.00 MB in 0 chats", { exact: true }).waitFor();
  await toggle.click();
  await page.getByText(/MB in 1 chats/).waitFor();
  console.log("PASS disabling cache clears device history");
  denied = true;
  await page.keyboard.press("Escape");
  await page.reload();
  await until(() => refusals > 0, "access refusal");
  await settings(page);
  await page.getByText("0.00 MB in 0 chats", { exact: true }).waitFor();
  console.log("PASS access refusal clears sensitive history");
  await context.close();

  denied = false; legacy = true;
  const compatible = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await compatible.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "chat", chatHistoryCache: true })));
  const oldBridge = await compatible.newPage();
  await oldBridge.goto(`http://cache.test:${server.port}/`);
  await settings(oldBridge);
  await oldBridge.getByText(/MB in 1 chats/).waitFor();
  await oldBridge.keyboard.press("Escape");
  held = true;
  await oldBridge.reload();
  await oldBridge.locator(".chat-turn-agent").first().waitFor();
  const beforeLegacy = records.length;
  release();
  await until(() => records.length > beforeLegacy, "legacy bridge validation");
  assert.equal(records.at(-1)!.delta, false);
  assert(records.at(-1)!.bytes > 400_000);
  console.log("PASS older bridge full-page responses remain compatible");
  await compatible.close();

  legacy = false;
  const unavailable = await browser.newContext();
  await unavailable.addInitScript(() => {
    localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "chat", chatHistoryCache: true }));
    Object.defineProperty(window, "indexedDB", { get() { throw new DOMException("Synthetic storage denial", "SecurityError"); } });
  });
  const noStorage = await unavailable.newPage();
  await noStorage.goto(`http://cache.test:${server.port}/`);
  await noStorage.locator(".chat-turn-agent").first().waitFor();
  await settings(noStorage);
  await noStorage.getByText("Chat cache is unavailable: browser storage access was denied.", { exact: true }).waitFor();
  console.log("PASS denied IndexedDB leaves live chats usable");
  await unavailable.close();
  const missing = await browser.newContext();
  await missing.addInitScript(() => {
    localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "chat", chatHistoryCache: true }));
    Object.defineProperty(window, "indexedDB", { value: undefined });
  });
  const missingStorage = await missing.newPage();
  await missingStorage.goto(`http://cache.test:${server.port}/`);
  await missingStorage.locator(".chat-turn-agent").first().waitFor();
  await settings(missingStorage);
  await missingStorage.getByText("Chat cache is unavailable: IndexedDB is missing.", { exact: true }).waitFor();
  console.log("PASS missing IndexedDB reports the reason and leaves live chats usable");
  await missing.close();

  conditional = true;
  const quiet = await browser.newContext();
  await quiet.addInitScript(() => {
    localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "chat", chatHistoryCache: true }));
    const metrics = window as unknown as { pageWrites: number };
    metrics.pageWrites = 0;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      const request = key === undefined ? put.call(this, value) : put.call(this, value, key);
      if (this.name === "pages" && ++metrics.pageWrites === 1) this.transaction.abort();
      return request;
    };
  });
  const idle = await quiet.newPage();
  const beforeQuiet = records.length;
  await idle.goto(`http://cache.test:${server.port}/`);
  await idle.locator(".chat-turn-agent").first().waitFor();
  await settings(idle);
  await idle.getByText(/MB in 1 chats/).waitFor(); // The 304 must retry the initially aborted write.
  await idle.keyboard.press("Escape");
  const writesAfterRetry = await idle.evaluate(() => (window as unknown as { pageWrites: number }).pageWrites);
  assert.equal(writesAfterRetry, 2);
  await until(() => records.slice(beforeQuiet).filter((r) => r.status === 304).length >= 2, "unchanged cached refresh");
  await idle.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.equal(await idle.evaluate(() => (window as unknown as { pageWrites: number }).pageWrites), writesAfterRetry, "304 reuses an already durable page without writing it again");
  console.log("PASS 304 retries a failed write once and skips already durable pages");
  await quiet.close();
  conditional = false;

  const resilient = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await resilient.addInitScript(() => {
    localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "chat", chatHistoryCache: true }));
    sessionStorage.removeItem("synthetic-write-held");
    // Fault injection at the browser-owned database boundary; application modules stay real.
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      const fault = sessionStorage.getItem("synthetic-idb-fault");
      if (this.name === "pages" && fault) {
        if (fault === "quota") throw new DOMException("Synthetic quota exhausted", "QuotaExceededError");
        const request = key === undefined ? put.call(this, value) : put.call(this, value, key);
        if (fault === "abort") this.transaction.abort();
        if (fault === "hold") {
          const store = this;
          const keep = () => { store.get("synthetic-keepalive").onsuccess = keep; };
          keep();
          sessionStorage.setItem("synthetic-write-held", "true");
        }
        return request;
      }
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    };
  });
  let recovery = await resilient.newPage();
  await recovery.goto(`http://cache.test:${server.port}/`);
  await settings(recovery);
  await recovery.getByText(/MB in 1 chats/).waitFor();
  await recovery.keyboard.press("Escape");
  const recoveryPane = records.at(-1)!.pane;
  async function reopen() {
    const at = records.length;
    await recovery.reload();
    await until(() => records.length > at, "recovery HTTP read");
    return records.at(-1)!;
  }
  let durable = await reopen();
  assert(durable.delta);
  for (const fault of ["error", "drop", "partial"] as const) {
    const body = bodies.get(recoveryPane)!;
    const text = `Recovered after ${fault}`;
    body.turns.push({ role: "user", ts: null, parts: [{ kind: "text", text: `Synthetic ${fault} question` }] }, { role: "assistant", ts: null, parts: [{ kind: "text", text }] });
    broken = fault;
    const failed = await reopen();
    assert.equal(failed.cursor, durable.cursor);
    await recovery.locator(".chat-inline-error").waitFor();
    assert(await recovery.locator(".chat-turn-agent").count() > 0, "failed refresh keeps cached rows");
    broken = null;
    const resumed = await reopen();
    await recovery.getByText(text, { exact: true }).waitFor();
    assert(resumed.bytes < 5000, "retry sends only the uncommitted tail");
    // Wait until the next reopen can use the new durable cursor before injecting another fault.
    await settings(recovery); await recovery.getByText(/MB in 1 chats/).waitFor(); await recovery.keyboard.press("Escape");
    durable = await reopen();
    console.log(`PASS ${fault} mid-delta retains cached rows and resumes the missing tail`);
  }
  // Simulate a damaged persisted payload; successful recovery is observed only via UI and HTTP.
  await recovery.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("herdr-web-ui:chat-history"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("pages", "readwrite");
      const request = tx.objectStore("pages").openCursor();
      request.onsuccess = () => { const cursor = request.result; if (cursor) { const value = cursor.value; value.body.turns[0].parts = [{ kind: "text", text: "CORRUPTED SYNTHETIC RECORD" }]; cursor.update(value); cursor.continue(); } };
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
    db.close();
  });
  const repaired = await reopen();
  assert.equal(repaired.delta, false, "corrupted record is dropped before HTTP revalidation");
  assert.equal(await recovery.getByText("CORRUPTED SYNTHETIC RECORD", { exact: true }).count(), 0);
  await recovery.getByText("Recovered after partial", { exact: true }).waitFor();
  console.log("PASS corrupted cache records are discarded and refetched in full");

  durable = await reopen();
  for (const fault of ["abort", "quota"] as const) {
    const text = `Atomic recovery after ${fault}`;
    bodies.get(recoveryPane)!.turns.push({ role: "assistant", ts: null, parts: [{ kind: "text", text }] });
    await recovery.evaluate((mode) => sessionStorage.setItem("synthetic-idb-fault", mode), fault);
    await reopen();
    await recovery.getByText(text, { exact: true }).waitFor();
    const resumed = await reopen();
    assert.equal(resumed.cursor, durable.cursor, "failed transaction leaves the prior durable page intact");
    await recovery.getByText(text, { exact: true }).waitFor();
    assert.equal(resumed.turns, 1);
    await recovery.evaluate(() => sessionStorage.removeItem("synthetic-idb-fault"));
    await reopen();
    await recovery.getByText(text, { exact: true }).waitFor();
    durable = await reopen();
    console.log(`PASS IndexedDB ${fault} rolls back atomically and retries only the missing turn`);
  }

  bodies.get(recoveryPane)!.turns.push({ role: "assistant", ts: null, parts: [{ kind: "text", text: "Recovered after tab closure" }] });
  await recovery.evaluate(() => sessionStorage.setItem("synthetic-idb-fault", "hold"));
  await reopen();
  await until(() => recovery.evaluate(() => sessionStorage.getItem("synthetic-write-held") === "true"), "native write transaction held");
  await recovery.close();
  const afterClose = records.length;
  recovery = await resilient.newPage();
  await recovery.goto(`http://cache.test:${server.port}/`);
  await recovery.getByText("Recovered after tab closure", { exact: true }).waitFor();
  const resumedAfterClose = records.slice(afterClose).find((r) => r.pane === recoveryPane)!;
  assert.equal(resumedAfterClose.cursor, durable.cursor);
  assert.equal(resumedAfterClose.turns, 1);
  console.log("PASS closing a tab mid-transaction preserves its previous durable chat");

  // Delay an older HTTP answer until another tab has committed a newer one.
  const sibling = await resilient.newPage();
  await sibling.goto(`http://cache.test:${server.port}/`);
  await sibling.getByText("Recovered after tab closure", { exact: true }).waitFor();
  let releaseOlder!: () => void;
  let olderReady = false;
  const olderHeld = new Promise<void>((resolve) => { releaseOlder = resolve; });
  await recovery.route("**/pane/conversation?*", async (route) => {
    // Playwright's HTTP client does not use Chromium's synthetic hostname resolver.
    const response = await route.fetch({ url: route.request().url().replace("cache.test", "127.0.0.1") }); olderReady = true;
    await olderHeld;
    await route.fulfill({ response });
  }, { times: 1 });
  bodies.get(recoveryPane)!.turns.push({ role: "assistant", ts: null, parts: [{ kind: "text", text: "Concurrent older answer" }] });
  await recovery.reload();
  await until(() => olderReady, "older tab response held");
  bodies.get(recoveryPane)!.turns.push({ role: "assistant", ts: null, parts: [{ kind: "text", text: "Concurrent newest answer" }] });
  await sibling.reload();
  await sibling.getByText("Concurrent newest answer", { exact: true }).waitFor();
  releaseOlder();
  await recovery.getByText("Concurrent older answer", { exact: true }).waitFor();
  await sibling.close();
  const concurrent = await reopen();
  await recovery.getByText("Concurrent newest answer", { exact: true }).waitFor();
  assert.equal(concurrent.turns, 0, "late writer cannot overwrite another tab's newer durable page");
  console.log("PASS concurrent tabs preserve the newer committed chat");

  const cdp = await resilient.newCDPSession(recovery);
  await cdp.send("Storage.clearDataForOrigin", { origin: `http://cache.test:${server.port}`, storageTypes: "indexeddb" });
  const evicted = await reopen();
  assert.equal(evicted.delta, false);
  await recovery.getByText("Concurrent newest answer", { exact: true }).waitFor();
  console.log("PASS browser storage eviction refetches a complete valid chat");

  const pageBody = (text: string, cursor: string | null): ConversationResponse => ({ source: "claude-transcript", history_id: "fictional-paged-session", cursor, turns: [
    { role: "user", ts: null, parts: [{ kind: "text", text: `Question for ${text}` }] },
    { role: "assistant", ts: null, parts: [{ kind: "text", text: text + "\n\n" + "Fictional page content. ".repeat(150) }] },
  ] });
  bodies.set(recoveryPane, pageBody("Newest durable page", "older-2"));
  earlier.set("older-2", pageBody("Middle durable page", "older-1"));
  earlier.set("older-1", pageBody("Beginning durable page", null));
  brokenBefore = "older-1"; broken = "partial";
  await reopen();
  await recovery.getByText("Newest durable page", { exact: true }).waitFor();
  await recovery.locator(".chat-older").press("Enter");
  await recovery.getByText("Middle durable page", { exact: true }).waitFor();
  await recovery.locator(".chat-older").press("Enter");
  await recovery.getByRole("button", { name: "Couldn't load earlier messages — retry", exact: true }).waitFor();
  broken = null;
  const beforeResume = records.length;
  await reopen();
  await recovery.getByText("Middle durable page", { exact: true }).waitFor();
  if (await recovery.locator(".chat-older").count()) await recovery.locator(".chat-older").press("Enter");
  await recovery.getByText("Beginning durable page", { exact: true }).waitFor();
  assert(!records.slice(beforeResume).some((r) => r.before === "older-2"), "completed older page is not downloaded again");
  assert(records.slice(beforeResume).some((r) => r.before === "older-1"));
  console.log("PASS interrupted older-page download resumes after its last durable page");
  await settings(recovery);
  await recovery.getByRole("button", { name: "Clear cache on this device", exact: true }).click();
  await recovery.getByText("0.00 MB in 0 chats", { exact: true }).waitFor();
  const afterClear = records.length;
  bodies.set(recoveryPane, pageBody("Newest after clear", "older-2"));
  await recovery.keyboard.press("Escape");
  await until(() => records.slice(afterClear).some((r) => r.pane === recoveryPane && !r.delta), "full refresh after clear");
  await recovery.getByText("Newest after clear", { exact: true }).waitFor();
  await recovery.getByText("Beginning durable page", { exact: true }).waitFor();
  await settings(recovery);
  const cacheSwitch = recovery.getByRole("switch", { name: "Cache chat history on this device", exact: true });
  await cacheSwitch.click();
  await recovery.getByText("0.00 MB in 0 chats", { exact: true }).waitFor();
  await recovery.keyboard.press("Escape");
  await recovery.getByText("Beginning durable page", { exact: true }).waitFor();
  await settings(recovery);
  const afterEnable = records.length;
  bodies.set(recoveryPane, pageBody("Newest after enabling cache", "older-2"));
  await cacheSwitch.click();
  await recovery.keyboard.press("Escape");
  await until(() => records.slice(afterEnable).some((r) => r.pane === recoveryPane && !r.delta), "full refresh after enabling cache");
  await recovery.getByText("Newest after enabling cache", { exact: true }).waitFor();
  await recovery.getByText("Beginning durable page", { exact: true }).waitFor();
  console.log("PASS clear and enable-after-paging retain visible older pages");
  await resilient.close();
} finally { release(); await browser?.close(); server?.stop(true); rmSync(app, { recursive: true, force: true }); }
