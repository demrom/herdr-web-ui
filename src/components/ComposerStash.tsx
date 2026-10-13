import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { Bookmark, BookmarkPlus, X } from "lucide-react";

import "./ComposerStash.css";

import { MAX_STASHED_DRAFTS, promptStash, stashSnippet, type StashedDraft } from "../lib/promptStash.ts";
import { useT } from "../lib/i18n.ts";

/**
 * Saved drafts, in the composer's controls group beside Attach: it saves the box
 * and fills it again, and never sends anything. Restoring over a draft saves that draft first,
 * so no text is ever lost to a restore.
 */
export function ComposerStash({ storageId, text, busy, onReplace, onNote }: {
  /** `paneStorageId(machineId, paneId)` */
  storageId: string;
  text: string;
  /** a send or an upload is on its way: the box must not change under it */
  busy: boolean;
  /** puts `next` in the box (empty after a save) */
  onReplace: (next: string) => void;
  onNote: (note: string) => void;
}) {
  const t = useT();
  const entries = useSyncExternalStore(promptStash.subscribe, () => promptStash.read(storageId));
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const canSave = !busy && text.trim() !== "";

  const focusMenu = () => rootRef.current?.querySelector<HTMLButtonElement>(".composer-stash-menu button:not(:disabled)")?.focus();

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (rootRef.current && !event.composedPath().includes(rootRef.current)) setOpen(false);
    };
    // Escape closes from anywhere while open (a deleted row takes the focus with it), and is
    // taken before the box's own Escape, which stops a working agent
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape, true);
    focusMenu();
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", escape, true);
    };
  }, [open, close]);

  const tooFull = (): string => t("Up to {max} drafts are kept: the oldest one was removed.", { max: MAX_STASHED_DRAFTS });
  const refused = (): string => t("The draft could not be saved: this browser's storage is unavailable.");

  const save = () => {
    if (!canSave) return;
    const result = promptStash.save(storageId, text);
    if (!result.saved) { onNote(refused()); return; }
    onReplace("");
    if (result.evicted) onNote(tooFull());
    close(false);
  };

  const restore = (entry: StashedDraft) => {
    if (busy) return;
    // the box's own draft takes the restored one's place in the list, never lost
    if (text.trim() !== "") {
      const kept = promptStash.save(storageId, text);
      if (!kept.saved) { onNote(refused()); return; }
      if (kept.evicted?.id === entry.id) { onReplace(entry.text); close(false); return; }
      if (kept.evicted) onNote(tooFull());
    }
    const taken = promptStash.take(storageId, entry.id);
    if (taken) onReplace(taken.text);
    close(false);
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    if (items.length === 0) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  };

  const label = entries.length > 0 ? t("Saved drafts: {count}", { count: entries.length }) : t("Saved drafts");
  return (
    <div ref={rootRef} className="composer-stash">
      <button
        ref={triggerRef}
        type="button"
        className={`icon-button composer-stash-trigger${entries.length > 0 ? " has-count" : ""}`}
        aria-label={label}
        title={label}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <Bookmark aria-hidden="true" />
        {entries.length > 0 && <span className="composer-stash-count" aria-hidden="true">{entries.length}</span>}
      </button>
      {open && (
        <div id={menuId} className="menu composer-stash-menu" role="group" aria-label={t("Saved drafts")} onKeyDown={onMenuKey}>
          <button type="button" className="menu-item composer-stash-save" disabled={!canSave} onClick={save}>
            <BookmarkPlus aria-hidden="true" />
            <span className="menu-item-main">{t("Save draft")}</span>
            <span className="menu-item-hint">{t("Clears the box")}</span>
          </button>
          {entries.length === 0 ? (
            <p className="composer-stash-empty">{t("No saved drafts yet. Save one to clear the box and come back to it later.")}</p>
          ) : (
            <>
              <div className="menu-heading">{t("Saved drafts")}</div>
              <ul className="composer-stash-list">
                {entries.map((entry) => {
                  const snippet = stashSnippet(entry.text);
                  return (
                    <li key={entry.id} className="composer-stash-row">
                      <button
                        type="button"
                        className="menu-item composer-stash-restore"
                        title={entry.text.slice(0, 500)}
                        aria-label={t("Restore saved draft: {draft}", { draft: snippet })}
                        disabled={busy}
                        onClick={() => restore(entry)}
                      >
                        <span className="menu-item-main">{snippet}</span>
                      </button>
                      <button
                        type="button"
                        className="icon-button composer-stash-delete"
                        aria-label={t("Delete saved draft: {draft}", { draft: snippet })}
                        title={t("Delete saved draft")}
                        onClick={() => {
                          if (!promptStash.remove(storageId, entry.id)) onNote(refused());
                          requestAnimationFrame(focusMenu);
                        }}
                      >
                        <X aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
