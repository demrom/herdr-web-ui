import { describe, expect, it } from "bun:test";
import {
  addToStash,
  MAX_STASHED_DRAFTS,
  parseStash,
  PromptStashStore,
  stashKey,
  stashSnippet,
  storageEventStash,
  type StashedDraft,
} from "./promptStash.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    refuse: false,
    getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) { if (this.refuse) throw new Error("quota"); values.set(key, value); },
    removeItem(key: string) { if (this.refuse) throw new Error("quota"); values.delete(key); },
  };
}

const draft = (id: string, savedAt: number, text = `draft ${id}`): StashedDraft => ({ id, savedAt, text });

describe("parseStash", () => {
  it("keeps valid entries newest first and drops malformed ones", () => {
    const raw = JSON.stringify([
      draft("a", 1), draft("b", 3), { id: "c", savedAt: "x", text: "t" }, { id: "d", savedAt: 2, text: "   " },
      null, draft("b", 4, "duplicate id"), draft("e", 2),
    ]);
    expect(parseStash(raw).map((entry) => entry.id)).toEqual(["b", "e", "a"]);
  });
  it("reads garbage as an empty list", () => {
    expect(parseStash(null)).toEqual([]);
    expect(parseStash("{")).toEqual([]);
    expect(parseStash('{"a":1}')).toEqual([]);
  });
});

describe("addToStash", () => {
  it("puts the new draft on top and moves a repeated text up instead of doubling it", () => {
    const { entries } = addToStash([draft("a", 2, "same"), draft("b", 1)], draft("c", 3, "same"));
    expect(entries.map((entry) => entry.id)).toEqual(["c", "b"]);
  });
  it("drops the oldest past the cap and returns it", () => {
    const full = Array.from({ length: MAX_STASHED_DRAFTS }, (_, index) => draft(`d${index}`, MAX_STASHED_DRAFTS - index));
    const { entries, evicted } = addToStash(full, draft("new", 100));
    expect(entries).toHaveLength(MAX_STASHED_DRAFTS);
    expect(entries[0]!.id).toBe("new");
    expect(evicted?.id).toBe(`d${MAX_STASHED_DRAFTS - 1}`);
  });
});

describe("PromptStashStore", () => {
  it("keeps one list per pane storage id", () => {
    const storage = memoryStorage();
    const store = new PromptStashStore(() => storage);
    expect(store.save("local:%1", "first", 1).saved).toBe(true);
    expect(store.save("remote:%1", "elsewhere", 2).saved).toBe(true);
    expect(store.read("local:%1").map((entry) => entry.text)).toEqual(["first"]);
    expect(parseStash(storage.values.get(stashKey("remote:%1")) ?? null).map((entry) => entry.text)).toEqual(["elsewhere"]);
  });
  it("never saves a blank draft", () => {
    const store = new PromptStashStore(() => memoryStorage());
    expect(store.save("p", "  \n ").saved).toBe(false);
    expect(store.read("p")).toEqual([]);
  });
  it("reports a refused write and changes nothing", () => {
    const storage = memoryStorage();
    const store = new PromptStashStore(() => storage);
    store.save("p", "kept", 1);
    storage.refuse = true;
    expect(store.save("p", "lost?", 2)).toEqual({ saved: false, evicted: null });
    expect(store.read("p").map((entry) => entry.text)).toEqual(["kept"]);
  });
  it("takes a draft out for the box and removes deleted ones", () => {
    const storage = memoryStorage();
    const store = new PromptStashStore(() => storage);
    store.save("p", "one", 1);
    store.save("p", "two", 2);
    const [two, one] = store.read("p");
    expect(store.take("p", two!.id)?.text).toBe("two");
    expect(store.take("p", two!.id)).toBeNull();
    expect(store.remove("p", one!.id)).toBe(true);
    expect(store.read("p")).toEqual([]);
    expect(storage.values.has(stashKey("p"))).toBe(false);
  });
  it("hands a stable list to subscribers until it changes, and rereads after another tab's write", () => {
    const storage = memoryStorage();
    const store = new PromptStashStore(() => storage);
    let calls = 0;
    store.subscribe(() => { calls += 1; });
    const before = store.read("p");
    expect(store.read("p")).toBe(before);
    store.save("p", "x", 1);
    expect(calls).toBe(1);
    storage.values.set(stashKey("p"), JSON.stringify([draft("z", 5, "from another tab")]));
    store.refresh("p");
    expect(store.read("p").map((entry) => entry.text)).toEqual(["from another tab"]);
  });
});

describe("helpers", () => {
  it("folds a draft into one cut line", () => {
    expect(stashSnippet("  a\n\n b  ")).toBe("a b");
    expect(stashSnippet("x".repeat(10), 4)).toBe("xxxx…");
  });
  it("names the pane a storage event concerns", () => {
    expect(storageEventStash(stashKey("local:%3"))).toBe("local:%3");
    expect(storageEventStash("herdr-web-ui:composer-draft:%3")).toBeNull();
    expect(storageEventStash(null)).toBeNull();
  });
});
