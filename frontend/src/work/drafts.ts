// Drafts of unsaved work, kept ONLY in this browser tab (sessionStorage), per account.
//
// Privacy rules (owner, 2026-11-18):
// - A draft is text only. Never pictures, sound or files.
// - It lives in this tab and is gone when the tab closes, when it is saved, on sign-out,
//   on sign-out of all accounts, and when the account is deleted.
// - A draft is read only when BOTH its key and its value name the tab's current account.
//   Another account's draft is never read, shown, restored or saved.
// - Closing the tab is never treated as a save; this is only a safety copy.
// No window, React or axios here (the store is passed in), so `node --test` can run it.

export const DRAFT_PREFIX = "luma.draft:v1:"
export const MAX_DRAFT_CHARS = 200_000
export const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const DRAFT_BLOCKED_MESSAGE = "We can't keep a copy in this tab. Save soon."

export type DraftKind =
  | "note"
  | "summary"
  | "deck"
  | "plan"
  | "capture-image"
  | "capture-voice"
  | "capture-import"
  | "summary-result"

export type Draft<T = unknown> = {
  v: 1
  accountId: string
  kind: DraftKind
  /** The saved item's id, or "new" for something not saved yet. */
  itemId: string
  /** The server version the words were based on (null for new items). */
  baseVersion: number | null
  /** The Idempotency-Key of a new item, so a reload and retry still can't make a copy. */
  createKey?: string
  savedAt: number
  data: T
}

export type DraftStore = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">

export type DraftWriteResult = "ok" | "too_big" | "blocked"

const KINDS: ReadonlySet<string> = new Set<DraftKind>([
  "note",
  "summary",
  "deck",
  "plan",
  "capture-image",
  "capture-voice",
  "capture-import",
  "summary-result",
])

export function draftKey(accountId: string, kind: DraftKind, itemId: string): string {
  return `${DRAFT_PREFIX}${accountId}:${kind}:${itemId}`
}

/** This tab's sessionStorage, or null when the browser blocks it. */
export function sessionDraftStore(): DraftStore | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage
  } catch {
    return null
  }
}

function remove(store: DraftStore | null, key: string): void {
  try {
    store?.removeItem(key)
  } catch {
    // Nothing more we can do.
  }
}

/**
 * The draft for this account, kind and item, or null. `tabAccountId` is the account this tab
 * uses right now: a draft is only returned when it matches the key AND the value.
 * Drafts older than 24 hours, broken ones and other accounts' ones are never returned.
 */
export function readDraft<T>(
  store: DraftStore | null,
  tabAccountId: string | null,
  accountId: string | null,
  kind: DraftKind,
  itemId: string,
  now: number = Date.now(),
): Draft<T> | null {
  if (!store || !tabAccountId || !accountId || tabAccountId !== accountId) return null
  const key = draftKey(accountId, kind, itemId)
  let raw: string | null
  try {
    raw = store.getItem(key)
  } catch {
    return null
  }
  if (!raw) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    remove(store, key)
    return null
  }
  const draft = value as Partial<Draft<T>> | null
  if (
    !draft ||
    typeof draft !== "object" ||
    draft.v !== 1 ||
    draft.accountId !== accountId ||
    draft.kind !== kind ||
    draft.itemId !== itemId ||
    typeof draft.savedAt !== "number" ||
    !KINDS.has(String(draft.kind)) ||
    draft.data === undefined
  ) {
    // Not ours or not readable: never show it. Only a broken copy under our own key is removed.
    if (!draft || typeof draft !== "object" || draft.accountId === accountId) remove(store, key)
    return null
  }
  if (now - draft.savedAt > DRAFT_MAX_AGE_MS) {
    remove(store, key)
    return null
  }
  return draft as Draft<T>
}

/** Keeps a copy in this tab. Text only; at most MAX_DRAFT_CHARS. */
export function writeDraft(store: DraftStore | null, draft: Draft): DraftWriteResult {
  if (!store) return "blocked"
  const text = JSON.stringify(draft)
  if (text.length > MAX_DRAFT_CHARS) return "too_big"
  try {
    store.setItem(draftKey(draft.accountId, draft.kind, draft.itemId), text)
    return "ok"
  } catch {
    return "blocked"
  }
}

export function clearDraft(store: DraftStore | null, accountId: string | null, kind: DraftKind, itemId: string): void {
  if (!accountId) return
  remove(store, draftKey(accountId, kind, itemId))
}

function sweep(store: DraftStore | null, prefix: string): void {
  if (!store) return
  try {
    const keys: string[] = []
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index)
      if (key && key.startsWith(prefix)) keys.push(key)
    }
    keys.forEach((key) => store.removeItem(key))
  } catch {
    // Storage blocked: nothing was kept, so nothing to clear.
  }
}

/** Removes every draft of one account in this tab (sign-out, account deleted). */
export function sweepAccountDrafts(store: DraftStore | null, accountId: string): void {
  sweep(store, `${DRAFT_PREFIX}${accountId}:`)
}

/** Removes every draft in this tab (sign out of all accounts). */
export function sweepAllDrafts(store: DraftStore | null): void {
  sweep(store, DRAFT_PREFIX)
}
