/**
 * Saved drafts (the prompt stash): messages put aside from a pane's composer to come back to.
 * They are this browser's alone, one list per pane under `paneStorageId(machineId, paneId)`,
 * and they hold text only: an attachment survives as the @path its upload already put in the
 * draft. Nothing here sends: a restore only fills the box.
 */
type StashStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface StashedDraft { id: string; savedAt: number; text: string }

export const MAX_STASHED_DRAFTS = 20;
const STASH_PREFIX = "herdr-web-ui:prompt-stash:";

/** The storage key of one pane's saved drafts; `storageId` is `paneStorageId(machineId, paneId)`. */
export function stashKey(storageId: string): string {
  return STASH_PREFIX + storageId;
}

/** The pane a `storage` event from another tab concerns, as its storage id, or null. */
export function storageEventStash(key: string | null): string | null {
  return key !== null && key.startsWith(STASH_PREFIX) ? key.slice(STASH_PREFIX.length) : null;
}

/** A stored list read back: anything malformed is dropped, newest first, at most the cap. */
export function parseStash(raw: string | null): StashedDraft[] {
  if (raw === null || raw === "") return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const entries: StashedDraft[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const { id, savedAt, text } = item as Partial<StashedDraft>;
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) continue;
    if (typeof text !== "string" || text.trim() === "") continue;
    seen.add(id);
    entries.push({ id, savedAt, text });
  }
  return entries.sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_STASHED_DRAFTS);
}

/**
 * The list with `draft` on top. The same text saved again moves up instead of standing twice;
 * past the cap the oldest one goes, and is returned so the user can be told.
 */
export function addToStash(entries: readonly StashedDraft[], draft: StashedDraft): { entries: StashedDraft[]; evicted: StashedDraft | null } {
  const next = [draft, ...entries.filter((entry) => entry.text !== draft.text && entry.id !== draft.id)];
  const evicted = next.length > MAX_STASHED_DRAFTS ? next.pop() ?? null : null;
  return { entries: next, evicted };
}

export function removeFromStash(entries: readonly StashedDraft[], id: string): StashedDraft[] {
  return entries.filter((entry) => entry.id !== id);
}

/** One line for the list: whitespace folded, cut with an ellipsis past `max` characters. */
export function stashSnippet(text: string, max = 90): string {
  const line = text.trim().replace(/\s+/g, " ");
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function newId(now: number): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class PromptStashStore {
  /** the list last read or written per pane: one array per change, as useSyncExternalStore needs */
  private lists = new Map<string, readonly StashedDraft[]>();
  private listeners = new Set<() => void>();
  constructor(private storage: () => StashStorage = () => window.localStorage) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify(): void { for (const listener of this.listeners) listener(); }
  read(storageId: string): readonly StashedDraft[] {
    let list = this.lists.get(storageId);
    if (!list) {
      let raw: string | null = null;
      try { raw = this.storage().getItem(stashKey(storageId)); } catch { /* blocked storage: an empty list */ }
      list = parseStash(raw);
      this.lists.set(storageId, list);
    }
    return list;
  }
  /** false when the list could not be stored: the caller keeps the box as it was */
  private write(storageId: string, entries: readonly StashedDraft[]): boolean {
    try {
      if (entries.length === 0) this.storage().removeItem(stashKey(storageId));
      else this.storage().setItem(stashKey(storageId), JSON.stringify(entries));
    } catch {
      return false;
    }
    this.lists.set(storageId, entries);
    this.notify();
    return true;
  }
  /**
   * Saves `text` on top of the pane's list. `saved` is false when storage refused it (blocked,
   * full): nothing changed then, so the box must keep the text.
   */
  save(storageId: string, text: string, now = Date.now()): { saved: boolean; evicted: StashedDraft | null } {
    if (text.trim() === "") return { saved: false, evicted: null };
    const { entries, evicted } = addToStash(this.read(storageId), { id: newId(now), savedAt: now, text });
    return this.write(storageId, entries) ? { saved: true, evicted } : { saved: false, evicted: null };
  }
  /** Takes one draft out of the list for the box, or null when it is gone (another tab took it). */
  take(storageId: string, id: string): StashedDraft | null {
    const list = this.read(storageId);
    const entry = list.find((candidate) => candidate.id === id) ?? null;
    if (entry === null) return null;
    // a refused write still hands the text over: it stays stored, never lost
    if (!this.write(storageId, removeFromStash(list, id))) {
      this.lists.set(storageId, removeFromStash(list, id));
      this.notify();
    }
    return entry;
  }
  remove(storageId: string, id: string): boolean {
    const list = this.read(storageId);
    if (!list.some((entry) => entry.id === id)) return true;
    return this.write(storageId, removeFromStash(list, id));
  }
  /** Reads the pane's list again (another tab changed it). */
  refresh(storageId: string): void {
    this.lists.delete(storageId);
    this.read(storageId);
    this.notify();
  }
}

export const promptStash = new PromptStashStore();
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  const storageId = storageEventStash(event.key);
  if (storageId !== null) promptStash.refresh(storageId);
});
