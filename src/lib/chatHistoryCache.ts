import { fnv1a } from "./checksum.ts";
import type { ConversationResponse } from "../../shared/protocol.ts";

/** Parsed pages only: never credentials, draft input, images or expanded tool output. */
export interface HistoryPage {
  chat: string;
  url: string;
  body: ConversationResponse;
  etag: string | null;
  bytes: number;
  integrity: string;
}
type PageData = Omit<HistoryPage, "bytes" | "integrity">;
const encoded = (page: PageData): Uint8Array => new TextEncoder().encode(JSON.stringify({ chat: page.chat, url: page.url, body: page.body, etag: page.etag }));
const integrity = fnv1a;
async function valid(page: HistoryPage, chat: string): Promise<boolean> {
  if (!page || page.chat !== chat || typeof page.url !== "string" || !page.body || !Array.isArray(page.body.turns)
    || typeof page.body.source !== "string" || page.body.source === "scrollback"
    || !page.body.turns.every((turn) => turn && (turn.role === "user" || turn.role === "assistant") && Array.isArray(turn.parts))
    || !(page.etag === null || typeof page.etag === "string") || typeof page.integrity !== "string") return false;
  const bytes = encoded(page);
  return page.bytes === bytes.byteLength && page.integrity === await integrity(bytes);
}
interface ChatEntry { chat: string; opened: number; bytes: number; revision: number }
interface CacheState { epoch: number; limit: number }
export const HISTORY_CACHE_EVENT = "herdr-web-ui:history-cache";
let opened: Promise<IDBDatabase> | undefined;
let channel: BroadcastChannel | undefined;
let generation = 0;

function changed(cleared = false): void {
  if (cleared) generation += 1;
  window.dispatchEvent(new CustomEvent(HISTORY_CACHE_EVENT, { detail: { cleared } }));
}
function announce(cleared = false): void {
  changed(cleared);
  channel?.postMessage({ cleared });
}
function database(): Promise<IDBDatabase> {
  return opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("herdr-web-ui:chat-history", 1);
    let expired = false;
    const timer = setTimeout(() => { expired = true; reject(new Error("Chat cache unavailable")); }, 3000);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("pages", { keyPath: ["chat", "url"] }).createIndex("chat", "chat");
      db.createObjectStore("chats", { keyPath: "chat" }).createIndex("opened", "opened");
      db.createObjectStore("state");
    };
    request.onerror = request.onblocked = () => { clearTimeout(timer); reject(new Error("Chat cache unavailable")); };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (expired) { request.result.close(); return; }
      request.result.onversionchange = () => { request.result.close(); opened = undefined; };
      if (typeof BroadcastChannel !== "undefined") {
        channel ??= new BroadcastChannel(HISTORY_CACHE_EVENT);
        channel.onmessage = (event: MessageEvent<{ cleared: boolean }>) => changed(event.data.cleared);
      }
      resolve(request.result);
    };
  }).catch((error) => { opened = undefined; throw error; });
}
const result = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function transaction<T>(mode: IDBTransactionMode, run: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const tx = (await database()).transaction(["pages", "chats", "state"], mode);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("Chat cache transaction failed"));
  });
  try { const value = await run(tx); await done; return value; }
  catch (error) { try { tx.abort(); } catch {} await done.catch(() => {}); throw error; }
}
async function state(tx: IDBTransaction): Promise<CacheState> {
  return await result(tx.objectStore("state").get("state")) ?? { epoch: 0, limit: 500_000_000 };
}
async function removeChat(tx: IDBTransaction, chat: string): Promise<void> {
  const keys = await result(tx.objectStore("pages").index("chat").getAllKeys(chat));
  for (const key of keys) tx.objectStore("pages").delete(key);
  tx.objectStore("chats").delete(chat);
}
async function evict(tx: IDBTransaction, limit: number): Promise<void> {
  const chats = await result<ChatEntry[]>(tx.objectStore("chats").index("opened").getAll());
  let bytes = chats.reduce((sum, chat) => sum + chat.bytes, 0);
  for (const chat of chats) {
    if (bytes <= limit) break;
    await removeChat(tx, chat.chat);
    bytes -= chat.bytes;
  }
}

/** A mounted pane can become active again without restoring its already visible rows. */
export async function touchHistoryChat(chat: string): Promise<void> {
  try {
    await transaction("readwrite", async (tx) => {
      const chats = tx.objectStore("chats");
      const entry: ChatEntry | undefined = await result(chats.get(chat));
      if (entry) chats.put({ ...entry, opened: Date.now() });
    });
  } catch { /* Storage is optional. */ }
}

