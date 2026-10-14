/** Real app actions over synthetic HTTP conversations; no native sessions or model calls. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { conversationDelta } from "../shared/conversation-delta.ts";
import type { ConversationResponse } from "../shared/protocol.ts";
import { buildDemoApp } from "./demo-build.ts";
import { openSettingsPage } from "./settings-page.ts";

const app = mkdtempSync(join(tmpdir(), "herdr-chat-cache-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR;
const records: { pane: string; delta: boolean; incremental: boolean; bytes: number; cursor: string | null; turns: number; before: string | null; status?: number; client?: string | null }[] = [];
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
/** Scrolls the transcript to its top until the oldest turn's text shows. */
async function oldestTurn(page: Page, text: string) {
  const log = page.getByRole("log").first();
  await until(async () => {
    await log.evaluate((node) => { node.scrollTop = 0; node.dispatchEvent(new Event("scroll")); });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    return await log.evaluate((node, wanted) => node.textContent!.includes(wanted), text);
  }, `oldest turn shows ${text.trim()}`);
}
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await buildDemoApp(app);
  // Keep the demo's status/terminal transport, but exercise conversation reads over real HTTP.
  writeFileSync(join(app, "cache-transport.js"), `const demoFetch = window.fetch; window.cacheDemoFetch = demoFetch; window.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    return url.pathname.endsWith("/pane/conversation") ? window.cacheNativeFetch(input, init) : demoFetch(input, init);
  };
  const withSession = (body) => {
    if (!sessionStorage.getItem("fixture-session")) return body;
    if (body.snapshot?.panes) for (const pane of body.snapshot.panes) if (pane.agent) pane.agent_session = { agent: pane.agent, kind: "id", source: "fixture", value: sessionStorage.getItem("fixture-session") };
    for (const machine of body.machines ?? []) withSession(machine);
    return body;
  };
  const fixtureFetch = window.fetch;
  window.fetch = async (input, init) => {
    const response = await fixtureFetch(input, init);
    const path = new URL(typeof input === "string" ? input : input.url, location.href).pathname;
    return path.endsWith("/session") || path.endsWith("/machines") ? new Response(JSON.stringify(withSession(await response.json())), { status: response.status, headers: response.headers }) : response;
  };
  const FixtureSocket = window.WebSocket;
  const FixtureEvents = window.EventSource;
  window.EventSource = function(...args) {
    const source = new FixtureEvents(...args);
    const add = source.addEventListener.bind(source);
    const wrap = (next) => (event) => next(new MessageEvent("message", { data: JSON.stringify(withSession(JSON.parse(event.data))) }));
    source.addEventListener = (type, next, options) => add(type, type === "message" ? wrap(next) : next, options);
    let listener = null;
    Object.defineProperty(source, "onmessage", { get: () => listener, set: (next) => { listener = next && wrap(next); } });
    return source;
  };
  window.WebSocket = class extends FixtureSocket {
    addEventListener(type, next, options) {
      super.addEventListener(type, type === "message" ? (event) => {
        if (typeof event.data !== "string") return next(event);
        next(new MessageEvent("message", { data: JSON.stringify(withSession(JSON.parse(event.data))) }));
      } : next, options);
    }
  };`);
  const index = join(app, "index.html");
  // The demo's fixture transport calls crypto.randomUUID, which plain HTTP lacks; the app itself guards every call.
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script>if (!crypto.randomUUID) crypto.randomUUID = () => { const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128; const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join("-"); }; window.cacheNativeFetch = window.fetch.bind(window);</script><script src="./demo-transport.js"></script><script src="./cache-transport.js"></script><script type="module"'));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/pane/conversation")) {
      if (held) await new Promise<void>((resolve) => pending.push(resolve));
      if (denied) { refusals += 1; return Response.json({ error: { code: "unauthorized", message: "Synthetic access refusal" } }, { status: 401 }); }
      const pane = url.searchParams.get("pane_id")!;
      const newest = bodies.get(pane) ?? fixture(pane); bodies.set(pane, newest);
      const raw = earlier.get(`${url.searchParams.get("before")}:${url.searchParams.get("since")}`) ?? earlier.get(url.searchParams.get("before") ?? "") ?? newest;
      const incremental = url.searchParams.get("incremental") === "1";
      const { cache_session: nativeSession, ...plain } = raw;
      const body = legacy || !incremental ? plain : { ...raw, cache_session: nativeSession ?? `${raw.source}:${raw.history_id}` };
      const answer = incremental && !legacy ? await conversationDelta(body, url.searchParams.get("delta")) : body;
      const json = JSON.stringify(answer);
      const etag = `"${Bun.hash(JSON.stringify(body))}"`;
      const unchanged = conditional && request.headers.get("if-none-match") === etag;
      records.push({ pane, delta: url.searchParams.has("delta"), incremental, bytes: new TextEncoder().encode(json).byteLength, cursor: url.searchParams.get("delta"), turns: answer.turns.length, before: url.searchParams.get("before"), status: unchanged ? 304 : 200, client: request.headers.get("x-fixture-client") });
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
    if (!localStorage.getItem("ovis:settings")) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", theme: "dark" }));
  });
  const page = await context.newPage();
  await page.goto(`http://cache.test:${server.port}/`);
  assert.equal(await page.evaluate(() => isSecureContext), false);
  assert.equal(await page.evaluate(() => typeof crypto.subtle), "undefined");
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.locator(".chat-turn-agent").first().waitFor();
  assert(records.length > 0 && records.every((r) => !r.incremental && !r.delta), "flag off keeps the existing request");
  const first = records[0]!.pane;
  const insecureDemo = await page.evaluate(async (pane) => {
    const demoFetch = (window as unknown as { cacheDemoFetch: typeof fetch }).cacheDemoFetch;
    return await (await demoFetch(`/api/pane/conversation?pane_id=${encodeURIComponent(pane)}&incremental=1`)).json();
  }, first);
  assert(insecureDemo.source !== "scrollback" && insecureDemo.turns.length > 0, "demo conversation works without SubtleCrypto");
  console.log("PASS real demo conversation cache path works on insecure HTTP");
  await settings(page);
  const toggle = page.getByRole("switch", { name: "Cache chat history on this device", exact: true });
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  assert.equal(await page.getByLabel("Maximum chat cache (MB)", { exact: true }).inputValue(), "500");
  await toggle.click();
  await page.getByText(/MB in 1 chats/).waitFor();
  await page.keyboard.press("Escape");
  await settings(page);
  await page.getByLabel("Maximum chat cache (MB)", { exact: true }).fill("17");
  await page.keyboard.press("Escape");
  await settings(page);
  assert.equal(await page.getByLabel("Maximum chat cache (MB)", { exact: true }).inputValue(), "17", "Escape commits the pending cache limit");
  await page.getByLabel("Maximum chat cache (MB)", { exact: true }).fill("500");
  await page.getByLabel("Maximum chat cache (MB)", { exact: true }).press("Enter");
  await page.keyboard.press("Escape");
  console.log("PASS Escape commits the pending cache limit without blur");
  held = true;
  await page.reload();
  await until(() => pending.length > 0, "identity validation held");
  assert.equal(await page.locator(".chat-turn-agent").count(), 0, "unknown identity never renders saved rows");
  assert.equal(await page.locator(".chat-edge-loading.is-newer").isVisible(), false, "unknown identity has no timeline-edge indicator");
  release();
  await until(() => records.some((r) => r.pane === first && r.delta), "reopen delta");
  const fullBytes = records.find((r) => r.pane === first && r.incremental && !r.delta)!.bytes;
  const deltaBytes = records.find((r) => r.pane === first && r.delta)!.bytes;
  assert(deltaBytes < fullBytes / 50);
  console.log(`PASS identity confirmed before cached render; full=${fullBytes}B reopen=${deltaBytes}B`);

  const knownContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await knownContext.addInitScript(() => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", chatHistoryCache: true }));
    sessionStorage.setItem("fixture-session", "fictional-known-agent-session");
  });
  const knownPage = await knownContext.newPage();
  await knownPage.goto(`http://cache.test:${server.port}/`);
  await knownPage.locator(".chat-turn-agent").first().waitFor();
  await settings(knownPage); await knownPage.getByText(/MB in 1 chats/).waitFor(); await knownPage.keyboard.press("Escape");
  held = true;
  const reopenStarted = Date.now();
  await knownPage.reload();
  await until(() => pending.length > 0, "known session refresh held");
  await knownPage.locator(".chat-turn-agent").first().waitFor({ timeout: 2000 });
  assert.equal(await knownPage.getByText("Loading conversation…", { exact: true }).count(), 0);
  console.log(`PASS known client session restores cached rows before HTTP in ${Date.now() - reopenStarted}ms without loading text`);
  assert.equal(await knownPage.locator(".chat-edge-loading.is-newer").isVisible(), false, "fast refresh has no loading indicator");
  const fastResponse = knownPage.waitForResponse((response) => response.url().includes("/pane/conversation?"));
  release(); await (await fastResponse).finished();
  await until(() => Date.now() - reopenStarted >= 500, "fast refresh completed before indicator threshold");
  assert.equal(await knownPage.locator(".chat-edge-loading.is-newer").isVisible(), false);
  const slowRequest = knownPage.waitForRequest((request) => request.url().includes("/pane/conversation?"));
  held = true;
  await slowRequest;
  // fixed wait: proves no bottom loader appears once the slow refresh outlasts the 500 ms threshold
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(await knownPage.locator(".chat-edge-loading.is-newer").count(), 0, "slow newest refresh shows no bottom loader");
  assert.equal(await knownPage.locator(".chat-edge-loading.is-older").isVisible(), false, "no older indicator during newest refresh");
  console.log("PASS fast and slow newest-page refreshes stay quiet at the bottom edge");
  release(); await knownPage.waitForLoadState("networkidle");
  const knownOriginal = bodies.get(first)!;
  const knownPrefix: ConversationResponse = { source: "claude-transcript", history_id: "fictional-known-rewrite", cursor: null, turns: [
    { role: "assistant", ts: null, parts: [{ kind: "text", text: "Known session saved prefix" }] },
    { role: "user", ts: null, parts: [{ kind: "text", text: "Known prefix boundary" }] },
  ] };
  earlier.set("known-prefix", knownPrefix);
  bodies.set(first, { ...knownPrefix, cursor: "known-prefix", turns: [{ role: "assistant", ts: null, parts: [{ kind: "text", text: "Known session newest page" }] }] });
  await knownPage.reload();
  await knownPage.getByText("Known session saved prefix", { exact: true }).waitFor();
  await knownPage.waitForLoadState("networkidle");
  knownPrefix.turns[0]!.parts = [{ kind: "text", text: "Known session rewritten prefix" }];
  held = true;
  await knownPage.reload();
  await knownPage.getByText("Known session saved prefix", { exact: true }).waitFor();
  release();
  await knownPage.getByText("Known session rewritten prefix", { exact: true }).waitFor();
  assert.equal(await knownPage.getByText("Known session saved prefix", { exact: true }).count(), 0);
  await knownContext.close(); bodies.set(first, knownOriginal);
  console.log("PASS known-session immediate restore still discards a rewritten saved prefix after background validation");

  {
    const edges = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await edges.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", chatHistoryCache: true })));
    const original = bodies.get(first)!;
    const turns = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, ts: null, parts: [{ kind: "text" as const, text: `Edge row ${index}. ` + "Fictional paragraph. ".repeat(15) }] }));
    bodies.set(first, { source: "claude-transcript", history_id: "fictional-visible-edge", cursor: "edge-older", turns });
    earlier.set("edge-older", { ...bodies.get(first)!, cursor: null, turns: turns.map((turn) => ({ ...turn, parts: [{ kind: "text", text: "Earlier edge content. ".repeat(15) }] })) });
    let releaseEdge!: () => void;
    const waitEdge = new Promise<void>((resolve) => { releaseEdge = resolve; });
    const pane = await edges.newPage();
    await pane.route("**/pane/conversation?*", async (route) => {
      if (new URL(route.request().url()).searchParams.get("before") === "edge-older") await waitEdge;
      await route.continue();
    });
    await pane.goto(`http://cache.test:${server.port}/`);
    await pane.locator(".chat-turn-agent").first().waitFor();
    const log = pane.getByRole("log").first();
    await pane.evaluate(() => document.fonts.ready);
    await until(async () => {
      await log.evaluate((node) => { node.scrollTop = 0; node.dispatchEvent(new Event("scroll")); });
      await pane.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      return await pane.getByRole("button", { name: "Jump to latest", exact: true }).isVisible() && await log.evaluate((node) => node.scrollTop <= 1);
    }, "reader reaches the visible older edge");
    await pane.locator(".chat-edge-loading.is-older").getByText("Loading earlier messages…", { exact: true }).waitFor();
    assert.equal(await pane.locator(".chat-edge-loading.is-newer").isVisible(), false);
    assert.equal(await pane.getByRole("button", { name: "Loading earlier messages…", exact: true }).isVisible(), false, "the fixed overlay is the only visible earlier-loading label");
    if (evidence) mkdirSync(evidence, { recursive: true });
    if (evidence) for (const width of [390, 1280]) {
      await pane.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      for (const theme of ["dark", "light"] as const) {
        await settings(pane); await openSettingsPage(pane, "Appearance");
        await pane.getByRole("button", { name: theme === "dark" ? "Dark" : "Light", exact: true }).click();
        await pane.getByRole("button", { name: "Close settings", exact: true }).click();
        await pane.locator(".settings-dialog").waitFor({ state: "detached" });
        await until(async () => await pane.locator("body > [inert][aria-hidden=true]").count() === 0, "closed settings sheet has left the screenshot");
        await pane.evaluate(async () => { await document.fonts.ready; await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
        await pane.locator(".chat-edge-loading.is-older").waitFor();
        await pane.screenshot({ path: join(evidence, `loading-${width === 390 ? "phone" : "desktop"}-${theme}.png`), animations: "disabled" });
      }
    }
    if (evidence) {
      await pane.setViewportSize({ width: 390, height: 844 });
      await settings(pane); await openSettingsPage(pane, "Appearance");
      await pane.getByRole("button", { name: "Dark", exact: true }).click();
      await pane.getByRole("button", { name: "Close settings", exact: true }).click();
      await pane.locator(".settings-dialog").waitFor({ state: "detached" });
    }
    assert.deepEqual(pane.viewportSize(), { width: 390, height: 844 }, "evidence preserves the phone touch viewport");
    assert.equal(await pane.evaluate(() => document.documentElement.dataset.theme), "dark", "evidence preserves the touch theme");
    const anchor = await log.locator("[data-chat-row]").first().evaluate((row) => ({ key: (row as HTMLElement).dataset.chatRow!, offset: row.getBoundingClientRect().top - row.closest("[role=log]")!.getBoundingClientRect().top }));
    const cdp = await edges.newCDPSession(pane);
    const rect = await log.boundingBox();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: rect!.x + rect!.width / 2, y: rect!.y + 100 }] });
    const arrived = pane.waitForResponse((response) => new URL(response.url()).searchParams.get("before") === "edge-older");
    releaseEdge(); await (await arrived).finished();
    assert(await pane.locator(".chat-edge-loading.is-older").isVisible(), "visible-edge indicator remains until buffered pages can merge");
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await pane.locator(".chat-edge-loading.is-older").waitFor({ state: "hidden" });
    await until(async () => Math.abs(await log.locator(`[data-chat-row='${anchor.key}']`).evaluate((row) => row.getBoundingClientRect().top - row.closest("[role=log]")!.getBoundingClientRect().top) - anchor.offset) <= 1, "visible-edge indicator disappears without shifting the touched row");
    await edges.close(); bodies.set(first, original);
    console.log("PASS slow visible older edge is labeled and indicator disappearance preserves the touched row within 1px");
  }

  {
    const wide = await browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { "x-fixture-client": "many-turns" } });
    await wide.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", chatHistoryCache: true })));
    const original = bodies.get(first)!;
    bodies.set(first, { source: "claude-transcript", history_id: "fictional-many-turns", cursor: null,
      turns: Array.from({ length: 200 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, ts: null, parts: [{ kind: "text" as const, text: `Many-turn row ${index}. ` + "Fictional paragraph. ".repeat(50) }] })) });
    const pane = await wide.newPage();
    await pane.goto(`http://cache.test:${server.port}/`);
    await pane.locator(".chat-turn-agent").first().waitFor();
    await pane.waitForLoadState("networkidle");
    const at = records.length;
    await pane.reload();
    await pane.locator(".chat-turn-agent").first().waitFor();
    await until(() => records.slice(at).some((record) => record.client === "many-turns" && record.delta), "200-turn cached page validated");
    assert.equal(records.slice(at).find((record) => record.client === "many-turns" && record.delta)!.turns, 0, "a 200-turn cursor validates without a full-page fallback");
    bodies.get(first)!.turns.push({ role: "assistant", ts: null, parts: [{ kind: "text", text: "Many-turn appended answer" }] });
    const appendAt = records.length;
    await pane.reload();
    await pane.getByText("Many-turn appended answer", { exact: true }).waitFor();
    assert.equal(records.slice(appendAt).find((record) => record.client === "many-turns" && record.delta)!.turns, 1, "a large page sends only its appended turn");
    await wide.close(); bodies.set(first, original);
    console.log("PASS cursors for 200-turn pages transfer only changed turns");
  }

  {
    const fallback = await browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { "x-fixture-client": "full-fallback" } });
    await fallback.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", chatHistoryCache: true })));
    const original = bodies.get(first)!;
    const turn = (index: number) => ({ role: index % 2 ? "assistant" as const : "user" as const, ts: null, parts: [{ kind: "text" as const, text: `Fallback turn ${index} ` + "x".repeat(2000) }] });
    bodies.set(first, { source: "claude-transcript", history_id: "fictional-full-fallback", cursor: "fallback-100", turns: Array.from({ length: 100 }, (_, index) => turn(100 + index)) });
    earlier.set("fallback-100", { ...bodies.get(first)!, cursor: null, turns: Array.from({ length: 100 }, (_, index) => turn(index)) });
    const pane = await fallback.newPage();
    await pane.goto(`http://cache.test:${server.port}/`);
    await pane.locator(".chat-turn-agent").first().waitFor();
    await settings(pane);
    await until(async () => Number.parseFloat(await pane.getByText(/MB in 1 chats/).innerText()) > 0.4, "fallback history saved in full");
    const usedBefore = Number.parseFloat(await pane.getByText(/MB in 1 chats/).innerText());
    bodies.get(first)!.turns.at(-1)!.parts = [{ kind: "text", text: "Fresh fallback update" }];
    const at = records.length;
    await pane.route("**/pane/conversation?*", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.has("delta")) url.searchParams.set("delta", "invalid-cursor");
      await route.continue({ url: url.href });
    });
    await until(() => records.slice(at).some((record) => record.client === "full-fallback" && record.cursor === "invalid-cursor"), "server returns a complete page for a rejected cursor");
    await pane.getByText("Fresh fallback update", { exact: true }).waitFor({ state: "attached" });
    assert(Math.abs(Number.parseFloat(await pane.getByText(/MB in 1 chats/).innerText()) - usedBefore) <= 0.01, "full fallback retains saved older pages and usage");
    await pane.keyboard.press("Escape");
    await pane.unroute("**/pane/conversation?*");
    await pane.reload();
    await pane.locator(".chat-turn-agent").first().waitFor();
    await oldestTurn(pane, "Fallback turn 0 ");
    await fallback.close(); bodies.set(first, original); earlier.delete("fallback-100");
    console.log("PASS rejected delta cursors preserve older saved history, usage and oldest turn");
  }

  // A rewrite with the same native identity must discard the old prefix.
  bodies.get(first)!.turns[10]!.parts = [{ kind: "text", text: "Rewritten synthetic question" }];
  bodies.get(first)!.turns[11]!.parts = [{ kind: "text", text: "Rewritten synthetic answer" }];
  await page.reload();
  await page.getByText("Rewritten synthetic answer", { exact: true }).waitFor();
  console.log("PASS stale cached prefix reloads from HTTP");

  // The pane locator can survive replacement by an unrelated native agent session.
  bodies.set(first, { source: "claude-transcript", history_id: `fictional-${first}`, cache_session: "fictional-reused-native-session", cursor: null,
    turns: [{ role: "assistant", ts: null, parts: [{ kind: "text", text: "Replacement native session only" }] }] });
  held = true;
  await page.reload();
  await until(() => pending.length > 0, "replacement session validation held");
  assert.equal(await page.locator(".chat-turn-agent").count(), 0, "pane reuse shows no previous session before confirmation");
  release();
  await page.getByText("Replacement native session only", { exact: true }).waitFor();
  assert.equal(await page.getByText("Rewritten synthetic answer", { exact: true }).count(), 0);
  await settings(page);
  await page.getByText(/MB in 1 chats/).waitFor();
  await page.keyboard.press("Escape");
  bodies.set(first, fixture(first));
  await page.reload();
  await page.getByText(/^Synthetic answer 5\./).waitFor();
  console.log("PASS reused pane identity replaces its stale cached session without exposing old rows");

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
  if (evidence) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSettingsPage(page, "Appearance");
    await page.getByRole("button", { name: "Dark", exact: true }).click();
    await openSettingsPage(page, "Chat");
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
  await begunRead;
  assert.equal(await page.locator(".chat-turn-agent").count(), 0);
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
  const pausedRead = page.waitForResponse((response) => response.url().includes("/pane/conversation?") && !response.url().includes("incremental="));
  await toggle.click();
  await (await pausedRead).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.getByText(/MB in 1 chats/).waitFor({ timeout: 5000 });
  await page.keyboard.press("Escape");
  const whilePaused = records.length;
  await page.reload();
  await page.locator(".chat-turn-agent").first().waitFor();
  await until(() => records.slice(whilePaused).some((record) => !record.incremental && !record.delta), "plain HTTP while cache paused");
  await settings(page);
  await page.getByText(/MB in 1 chats/).waitFor();
  await toggle.click();
  await page.getByText(/MB in 1 chats/).waitFor();
  await page.keyboard.press("Escape");
  held = true;
  const afterPause = records.length;
  await page.reload();
  await until(() => pending.length > 0, "resumed cache validation held");
  assert.equal(await page.locator(".chat-turn-agent").count(), 0, "resuming waits for session confirmation");
  release();
  await until(() => records.slice(afterPause).some((record) => record.delta), "retained cache delta after pause");
  console.log("PASS disabling cache retains history and resuming validates it before rendering");
  denied = true;
  await page.keyboard.press("Escape");
  await page.reload();
  await until(() => refusals > 0, "access refusal");
  await settings(page);
  await page.getByText("0.00 MB in 0 chats", { exact: true }).waitFor();
  console.log("PASS access refusal clears sensitive history");
  await context.close();

  denied = false;
  for (const known of [false, true]) {
    const closed: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { "x-fixture-client": "closed-slide" } });
    await closed.addInitScript((known) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", chatHistoryCache: true, chatHistoryCacheMB: 1 }));
      if (known) sessionStorage.setItem("fixture-session", "fictional-closed-session");
    }, known);
    const turn = (index: number) => ({ role: index % 2 ? "assistant" as const : "user" as const, ts: null, parts: [{ kind: "text" as const, text: `Closed turn ${index} ` + "x".repeat(2000) }] });
    const window = (start: number): ConversationResponse => ({ source: "claude-transcript", history_id: "fictional-closed-slide", cursor: `closed-${start}`, turns: Array.from({ length: 100 }, (_, index) => turn(start + index)) });
    bodies.set(first, window(100));
    earlier.set("closed-100", { ...window(0), cursor: null });
    let pane: Page = await closed.newPage();
    const initialAt = records.length;
    await pane.goto(`http://cache.test:${server.port}/`);
    await pane.locator(".chat-turn-agent").first().waitFor();
    await until(() => records.slice(initialAt).some((record) => record.client === "closed-slide" && record.before === "closed-100"), "initial closed-tab history downloaded");
    await pane.locator(".chat-older").waitFor({ state: "detached" });
    await pane.waitForLoadState("networkidle");
    await settings(pane);
    const usedBefore = Number.parseFloat(await pane.getByText(/MB in 1 chats/).innerText());
    assert(usedBefore > 0.4);
    const usage = [usedBefore];
    for (const start of [102, 104, 106, 108]) {
      await pane.close();
      bodies.set(first, window(start));
      earlier.set(`closed-${start}`, { ...window(start - 100), cursor: `closed-${start - 100}` });
      earlier.set(`closed-${start - 100}`, { ...window(0), cursor: null, turns: Array.from({ length: start - 100 }, (_, index) => turn(index)) });
      earlier.set(`closed-${start}:closed-${start - 2}`, { ...window(start - 2), cursor: `closed-${start - 2}`, turns: [turn(start - 2), turn(start - 1)] });
      const at = records.length;
      pane = await closed.newPage();
      await pane.goto(`http://cache.test:${server.port}/`);
      await pane.getByText(new RegExp(`^Closed turn ${start + 99} `)).waitFor();
      await pane.locator(".chat-older").waitFor({ state: "detached" });
      await pane.waitForLoadState("networkidle");
      const reopened = records.slice(at).filter((record) => record.client === "closed-slide");
      assert(reopened.filter((record) => record.before !== null).every((record) => record.turns <= 2), "closed-tab slide transfers only the missing gap and validated older pages");
      assert(reopened.reduce((sum, record) => sum + record.turns, 0) <= 4, "only two appended turns and their two-turn boundary gap transfer");
      await settings(pane);
      const usedAfter = Number.parseFloat(await pane.getByText(/MB in 1 chats/).innerText());
      usage.push(usedAfter);
      assert(usedAfter <= usedBefore + 0.03, `closed-tab slide keeps storage near unique history: ${usedBefore} -> ${usedAfter} MB`);
      await pane.keyboard.press("Escape");
      await oldestTurn(pane, "Closed turn 0 ");
    }
    await closed.close(); bodies.delete(first);
    console.log(`PASS closed-tab sliding tails reuse validated older history with ${known ? "known" : "unknown"} client identity; usage=${usage.join(" -> ")} MB, at most4 transferred turns per reopen`);
  }
  for (const known of [false, true]) {
    const paused: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await paused.addInitScript((known) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", chatHistoryCache: true }));
      if (known) sessionStorage.setItem("fixture-session", "fictional-toggle-session");
    }, known);
    const prefix: ConversationResponse = { source: "claude-transcript", history_id: "fictional-toggle", cursor: null, turns: [
      { role: "assistant", ts: null, parts: [{ kind: "text", text: "Retained oldest turn" }] },
      { role: "user", ts: null, parts: [{ kind: "text", text: "Retained prefix boundary" }] },
    ] };
    earlier.set("toggle-prefix", prefix);
    bodies.set(first, { ...prefix, cursor: "toggle-prefix", turns: Array.from({ length: 40 }, (_, n) => ({ role: n % 2 ? "assistant" : "user", ts: null, parts: [{ kind: "text", text: `Toggle turn ${n}. ` + "Fictional paragraph. ".repeat(50) }] })) });
    const pane: Page = await paused.newPage();
    await pane.goto(`http://cache.test:${server.port}/`);
    await pane.locator(".chat-turn-agent").first().waitFor();
    await oldestTurn(pane, "Retained oldest turn");
    await pane.evaluate(() => document.fonts.ready);
    const position = () => pane.getByRole("log").first().evaluate((node) => {
      const viewport = node.getBoundingClientRect();
      const row = [...node.querySelectorAll<HTMLElement>("[data-chat-row]")].find((row) => row.getBoundingClientRect().bottom > viewport.top);
      return { key: row?.dataset.chatRow, offset: row ? row.getBoundingClientRect().top - viewport.top : null };
    });
    await pane.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const anchor = await position();
    assert(anchor.key && anchor.offset !== null);
    await settings(pane);
    const live = pane.waitForResponse((response) => response.url().includes("/pane/conversation?") && !new URL(response.url()).searchParams.has("incremental"));
    await pane.getByRole("switch", { name: "Cache chat history on this device", exact: true }).click();
    const response = await live;
    assert.equal((await response.json()).cache_session, undefined, "plain HTTP responses omit the opt-in identity");
    await pane.waitForLoadState("networkidle");
    await pane.keyboard.press("Escape");
    const after = await position();
    assert.equal(after.key, anchor.key, "disabling caching retains the visible older row");
    assert(after.offset !== null && Math.abs(after.offset - anchor.offset!) <= 1, "disabling caching preserves the reader offset within1px");
    await oldestTurn(pane, "Retained oldest turn");
    await paused.close(); bodies.delete(first);
    console.log(`PASS disabling cache retains older rows, anchor and oldest rows with real legacy shape and ${known ? "known" : "unknown"} client identity`);
  }
  {
    const rewritten = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await rewritten.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", chatHistoryCache: true })));
    const prefix: ConversationResponse = { source: "claude-transcript", history_id: "fictional-offline-rewrite", cache_session: "fictional-offline-native-session", cursor: null,
      turns: [{ role: "assistant", ts: null, parts: [{ kind: "text", text: "Original oldest settled prefix" }] }, { role: "user", ts: null, parts: [{ kind: "text", text: "Settled prefix ending" }] }] };
    earlier.set("offline-prefix", prefix);
    bodies.set(first, { ...prefix, cursor: "offline-prefix", turns: [{ role: "assistant", ts: null, parts: [{ kind: "text", text: "Unchanged newest offline page" }] }] });
    const pane = await rewritten.newPage();
    await pane.goto(`http://cache.test:${server.port}/`);
    await pane.getByText("Original oldest settled prefix", { exact: true }).waitFor();
    await settings(pane); await pane.getByText(/MB in 1 chats/).waitFor(); await pane.keyboard.press("Escape");
    prefix.turns[0]!.parts = [{ kind: "text", text: "Rewritten oldest settled prefix" }];
    held = true;
    await pane.reload();
    await until(() => pending.length > 0, "offline rewrite identity read held");
    assert.equal(await pane.locator(".chat-turn-agent").count(), 0);
    release();
    await pane.getByText("Rewritten oldest settled prefix", { exact: true }).waitFor();
    assert.equal(await pane.getByText("Original oldest settled prefix", { exact: true }).count(), 0);
    await rewritten.close();
    bodies.delete(first);
    console.log("PASS saved older prefixes validate before rendering and offline rewrites discard stale history");
  }
  {
    const sliding = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await sliding.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", chatHistoryCache: true, chatHistoryCacheMB: 1 })));
    const turn = (index: number) => ({ role: index % 2 ? "assistant" as const : "user" as const, ts: null, parts: [{ kind: "text" as const, text: `Sliding turn ${index} ` + "x".repeat(2000) }] });
    const window = (start: number): ConversationResponse => ({ source: "claude-transcript", history_id: "fictional-sliding-storage", cursor: `storage-${start}`, turns: Array.from({ length: 100 }, (_, index) => turn(start + index)) });
    bodies.set(first, window(100));
    earlier.set("storage-100", { ...window(0), cursor: null });
    const pane = await sliding.newPage();
    await pane.goto(`http://cache.test:${server.port}/`);
    await pane.locator(".chat-turn-agent").first().waitFor();
    await until(() => records.some((record) => record.before === "storage-100"), "initial older storage page");
    await pane.locator(".chat-older").waitFor({ state: "detached" });
    for (const start of [102, 104, 106, 108]) {
      earlier.set(`storage-${start}`, { ...window(start - 2), cursor: `storage-${start - 2}`, turns: [turn(start - 2), turn(start - 1)] });
      bodies.set(first, window(start));
      await pane.getByText(new RegExp(`^Sliding turn ${start + 99} `)).waitFor();
      await settings(pane);
      const used = await pane.getByText(/MB in 1 chats/).innerText();
      assert(Number.parseFloat(used) < 0.6, `superseded held-start pages are excluded from usage: ${used}`);
      await pane.keyboard.press("Escape");
    }
    await sliding.close();
    bodies.delete(first);
    console.log("PASS sliding newest windows retain complete history below the unique-page cache limit");
  }
  {
    const gapContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await gapContext.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", chatHistoryCache: true })));
    bodies.set(first, fixture(first));
    const page = await gapContext.newPage();
    await page.goto(`http://cache.test:${server.port}/`);
    await page.getByText(/^Synthetic answer 5\./).waitFor();
  // A stale prefix and a sliding newest page must keep the visible chat usable
  // while the bridge supplies the gap between the two page cursors.
  const renderErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") renderErrors.push(message.text()); });
  page.on("pageerror", (error) => renderErrors.push(error.stack ?? error.message));
  let releaseGap!: () => void;
  const gapHeld = new Promise<void>((resolve) => { releaseGap = resolve; });
  let gapArrived = false;
  await page.route("**/pane/conversation?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("before") === "synthetic-slide") {
      gapArrived = true;
      await gapHeld;
    }
    await route.continue();
  });
  const newest = bodies.get(first)!;
  newest.cursor = "synthetic-slide";
  newest.turns.at(-1)!.parts = [{ kind: "text", text: "Gap refresh completed" }];
  newest.turns[0]!.parts = [{ kind: "text", text: "Rewritten first synthetic question" }];
  earlier.set("synthetic-slide", { ...newest, cursor: null, turns: [{ role: "user", ts: null, parts: [{ kind: "text", text: "Synthetic gap question" }] }] });
  try {
    await until(() => gapArrived, "stale prefix sliding-page gap");
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await page.locator(".chat-empty[role=alert]").count(), 0, renderErrors.join("\n"));
    assert(await page.locator(".chat-turn-agent").count() > 0, "visible turns survive a pending gap read");
  } finally { releaseGap(); }
  await page.getByText("Gap refresh completed", { exact: true }).waitFor();
  await page.unroute("**/pane/conversation?*");
  console.log("PASS stale delta with a sliding page keeps chat readable during gap loading");
    await gapContext.close();
    bodies.delete(first);
  }
  for (const reduced of [false, true]) {
    const reveal = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: reduced ? "reduce" : "no-preference" });
    await reveal.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", chatHistoryCache: true })));
    bodies.set(first, { source: "claude-transcript", history_id: "fictional-reveal", cursor: null, turns: [{ role: "assistant", ts: null, parts: [{ kind: "text", text: "Initial reveal content" }] }] });
    const pane = await reveal.newPage();
    await pane.goto(`http://cache.test:${server.port}/`);
    await pane.getByText("Initial reveal content", { exact: true }).waitFor();
    await pane.evaluate(() => {
      const seen = window as unknown as { revealAnimations: string[] };
      seen.revealAnimations = [];
      new MutationObserver(() => {
        for (const row of document.querySelectorAll(".chat-row-reveal")) seen.revealAnimations.push(getComputedStyle(row).animationName);
      }).observe(document.querySelector(".chat-frame-body")!, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    });
    held = true;
    await until(() => pending.length > 0, "newest-page refresh held");
    assert.equal(await pane.locator(".chat-edge-loading.is-newer").count(), 0, "a held newest-page refresh shows no bottom loader");
    bodies.get(first)!.turns.push({ role: "assistant", ts: null, parts: [{ kind: "text", text: "New revealed content" }] });
    release();
    await pane.getByText("New revealed content", { exact: true }).waitFor();
    await until(() => pane.evaluate((reduce) => (window as unknown as { revealAnimations: string[] }).revealAnimations.includes(reduce ? "none" : "chat-row-reveal"), reduced), "new turn reveal follows the motion preference");
    await until(() => pane.getByRole("log").first().evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop <= 1), "following reader remains pinned at the bottom");
    await reveal.close();
    console.log(`PASS no bottom loading indicator and new-turn reveal with reduced motion ${reduced ? "on" : "off"}`);
  }
  {
    const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await touch.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", chatHistoryCache: true })));
    bodies.set(first, { source: "claude-transcript", history_id: "fictional-touch-tail", cursor: null, turns: Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, ts: null, parts: [{ kind: "text" as const, text: `Touch tail row ${index}. ` + "Fictional paragraph. ".repeat(25) }] })) });
    const pane = await touch.newPage();
    const native = await touch.newCDPSession(pane);
    await pane.goto(`http://cache.test:${server.port}/`);
    await pane.locator(".chat-turn-agent").first().waitFor();
    const log = pane.getByRole("log").first();
    await pane.evaluate(() => document.fonts.ready);
    let stable = 0, previous = "";
    await until(async () => {
      await pane.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      const layout = await log.evaluate((node) => `${node.scrollHeight}:${node.scrollTop}`);
      stable = layout === previous ? stable + 1 : 0; previous = layout; return stable >= 10;
    }, "tail layout settled");
    held = true;
    await until(() => pending.length > 0, "tail refresh held");
    const rect = await log.boundingBox(); assert(rect);
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    await native.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await native.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + 30 }] });
    await until(() => log.evaluate((node) => { const distance = node.scrollHeight - node.clientHeight - node.scrollTop; return distance > 1 && distance < 48; }), "touch reader inside the near-bottom tolerance");
    const anchor = await log.evaluate((node) => {
      const top = node.getBoundingClientRect().top;
      const row = [...node.querySelectorAll<HTMLElement>("[data-chat-row]")].find((row) => row.getBoundingClientRect().bottom > top);
      return { top: node.scrollTop, key: row!.dataset.chatRow!, offset: row!.getBoundingClientRect().top - top };
    });
    bodies.get(first)!.turns.push({ role: "assistant", ts: null, parts: [{ kind: "text", text: "New touch tail content. " + "Fictional growing paragraph. ".repeat(150) }] });
    release();
    await pane.getByText(/^New touch tail content\./).waitFor({ state: "attached" });
    await pane.evaluate(async () => { for (let frame = 0; frame < 10; frame++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
    const after = await log.evaluate((node, key) => ({ top: node.scrollTop, offset: node.querySelector<HTMLElement>(`[data-chat-row='${key}']`)?.getBoundingClientRect().top! - node.getBoundingClientRect().top }), anchor.key);
    assert(Math.abs(after.top - anchor.top) <= 1, `new turns must not follow the bottom during touch: ${JSON.stringify({anchor,after})}`);
    assert(Math.abs(after.offset - anchor.offset) <= 1, "tail arrival preserves the touched row");
    await native.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await touch.close();
    console.log("PASS new turns never pull a touched reader within the near-bottom tolerance");
  }
  // Real Chromium touch gestures, with identical motion and delayed older HTTP pages.
  const swipeResults: { text: string | null; offset: number; nativeTravel: number }[] = [];
  for (const fillDuringSwipe of [false, true]) {
    const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
    await touch.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", chatHistoryCache: true })));
    const mobile = await touch.newPage();
    const native = await touch.newCDPSession(mobile);
    const turns = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, ts: null,
      parts: [{ kind: "text" as const, text: `Touch row ${index}. ` + "Fictional paragraph. ".repeat(15) }] }));
    bodies.set(first, { source: "claude-transcript", history_id: "fictional-touch-history", cursor: "touch-older", turns });
    earlier.set("touch-older", { ...bodies.get(first)!, cursor: null, turns: turns.map((turn) => ({ ...turn, parts: [{ kind: "text", text: "Earlier touch content. ".repeat(15) }] })) });
    let releaseFill!: () => void;
    const fillHeld = new Promise<void>((resolve) => { releaseFill = resolve; });
    await mobile.route("**/pane/conversation?*", async (route) => {
      if (new URL(route.request().url()).searchParams.get("before") === "touch-older") await fillHeld;
      await route.continue();
    });
    await mobile.goto(`http://cache.test:${server.port}/`);
    const log = mobile.getByRole("log").first();
    await mobile.locator(".chat-turn-agent").first().waitFor();
    await mobile.evaluate(() => document.fonts.ready);
    await until(async () => {
      await log.evaluate((node) => { node.scrollTop = (node.scrollHeight - node.clientHeight) / 2; node.dispatchEvent(new Event("scroll")); });
      await mobile.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      return mobile.getByRole("button", { name: "Jump to latest", exact: true }).isVisible();
    }, "touch reader positioned above the settled initial list");
    await mobile.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    let layout = "", layoutStable = 0;
    await until(async () => {
      await mobile.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      const current = await log.evaluate((node) => `${node.scrollTop}:${node.scrollHeight}`);
      layoutStable = current === layout ? layoutStable + 1 : 0; layout = current;
      return layoutStable >= 10;
    }, "initial touch layout measured");
    const startRow = mobile.getByText(/^Touch row 20\./);
    await until(async () => {
      await startRow.evaluate((element) => {
        const row = element.closest<HTMLElement>("[data-chat-row]")!;
        const log = row.closest<HTMLElement>("[role=log]")!;
        log.scrollTop += row.getBoundingClientRect().top - log.getBoundingClientRect().top + 40;
      });
      await mobile.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      return startRow.evaluate((element) => Math.abs(element.closest("[data-chat-row]")!.getBoundingClientRect().top - element.closest("[role=log]")!.getBoundingClientRect().top + 40) <= 1);
    }, "control and filled swipe start at the same measured row");
    assert.equal(await mobile.locator(".chat-edge-loading.is-older").isVisible(), false, "unseen background history has no indicator");
    const initial = await log.evaluate((node) => ({ top: node.scrollTop, height: node.scrollHeight, rect: node.getBoundingClientRect().toJSON() }));
    const x = initial.rect.x + initial.rect.width / 2, y = initial.rect.y + initial.rect.height * 0.7;
    await native.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });

    if (fillDuringSwipe) {
      const anchor = await log.evaluate((node) => {
        const top = node.getBoundingClientRect().top;
        const row = [...node.querySelectorAll<HTMLElement>("[data-chat-row]")].find((row) => row.getBoundingClientRect().bottom > top);
        return { key: row?.dataset.chatRow, offset: (row?.getBoundingClientRect().top ?? top) - top };
      });
      const at = records.length;
      const response = mobile.waitForResponse((response) => new URL(response.url()).searchParams.get("before") === "touch-older");
      releaseFill();
      await until(() => records.slice(at).some((record) => record.before === "touch-older"), "page persisted during touch");
      await (await response).finished();
      await mobile.evaluate(async () => { for (let frame = 0; frame < 6; frame++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
      assert.equal(await log.evaluate((node) => node.scrollHeight), initial.height, "background pages stay out of the rendered list during touch");
      const after = await log.locator(`[data-chat-row='${anchor.key}']`).evaluate((row) => row.getBoundingClientRect().top - row.closest("[role=log]")!.getBoundingClientRect().top);
      assert(Math.abs(after - anchor.offset) <= 1, "loading and buffered pages preserve the touched row offset");
    }
    await native.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    // Capture the browser's own momentum endpoint before the app's bubble-phase idle merge.
    await log.evaluate((node) => {
      node.addEventListener("scrollend", () => {
        const top = node.getBoundingClientRect().top;
        const row = [...node.querySelectorAll<HTMLElement>("[data-chat-row]")].find((row) => row.getBoundingClientRect().bottom > top);
        (window as unknown as { swipeEnd: unknown }).swipeEnd = { text: row?.textContent ?? null, offset: (row?.getBoundingClientRect().top ?? top) - top, top: node.scrollTop };
      }, { once: true, capture: true });
    });
    await native.send("Input.synthesizeScrollGesture", { x, y, yDistance: -220, speed: 800, gestureSourceType: "touch", preventFling: false });
    if (fillDuringSwipe) {
      await mobile.locator(".chat-older").waitFor({ state: "detached" });
      await mobile.locator(".chat-edge-loading.is-older").waitFor({ state: "hidden" });
    }
    let previous = "", stable = 0;
    await until(async () => {
      await mobile.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      const top = await log.evaluate((node) => {
        const viewport = node.getBoundingClientRect();
        const row = [...node.querySelectorAll<HTMLElement>("[data-chat-row]")].find((row) => row.getBoundingClientRect().bottom > viewport.top);
        return `${node.scrollTop}:${node.scrollHeight}:${row?.dataset.chatRow}:${row?.getBoundingClientRect().top}`;
      });
      stable = top === previous ? stable + 1 : 0; previous = top;
      return stable >= 10;
    }, "touch momentum ended");
    swipeResults.push(await log.evaluate((node, start) => {
      const viewport = node.getBoundingClientRect();
      const row = [...node.querySelectorAll<HTMLElement>("[data-chat-row]")].find((row) => row.getBoundingClientRect().bottom > viewport.top);
      const end = (window as unknown as { swipeEnd: { top: number } }).swipeEnd;
      return { text: row?.textContent ?? null, offset: (row?.getBoundingClientRect().top ?? viewport.top) - viewport.top, nativeTravel: end.top - start };
    }, initial.top));
    const endpoint = await mobile.evaluate(() => (window as unknown as { swipeEnd: { text: string | null; offset: number } }).swipeEnd);
    const final = swipeResults.at(-1)!;
    assert.equal(final.text, endpoint.text, "idle merging keeps the native momentum endpoint row");
    assert(Math.abs(final.offset - endpoint.offset) <= 1, "idle merging and indicator disappearance keep the native momentum endpoint within 1px");
    releaseFill();
    await touch.close();
  }
  assert.equal(swipeResults[1]!.text, swipeResults[0]!.text, "background fill preserves the swipe's final visible row");
  // Native gesture synthesis has pixel rounding in its velocity integration across contexts.
  assert(Math.abs(swipeResults[1]!.nativeTravel - swipeResults[0]!.nativeTravel) <= 8, "background fill neither stalls nor overshoots the control swipe");
  assert(swipeResults.every((result) => Math.abs(result.nativeTravel) > 100), "neither swipe stalls");
  console.log("PASS touch and momentum preserve the native endpoint within 1px and match the control swipe");
  for (const { cache, rate, updates } of [{ cache: false, rate: 4, updates: true }, ...[1, 2, 4, 6, 8].map((rate) => ({ cache: true, rate, updates: rate === 8 }))]) {
    const streaming: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    await streaming.addInitScript((enabled) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", chatHistoryCache: enabled })), cache);
    const reading: Page = await streaming.newPage();
    const rendering = await streaming.newCDPSession(reading);
    await rendering.send("Emulation.setCPUThrottlingRate", { rate });
    const streamErrors: string[] = [];
    reading.on("pageerror", (error) => streamErrors.push(error.message));
    reading.on("console", (message) => { if (message.type() === "error" && message.text().includes("render failed")) streamErrors.push(message.text()); });
    const transcript: ConversationResponse = { source: "claude-transcript", history_id: `fictional-streaming-${cache}-${rate}`, cursor: null,
      turns: Array.from({ length: 20 }, (_, index) => [
        { role: "user" as const, ts: null, parts: [{ kind: "text" as const, text: `Streaming question ${index}` }] },
        { role: "assistant" as const, ts: null, parts: [{ kind: "text" as const, text: `Streaming answer ${index}. ` + "Fictional paragraph. ".repeat(30) }] },
      ]).flat() };
    if (cache) {
      transcript.cursor = "streaming-older";
      earlier.set("streaming-older", { ...transcript, cursor: null, turns: transcript.turns.map((turn) => ({ ...turn, parts: [{ kind: "text", text: "Older streaming content. ".repeat(30) }] })) });
    }
    let releasePrepend!: () => void;
    const prependHeld = new Promise<void>((resolve) => { releasePrepend = resolve; });
    if (cache) await reading.route("**/pane/conversation?*", async (route) => {
      if (new URL(route.request().url()).searchParams.get("before") === "streaming-older") await prependHeld;
      await route.continue();
    });
    bodies.set(first, transcript);
    await reading.goto(`http://cache.test:${server.port}/`);
    await reading.locator(".chat-turn-agent").first().waitFor();
    const log = reading.getByRole("log").first();
    await reading.evaluate(() => document.fonts.ready);
    await until(async () => {
      await log.evaluate((node) => { node.scrollTop = (node.scrollHeight - node.clientHeight) / 2; node.dispatchEvent(new Event("scroll")); });
      await reading.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      return reading.getByRole("button", { name: "Jump to latest", exact: true }).isVisible();
    }, "reader positioned above the settled initial list");
    const position = () => log.evaluate((node) => {
      const viewport = node.getBoundingClientRect();
      const row = [...node.querySelectorAll<HTMLElement>("[data-chat-row]")].find((element) => {
        const bounds = element.getBoundingClientRect(); return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
      });
      return { top: node.scrollTop, row: row?.dataset.chatRow, offset: row ? row.getBoundingClientRect().top - viewport.top : null };
    });
    await reading.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const settledPosition = async () => {
      let previous = await position(), stable = 0;
      await until(async () => {
        await reading.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
        const current = await position();
        stable = current.top === previous.top && current.row === previous.row && current.offset === previous.offset ? stable + 1 : 0;
        previous = current;
        return stable >= 3;
      }, "rendered reader position settled");
      return previous;
    };
    let anchor = await settledPosition();
    assert(anchor.row !== undefined && anchor.offset !== null);
    if (cache) {
      const olderAt = records.length;
      releasePrepend();
      await until(() => records.slice(olderAt).some((record) => record.before === "streaming-older"), "older streaming page loaded");
      await reading.locator(".chat-older").waitFor({ state: "detached" });
      await reading.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const prepended = await settledPosition();
      assert.equal(prepended.row, anchor.row, "background prepend keeps the reader's visible row");
      assert(prepended.offset !== null && Math.abs(prepended.offset - anchor.offset!) <= 1, "background prepend keeps visible row offset within 1px");
      anchor = prepended;
      await reading.unroute("**/pane/conversation?*");
      console.log(`PASS background prepend preserves the reading anchor within 1px at CPU rate ${rate}`);
    }
    for (const update of updates ? ["tail", "tool", "output", "shorter", "append"] : []) {
      // Concurrent tool output can revise an earlier assistant turn, forcing a full transport page.
      const turn = transcript.turns[update === "tail" ? 39 : 37]!;
      turn.parts = [...turn.parts, update === "tool"
        ? { kind: "tool", name: "Read", summary: "Synthetic streaming tool", input: "{}", output: "" }
        : { kind: "text", text: `Synthetic streamed ${update}` }];
      if (update === "shorter") turn.parts = [{ kind: "text", text: "Synthetic revised shorter turn" }];
      if (update === "append") transcript.turns.push({ role: "assistant", ts: null, parts: [{ kind: "text", text: "Synthetic newly appended turn" }] });
      transcript.activity = "working";
      const beforeUpdate = records.length;
      await until(() => records.slice(beforeUpdate).some((record) => record.pane === first), `streaming ${update} HTTP`);
      await reading.getByRole("button", { name: "New messages", exact: true }).waitFor();
      await reading.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const current = await position();
      assert.equal(await reading.getByText("The chat can't be shown. The terminal still works.", { exact: true }).count(), 0);
      assert.deepEqual(streamErrors, [], "streamed whole-turn replacement renders without errors");
      const renderedKeys = await log.locator("[data-chat-row]").evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.chatRow));
      assert.equal(new Set(renderedKeys).size, renderedKeys.length, "rendered row identities stay distinct");
      assert(Math.abs(current.top - anchor.top) <= 1, `cache=${cache} ${update}: scrollTop ${anchor.top} -> ${current.top}`);
      assert.equal(current.row, anchor.row, `cache=${cache} ${update}: first visible row stays mounted`);
      assert(current.offset !== null && Math.abs(current.offset - anchor.offset!) <= 1, `cache=${cache} ${update}: visible row offset stays put`);
    }
    if (updates) console.log(`PASS streaming updates retain scrollTop and visible row within 1px with cache ${cache ? "on" : "off"}`);
    await streaming.close();
  }
  bodies.delete(first);
  legacy = true;
  const compatible = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await compatible.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", chatHistoryCache: true })));
  const oldBridge = await compatible.newPage();
  await oldBridge.goto(`http://cache.test:${server.port}/`);
  await settings(oldBridge);
  await oldBridge.getByText("0.00 MB in 0 chats", { exact: true }).waitFor();
  await oldBridge.keyboard.press("Escape");
  held = true;
  await oldBridge.reload();
  await until(() => pending.length > 0, "legacy live response held");
  assert.equal(await oldBridge.locator(".chat-turn-agent").count(), 0);
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
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", chatHistoryCache: true }));
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
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", chatHistoryCache: true }));
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
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", chatHistoryCache: true }));
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

  const resilient = await browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { "x-fixture-client": "recovery" } });
  await resilient.addInitScript(() => {
    if (!localStorage.getItem("ovis:settings")) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", chatHistoryCache: true }));
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
  const recoveryPane = records.filter((record) => record.client === "recovery").at(-1)!.pane;
  async function reopen() {
    const at = records.length;
    const read = recovery.waitForRequest((request) => request.url().includes("/pane/conversation?") && !new URL(request.url()).searchParams.has("before"));
    await recovery.goto(`http://cache.test:${server!.port}/`);
    const query = new URL((await read).url()).searchParams;
    const matches = () => records.slice(at).find((record) => record.client === "recovery" && record.pane === query.get("pane_id") && record.cursor === query.get("delta") && record.before === null && record.incremental === query.has("incremental"));
    await until(() => matches() !== undefined, "this recovery tab's HTTP read");
    await recovery.waitForLoadState("networkidle");
    return matches()!;
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
    assert.equal(await recovery.locator(".chat-turn-agent").count(), 0, "failed identity validation exposes no saved rows");
    broken = null;
    const resumed = await reopen();
    await recovery.getByText(text, { exact: true }).waitFor();
    assert(resumed.bytes < 5000, "retry sends only the uncommitted tail");
    // Wait until the next reopen can use the new durable cursor before injecting another fault.
    await settings(recovery); await recovery.getByText(/MB in 1 chats/).waitFor(); await recovery.keyboard.press("Escape");
    durable = await reopen();
    console.log(`PASS ${fault} mid-delta hides unvalidated rows and resumes the missing tail`);
  }
  // Simulate a damaged persisted payload; successful recovery is observed only via UI and HTTP.
  await recovery.route("**/cache-corruption.html", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Cache corruption fixture</title>" }), { times: 1 });
  await recovery.goto(`http://cache.test:${server.port}/cache-corruption.html`); // Keep the origin, with no app that can repair the injected damage.
  await recovery.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("ovis:chat-history"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
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
  const resumedAfterClose = records.slice(afterClose).find((r) => r.client === "recovery" && r.pane === recoveryPane)!;
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
  await recovery.goto("about:blank"); // Close the app so a pending live read cannot repopulate evicted storage.
  await cdp.send("Storage.clearDataForOrigin", { origin: `http://cache.test:${server.port}`, storageTypes: "indexeddb" });
  const evicted = await reopen();
  assert.equal(evicted.delta, false);
  await recovery.getByText("Concurrent newest answer", { exact: true }).waitFor();
  console.log("PASS browser storage eviction refetches a complete valid chat");

  const pageBody = (text: string, cursor: string | null): ConversationResponse => ({ source: "claude-transcript", history_id: "fictional-paged-session", cursor, turns: [
    { role: "user", ts: null, parts: [{ kind: "text", text: "Fictional paged question" }] },
    { role: "assistant", ts: null, parts: [{ kind: "text", text: text + "\n\n" + "Fictional page content. ".repeat(150) }] },
  ] });
  bodies.set(recoveryPane, pageBody("Newest durable page", "older-2"));
  earlier.set("older-2", pageBody("Middle durable page", "older-1"));
  earlier.set("older-1", pageBody("Beginning durable page", null));
  brokenBefore = "older-1"; broken = "partial";
  await reopen();
  await recovery.getByText("Newest durable page", { exact: true }).waitFor();
  await recovery.getByText("Middle durable page", { exact: true }).waitFor();
  await recovery.getByRole("button", { name: "Couldn't load earlier messages — retry", exact: true }).waitFor();
  broken = null;
  const beforeResume = records.length;
  await reopen();
  await recovery.getByText("Middle durable page", { exact: true }).waitFor();
  await until(() => records.slice(beforeResume).some((r) => r.client === "recovery" && r.before === "older-1"), "automatic oldest page resume");
  assert(records.slice(beforeResume).filter((r) => r.client === "recovery" && r.before === "older-2").every((r) => r.delta && r.turns === 0), "completed older page only transfers its validation cursor");
  assert(records.slice(beforeResume).some((r) => r.client === "recovery" && r.before === "older-1"));
  await oldestTurn(recovery, "Beginning durable page");
  console.log("PASS whole-history background download resumes and oldest turn is reachable without Load older");
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
  // A whole transcript that exceeds the limit must not leave an orphan prefix.
  await settings(recovery);
  await recovery.getByLabel("Maximum chat cache (MB)", { exact: true }).fill("1");
  await recovery.getByLabel("Maximum chat cache (MB)", { exact: true }).press("Enter");
  await recovery.keyboard.press("Escape");
  const huge = (label: string, cursor: string | null) => ({ ...pageBody(label, cursor), turns: [
    { role: "assistant" as const, ts: null, parts: [{ kind: "text" as const, text: label + "\n\n" + "Fictional large history. ".repeat(22000) }] },
  ] });
  bodies.set(recoveryPane, huge("Oversized newest", "oversized-middle"));
  earlier.set("oversized-middle", huge("Oversized middle", "oversized-oldest"));
  earlier.set("oversized-oldest", huge("Oversized oldest", null));
  await reopen();
  await until(() => records.some((record) => record.before === "oversized-oldest"), "whole oversized transcript loaded");
  await settings(recovery);
  await recovery.getByText("0.00 MB in 0 chats", { exact: true }).waitFor();
  await recovery.getByText("Some chats exceed this limit and are not saved. Raise the limit and reopen them to cache their full history.", { exact: true }).waitFor();
  await recovery.keyboard.press("Escape");
  held = true;
  await recovery.reload();
  await until(() => pending.length > 0, "oversized reopen HTTP held");
  assert.equal(await recovery.locator(".chat-turn-agent").count(), 0, "oversized chat leaves no silently cached partial history");
  release();
  await until(() => records.filter((record) => record.before === "oversized-oldest").length >= 2, "oversized whole reload");
  await settings(recovery);
  await recovery.getByText("0.00 MB in 0 chats", { exact: true }).waitFor();
  console.log("PASS oversized transcripts are evicted whole and never recreated as a partial prefix");
  if (process.env.UI_EVIDENCE_DIR) {
    await recovery.locator('[data-section="history-cache"]').evaluate((node) => node.scrollIntoView({ block: "start" }));
    await recovery.screenshot({ path: join(process.env.UI_EVIDENCE_DIR!, "oversized-desktop.png"), animations: "disabled" });
    await recovery.setViewportSize({ width: 390, height: 844 });
    await recovery.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await recovery.locator('[data-section="history-cache"]').evaluate((node) => node.scrollIntoView({ block: "start" }));
    await recovery.screenshot({ path: join(process.env.UI_EVIDENCE_DIR!, "oversized-phone.png"), animations: "disabled" });
  }
  if (evidence) await recovery.setViewportSize({ width: 1280, height: 900 });
  assert.deepEqual(recovery.viewportSize(), { width: 1280, height: 900 }, "oversized evidence preserves the desktop viewport");
  await recovery.getByLabel("Maximum chat cache (MB)", { exact: true }).fill("10");
  await recovery.getByLabel("Maximum chat cache (MB)", { exact: true }).press("Enter");
  await recovery.keyboard.press("Escape");
  const beforeRaise = records.filter((record) => record.before === "oversized-oldest").length;
  await reopen();
  await until(() => records.filter((record) => record.before === "oversized-oldest").length > beforeRaise, "raised limit fills full history");
  await oldestTurn(recovery, "Oversized oldest");
  await settings(recovery);
  await recovery.getByText(/MB in 1 chats/).waitFor();
  console.log("PASS raising the limit and reopening caches the whole transcript and shows its oldest turn");
  await resilient.close();
} finally { release(); await browser?.close(); server?.stop(true); rmSync(app, { recursive: true, force: true }); }
