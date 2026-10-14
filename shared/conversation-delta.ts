import type { ConversationResponse } from "./protocol.ts";

async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Stateless page validation, including the overlap when the bounded newest page slides. */
export async function conversationDelta(body: ConversationResponse, cursor: string | null): Promise<ConversationResponse> {
  if (body.source === "scrollback" || body.history_id === undefined) return body;
  const scope = await digest([body.source, body.history_id]);
  const revisions = await Promise.all(body.turns.map(digest));
  let dropBefore = 0;
  let replaceFrom = 0;
  if (cursor !== null && cursor.length < 16_384) {
    try {
      const previous: unknown = JSON.parse(atob(cursor.replaceAll("-", "+").replaceAll("_", "/")));
      if (Array.isArray(previous) && previous.length === 2 && previous[0] === scope
        && Array.isArray(previous[1]) && previous[1].length <= 100
        && previous[1].every((hash: unknown) => typeof hash === "string" && /^[A-Za-z0-9_-]{43}$/.test(hash))) {
        const known: string[] = previous[1];
        for (let offset = 0; offset < known.length; offset++) {
          const overlap = known.length - offset;
          if (overlap > revisions.length) continue;
          // Only the last turn may still be growing. A changed settled prefix reloads the page.
          if (!known.slice(offset, -1).every((hash, index) => hash === revisions[index])) continue;
          // A sliding page must start at a known turn, never an unrelated one-turn tail.
          if (offset > 0 && known[offset] !== revisions[0]) continue;
          dropBefore = offset;
          replaceFrom = overlap - (known.at(-1) === revisions[overlap - 1] ? 0 : 1);
          break;
        }
      }
    } catch { /* An expired or malformed cursor asks for the complete page. */ }
  }
  return {
    ...body, turns: body.turns.slice(replaceFrom), drop_before: dropBefore, replace_from: replaceFrom,
    delta_cursor: btoa(JSON.stringify([scope, revisions])).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""),
  };
}