export async function readHistoryChat(chat: string): Promise<{ pages: HistoryPage[]; epoch: number } | null> {
  try {
    const saved = await transaction("readwrite", async (tx) => {
      const pages = await result<HistoryPage[]>(tx.objectStore("pages").index("chat").getAll(chat));
      const entry: ChatEntry | undefined = await result(tx.objectStore("chats").get(chat));
      if (entry) tx.objectStore("chats").put({ ...entry, opened: Date.now() });
      return { pages, epoch: (await state(tx)).epoch };
    });
    for (const page of saved.pages) {
      if (!await valid(page, chat)) {
        await discardInvalid(page, chat, saved.epoch);
        return { pages: [], epoch: saved.epoch };
      }
    }
    return saved;
  } catch { return null; }
}

export async function readHistoryPage(chat: string, url: string): Promise<{ page: HistoryPage | undefined; epoch: number; revision: number } | null> {
  try {
    const saved = await transaction("readonly", async (tx) => ({
      page: await result(tx.objectStore("pages").get([chat, url])), epoch: (await state(tx)).epoch,
      revision: (await result<ChatEntry | undefined>(tx.objectStore("chats").get(chat)))?.revision ?? 0,
    }));
    if (saved.page && !await valid(saved.page, chat)) {
      await discardInvalid(saved.page, chat, saved.epoch);
      return { page: undefined, epoch: saved.epoch, revision: 0 };
    }
    return saved;
  } catch { return null; }
}

async function discardInvalid(page: HistoryPage, chat: string, epoch: number): Promise<void> {
  await transaction("readwrite", async (tx) => {
    const held: HistoryPage | undefined = await result(tx.objectStore("pages").get([chat, page.url]));
    // A concurrent successful writer may already have replaced the damaged snapshot.
    if ((await state(tx)).epoch === epoch && held?.integrity === page.integrity) await removeChat(tx, chat);
  });
  announce();
}

/** The epoch prevents a pre-clear/auth-change response from repopulating the device cache. */
export async function saveHistoryPage(page: PageData, epoch: number, reset: boolean, revision: number, latestUrl?: string): Promise<void> {
  const begun = generation;
  try {
    // Serialize before opening the atomic storage transaction.
    const make = async (data: PageData): Promise<HistoryPage> => {
      const bytes = encoded(data);
      return { ...data, bytes: bytes.byteLength, integrity: await integrity(bytes) };
    };
    const entries = [await make(page)];
    if (latestUrl && latestUrl !== page.url) entries.push(await make({ ...page, url: latestUrl, etag: null }));
    await transaction("readwrite", async (tx) => {
      const current = await state(tx);
      if (current.epoch !== epoch || generation !== begun) return;
      const chats = tx.objectStore("chats");
      let chat: ChatEntry | undefined = await result(chats.get(page.chat));
      const pages = tx.objectStore("pages");
      if ((chat?.revision ?? 0) !== revision) return; // Another tab committed any page of this chat.
      if (reset) { await removeChat(tx, page.chat); chat = undefined; }
      let bytes = chat?.bytes ?? 0;
      for (const entry of entries) {
        const previous: HistoryPage | undefined = await result(pages.get([page.chat, entry.url]));
        bytes += entry.bytes - (previous?.bytes ?? 0);
        pages.put(entry);
      }
      chats.put({ chat: page.chat, opened: chat?.opened ?? Date.now(), bytes, revision: revision + 1 });
      await evict(tx, current.limit);
    });
    announce();
  } catch { /* A denied/quota-limited cache never holds up the live conversation. */ }
}

export async function clearHistoryCache(): Promise<void> {
  // Invalidate local readers immediately, before the queued IndexedDB clear finishes.
  announce(true);
  try {
    await transaction("readwrite", async (tx) => {
      const current = await state(tx);
      tx.objectStore("state").put({ ...current, epoch: current.epoch + 1 }, "state");
      tx.objectStore("pages").clear();
      tx.objectStore("chats").clear();
    });
    announce(true);
  } catch { /* Storage can be blocked; live reads remain usable. */ }
}

export async function setHistoryCacheLimit(bytes: number): Promise<void> {
  try {
    await transaction("readwrite", async (tx) => {
      tx.objectStore("state").put({ ...await state(tx), limit: bytes }, "state");
      await evict(tx, bytes);
    });
    announce();
  } catch { /* No persistent cache where IndexedDB is unavailable. */ }
}
export async function historyCacheUsage(): Promise<{ bytes: number; chats: number } | { unavailable: "missing" | "denied" | "failed" }> {
  try {
    return await transaction("readonly", async (tx) => {
      const chats = await result<ChatEntry[]>(tx.objectStore("chats").getAll());
      return { bytes: chats.reduce((sum, chat) => sum + chat.bytes, 0), chats: chats.length };
    });
  } catch (error) {
    return { unavailable: error instanceof DOMException && error.name === "SecurityError" ? "denied"
      : error instanceof ReferenceError || error instanceof TypeError ? "missing" : "failed" };
  }
}
