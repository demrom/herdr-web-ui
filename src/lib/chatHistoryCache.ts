import { fnv1a } from "./checksum.ts";
import type { ConversationResponse } from "../../shared/protocol.ts";

/** Parsed pages only: never credentials, draft input, images or expanded tool output. */
export interface HistoryPage {
  chat: string;
  url: string;
  session: string;
  body: ConversationResponse;
  etag: string | null;
  bytes: number;
  integrity: string;
  clientIdentity?: string;
}
type PageData = Omit<HistoryPage, "bytes" | "integrity" | "session">;
const encoded = (page: PageData): Uint8Array => new TextEncoder().encode(JSON.stringify({ chat: page.chat, url: page.url, body: page.body, etag: page.etag, clientIdentity: page.clientIdentity }));
const integrity = fnv1a;
async function valid(page: HistoryPage, chat: string): Promise<boolean> {
  if (!page || page.chat !== chat || typeof page.url !== "string" || typeof page.session !== "string" || page.session !== page.body?.cache_session || !page.body || !Array.isArray(page.body.turns)
    || typeof page.body.source !== "string" || page.body.source === "scrollback"
    || !page.body.turns.every((turn) => turn && (turn.role === "user" || turn.role === "assistant") && Array.isArray(turn.parts))
    || !(page.etag === null || typeof page.etag === "string") || typeof page.integrity !== "string") return false;
  const bytes = encoded(page);
  return page.bytes === bytes.byteLength && page.integrity === await integrity(bytes);
}
interface ChatEntry { chat: string; session: string; opened: number; bytes: number; revision: number; historyId?: string; oversizedLimit?: number }
interface CacheState { epoch: number; limit: number }
export const HISTORY_CACHE_EVENT = "ovis:history-cache";
let opened: Promise<IDBDatabase> | undefined;
let channel: BroadcastChannel | undefined;
let generation = 0;

function changed(cleared = false): void {
  if (cleared) generation += 1;
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(HISTORY_CACHE_EVENT, { detail: { cleared } }));
}
function announce(cleared = false): void {
  changed(cleared);
  channel?.postMessage({ cleared });
}
function database(): Promise<IDBDatabase> {
  return opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("ovis:chat-history", 2);
    let expired = false;
    const timer = setTimeout(() => { expired = true; reject(new Error("Chat cache unavailable")); }, 3000);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of ["pages", "chats", "state"]) if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
      db.createObjectStore("pages", { keyPath: ["chat", "session", "url"] }).createIndex("chat", "chat");
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
    if (chat.bytes <= limit) continue;
    await removeChat(tx, chat.chat);
    // Remember the oversized history so subsequent background pages cannot recreate a fragment.
    tx.objectStore("chats").put({ ...chat, bytes: 0, revision: chat.revision + 1, oversizedLimit: limit });
    bytes -= chat.bytes;
  }
  for (const chat of chats) {
    if (bytes <= limit) break;
    if (chat.bytes === 0 || chat.bytes > limit) continue;
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
    const saved = await transaction("readonly", async (tx) => {
      const entry = await result<ChatEntry | undefined>(tx.objectStore("chats").get(chat));
      return { page: entry ? await result<HistoryPage | undefined>(tx.objectStore("pages").get([chat, entry.session, url])) : undefined,
        epoch: (await state(tx)).epoch, revision: entry?.revision ?? 0 };
    });
    if (saved.page && !await valid(saved.page, chat)) {
      await discardInvalid(saved.page, chat, saved.epoch);
      return { page: undefined, epoch: saved.epoch, revision: 0 };
    }
    return saved;
  } catch { return null; }
}

async function discardInvalid(page: HistoryPage, chat: string, epoch: number): Promise<void> {
  await transaction("readwrite", async (tx) => {
    const held: HistoryPage | undefined = await result(tx.objectStore("pages").get([chat, page.session, page.url]));
    // A concurrent successful writer may already have replaced the damaged snapshot.
    if ((await state(tx)).epoch === epoch && held?.integrity === page.integrity) await removeChat(tx, chat);
  });
  announce();
}

/** Discard only the session that this reader validated, preserving a concurrent replacement. */
export async function discardHistoryChat(chat: string, session: string, epoch: number): Promise<void> {
  try {
    await transaction("readwrite", async (tx) => {
      const entry = await result<ChatEntry | undefined>(tx.objectStore("chats").get(chat));
      if ((await state(tx)).epoch === epoch && entry?.session === session) await removeChat(tx, chat);
    });
    announce();
  } catch { /* Storage is optional. */ }
}

/** The epoch prevents pre-clear writes. False requests fresh server validation after a concurrent write; optional storage failures never request a retry. */
export async function saveHistoryPage(page: PageData, epoch: number, reset: boolean, revision: number, latestUrl?: string): Promise<boolean> {
  if (!page.body.cache_session) return true;
  const begun = generation;
  try {
    // Serialize before opening the atomic storage transaction.
    const make = async (data: PageData): Promise<HistoryPage> => {
      const bytes = encoded(data);
      return { ...data, session: data.body.cache_session!, bytes: bytes.byteLength, integrity: await integrity(bytes) };
    };
    const entries = [await make(latestUrl ? { ...page, url: latestUrl, etag: null } : page)];
    const committed = await transaction("readwrite", async (tx) => {
      const current = await state(tx);
      if (current.epoch !== epoch || generation !== begun) return true;
      const chats = tx.objectStore("chats");
      let chat: ChatEntry | undefined = await result(chats.get(page.chat));
      const pages = tx.objectStore("pages");
      if ((chat?.revision ?? 0) !== revision) return false; // Revalidate before retrying a concurrent write.
      if (chat?.oversizedLimit === current.limit && chat.session === page.body.cache_session && chat.historyId === page.body.history_id) return true;
      const older = new URL(page.url, location.href).searchParams.has("before");
      // An LRU-evicted chat must start with its newest page, never an orphan older page.
      if (older && (!chat || chat.session !== page.body.cache_session || chat.oversizedLimit !== undefined || (chat.historyId !== undefined && chat.historyId !== page.body.history_id))) return true;
      if (reset || (chat && chat.session !== page.body.cache_session) || chat?.oversizedLimit !== undefined || (chat?.historyId !== undefined && chat.historyId !== page.body.history_id)) {
        await removeChat(tx, page.chat); chat = undefined;
      }
      let bytes = chat?.bytes ?? 0;
      // Held-start URLs are request bounds, not additional history. Keep only the canonical tail.
      const held = await result<HistoryPage[]>(pages.index("chat").getAll(page.chat));
      for (const previous of held) if (new URL(previous.url, location.href).searchParams.has("from")) {
        pages.delete([page.chat, previous.session, previous.url]); bytes -= previous.bytes;
      }
      for (const entry of entries) {
        const previous: HistoryPage | undefined = await result(pages.get([page.chat, entry.session, entry.url]));
        bytes += entry.bytes - (previous?.bytes ?? 0);
        pages.put(entry);
      }
      // A missing gap is still being downloaded: retain its saved chain until it reconnects.
      // Once complete, only pages reachable from the canonical tail count toward the limit.
      const stored = new Map(held.filter((entry) => !new URL(entry.url, location.href).searchParams.has("from")).map((entry) => [entry.url, entry]));
      for (const entry of entries) stored.set(entry.url, entry);
      let root: HistoryPage | undefined;
      const predecessors = new Map<string, HistoryPage>();
      for (const entry of stored.values()) {
        const query = new URL(entry.url, location.href).searchParams;
        const before = query.get("before");
        if (before !== null) { if (!predecessors.has(before)) predecessors.set(before, entry); }
        else if (!query.has("since")) root = entry;
      }
      const reachable = new Set(root ? [root.url] : []);
      let boundary = root?.body.cursor;
      while (typeof boundary === "string") {
        const previous = predecessors.get(boundary);
        if (!previous || reachable.has(previous.url)) break;
        reachable.add(previous.url); boundary = previous.body.cursor;
      }
      if (boundary === null) for (const previous of stored.values()) if (!reachable.has(previous.url)) {
        pages.delete([page.chat, previous.session, previous.url]); bytes -= previous.bytes;
      }
      chats.put({ chat: page.chat, session: page.body.cache_session, opened: chat?.opened ?? Date.now(), bytes, revision: revision + 1, historyId: page.body.history_id });
      await evict(tx, current.limit);
      return true;
    });
    announce();
    return committed;
  } catch { return true; /* A denied/quota-limited cache never holds up the live conversation. */ }
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
export async function historyCacheUsage(): Promise<{ bytes: number; chats: number; oversized: number } | { unavailable: "missing" | "denied" | "failed" }> {
  try {
    return await transaction("readonly", async (tx) => {
      const chats = await result<ChatEntry[]>(tx.objectStore("chats").getAll());
      return { bytes: chats.reduce((sum, chat) => sum + chat.bytes, 0), chats: chats.filter((chat) => chat.bytes > 0).length, oversized: chats.filter((chat) => chat.oversizedLimit !== undefined).length };
    });
  } catch (error) {
    return { unavailable: error instanceof DOMException && error.name === "SecurityError" ? "denied"
      : error instanceof ReferenceError || error instanceof TypeError ? "missing" : "failed" };
  }
}
