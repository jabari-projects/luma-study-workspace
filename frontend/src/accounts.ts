// The accounts saved on this device ("the book"), as pure functions.
//
// Rules:
// - Up to MAX_ACCOUNTS accounts per device. Expired ones still count and can be removed.
// - Each browser tab is bound to one account (sessionStorage, see api.ts).
// - The AI chat account is the saved account with the smallest signedInAt, signed in or
//   expired. It is worked out, never stored. It only moves when that account is removed
//   (sign out, sign out of all, Remove, or deleting the account). Expiry and password
//   resets keep it in place, and signing in again to a listed account keeps its place.
//
// No window, axios or import.meta here, and only type imports, so `node --test` can run it.
import type { BasicUser, Profile } from "./types.ts"

export const AUTH_STORAGE_KEY = "luma.auth"
export const TAB_ACCOUNT_KEY = "luma.tabAccount"
export const LEGACY_ACTIVITY_KEY = "luma.activity"
export const MAX_ACCOUNTS = 3
export const activityKey = (id: string) => `${LEGACY_ACTIVITY_KEY}:${id}`
/**
 * Old new-note drafts that earlier versions kept in localStorage (on the device, after the tab
 * closed). Drafts now live only in the tab (work/drafts.ts). Real-data migration path: this
 * removes the old copies once per page load. Remove after 2027-02-01 (Task Board item:
 * "Remove the luma.noteDraft cleanup").
 */
export const NOTE_DRAFT_PREFIX = "luma.noteDraft:"

export function removeLegacyNoteDrafts(storage: Pick<Storage, "key" | "length" | "removeItem"> | null): void {
  if (!storage) return
  try {
    const keys: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key && key.startsWith(NOTE_DRAFT_PREFIX)) keys.push(key)
    }
    keys.forEach((key) => storage.removeItem(key))
  } catch {
    // Storage blocked: there is nothing to remove.
  }
}
/** "Don't show this again" on the review intro, kept on this device per account (cleared on sign-out). */
export const STUDY_INTRO_PREFIX = "luma.studyIntroSeen:"
export const studyIntroKey = (id: string) => `${STUDY_INTRO_PREFIX}${id}`

export type AccountUser = BasicUser | Profile
export type AccountStatus = "signed_in" | "expired"

/** When status is "expired", accessToken is null. When "signed_in", it is a non-empty string. */
export type StoredAccount = {
  accessToken: string | null
  user: AccountUser
  signedInAt: number
  status: AccountStatus
}

export type AccountBook = {
  v: 2
  accounts: Record<string, StoredAccount>
  lastActiveId: string | null
}

export type ListedAccount = StoredAccount & { id: string }

export type AuthDecision =
  | { kind: "none" }
  | { kind: "bearer"; id: string; token: string }
  | { kind: "blocked"; id: string }

export const ACCOUNT_LIMIT_MESSAGE = `You can have ${MAX_ACCOUNTS} accounts on this device. Sign out of one first.`

export class AccountLimitError extends Error {
  constructor(message = ACCOUNT_LIMIT_MESSAGE) {
    super(message)
    this.name = "AccountLimitError"
  }
}

/** A request for an account that is expired or gone. It is never sent. */
export class AccountBlockedError extends Error {
  constructor(message = "Please sign in again.") {
    super(message)
    this.name = "AccountBlockedError"
  }
}

export function emptyBook(): AccountBook {
  return { v: 2, accounts: {}, lastActiveId: null }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validEntry(id: string, raw: unknown): StoredAccount | null {
  if (!isRecord(raw)) return null
  const user = raw.user
  if (!isRecord(user) || typeof user.id !== "string" || user.id !== id) return null
  if (typeof raw.signedInAt !== "number" || !Number.isFinite(raw.signedInAt)) return null
  const token = raw.accessToken
  if (raw.status === "signed_in") {
    if (typeof token !== "string" || !token.trim()) return null
    return { accessToken: token, user: user as AccountUser, signedInAt: raw.signedInAt, status: "signed_in" }
  }
  if (raw.status === "expired") {
    if (token !== null) return null
    return { accessToken: null, user: user as AccountUser, signedInAt: raw.signedInAt, status: "expired" }
  }
  return null
}

function byAge(a: ListedAccount, b: ListedAccount): number {
  if (a.signedInAt !== b.signedInAt) return a.signedInAt - b.signedInAt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Oldest sign-in first; ties go by id so the order never flickers. */
export function orderedAccounts(book: AccountBook): ListedAccount[] {
  return Object.entries(book.accounts)
    .map(([id, account]) => ({ ...account, id }))
    .sort(byAge)
}

function fromList(list: ListedAccount[], lastActiveId: string | null): AccountBook {
  const accounts: Record<string, StoredAccount> = {}
  for (const { id, ...account } of list) {
    accounts[id] = account
  }
  return { v: 2, accounts, lastActiveId: lastActiveId && accounts[lastActiveId] ? lastActiveId : null }
}

export function parseBook(raw: string | null): { book: AccountBook; migratedFromV1: string | null; corrupt: boolean } {
  if (raw === null || raw === "") {
    return { book: emptyBook(), migratedFromV1: null, corrupt: false }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { book: emptyBook(), migratedFromV1: null, corrupt: true }
  }
  if (!isRecord(parsed)) {
    return { book: emptyBook(), migratedFromV1: null, corrupt: true }
  }

  // Version 1: one session, { accessToken, user }.
  if (parsed.v === undefined) {
    const user = parsed.user
    if (typeof parsed.accessToken === "string" && parsed.accessToken.trim() && isRecord(user) && typeof user.id === "string") {
      const id = user.id
      return {
        book: {
          v: 2,
          // signedInAt 0 keeps the upgraded account first in line for the AI chat.
          accounts: { [id]: { accessToken: parsed.accessToken, user: user as AccountUser, signedInAt: 0, status: "signed_in" } },
          lastActiveId: id,
        },
        migratedFromV1: id,
        corrupt: false,
      }
    }
    return { book: emptyBook(), migratedFromV1: null, corrupt: true }
  }

  if (parsed.v !== 2 || !isRecord(parsed.accounts)) {
    return { book: emptyBook(), migratedFromV1: null, corrupt: true }
  }

  const list: ListedAccount[] = []
  for (const [id, entry] of Object.entries(parsed.accounts)) {
    const account = validEntry(id, entry)
    if (account) list.push({ ...account, id })
  }
  list.sort(byAge)
  const lastActiveId = typeof parsed.lastActiveId === "string" ? parsed.lastActiveId : null
  return { book: fromList(list.slice(0, MAX_ACCOUNTS), lastActiveId), migratedFromV1: null, corrupt: false }
}

export function chatbotAccountId(book: AccountBook): string | null {
  return orderedAccounts(book)[0]?.id ?? null
}

export function findByEmail(book: AccountBook, email: string): string | null {
  const wanted = email.trim().toLowerCase()
  if (!wanted) return null
  for (const [id, account] of Object.entries(book.accounts)) {
    if (account.user.email?.toLowerCase() === wanted) return id
  }
  return null
}

/** True when this email is already listed, or there is room for one more account. */
export function canAdd(book: AccountBook, email: string): boolean {
  return findByEmail(book, email) !== null || Object.keys(book.accounts).length < MAX_ACCOUNTS
}

export function upsertSignedIn(
  book: AccountBook,
  session: { accessToken: string; user: AccountUser },
  now: number,
): AccountBook {
  const id = session.user.id
  const existing = book.accounts[id]
  if (existing) {
    return {
      ...book,
      accounts: {
        ...book.accounts,
        [id]: { accessToken: session.accessToken, user: session.user, signedInAt: existing.signedInAt, status: "signed_in" },
      },
    }
  }
  if (Object.keys(book.accounts).length >= MAX_ACCOUNTS) {
    throw new AccountLimitError()
  }
  // Always later than every saved account, so the sign-in order stays strict.
  const latest = Math.max(-1, ...Object.values(book.accounts).map((account) => account.signedInAt))
  return {
    ...book,
    accounts: {
      ...book.accounts,
      [id]: { accessToken: session.accessToken, user: session.user, signedInAt: Math.max(now, latest + 1), status: "signed_in" },
    },
  }
}

/** Marks the account expired, but only if `sentToken` is still its token. */
export function markExpired(book: AccountBook, id: string, sentToken: string): AccountBook {
  const account = book.accounts[id]
  if (!account || account.status !== "signed_in" || account.accessToken !== sentToken) {
    return book
  }
  return {
    ...book,
    accounts: { ...book.accounts, [id]: { ...account, accessToken: null, status: "expired" } },
  }
}

/** Saves fresh user details. Does nothing if the id is missing or wrong, or the token changed. */
export function updateUser(book: AccountBook, id: string, user: AccountUser, expectedToken?: string | null): AccountBook {
  const account = book.accounts[id]
  if (!account || user.id !== id) return book
  if (expectedToken !== undefined && account.accessToken !== expectedToken) return book
  return { ...book, accounts: { ...book.accounts, [id]: { ...account, user } } }
}

export function remove(book: AccountBook, id: string): AccountBook {
  if (!book.accounts[id]) return book
  const accounts = { ...book.accounts }
  delete accounts[id]
  let lastActiveId = book.lastActiveId
  if (lastActiveId === id || (lastActiveId && !accounts[lastActiveId])) {
    const rest = orderedAccounts({ ...book, accounts })
    lastActiveId = (rest.find((account) => account.status === "signed_in") ?? rest[0])?.id ?? null
  }
  return { v: 2, accounts, lastActiveId }
}

/**
 * Which account this tab shows.
 * - The tab's own account wins while it is saved.
 * - If the tab was showing an account that is now gone (`hadBinding`), report it and pick nobody.
 * - A fresh tab uses the last account used on this device, then the oldest signed-in one.
 */
export function pickActive(
  book: AccountBook,
  tabId: string | null,
  hadBinding: boolean,
): { id: string | null; lostBinding: boolean } {
  if (tabId && book.accounts[tabId]) {
    return { id: tabId, lostBinding: false }
  }
  if (tabId && hadBinding) {
    return { id: null, lostBinding: true }
  }
  if (book.lastActiveId && book.accounts[book.lastActiveId]) {
    return { id: book.lastActiveId, lostBinding: false }
  }
  const firstSignedIn = orderedAccounts(book).find((account) => account.status === "signed_in")
  return { id: firstSignedIn?.id ?? null, lostBinding: false }
}

/** Which token a request should carry. It never borrows another account's token. */
export function resolveRequestAuth(
  book: AccountBook,
  tabId: string | null,
  opts: { lumaAuth?: "none"; lumaAccountId?: string },
): AuthDecision {
  if (opts.lumaAuth === "none") return { kind: "none" }
  const id = opts.lumaAccountId ?? tabId
  if (!id) return { kind: "none" }
  const account = book.accounts[id]
  if (account && account.status === "signed_in" && account.accessToken) {
    return { kind: "bearer", id, token: account.accessToken }
  }
  return { kind: "blocked", id }
}

// The backend's answers that always mean "this token no longer works".
const EXPIRED_DETAILS = new Set([
  "Session expired. Please log in again.",
  "Token expired",
  "Invalid token",
  "Invalid token type",
  "Invalid or expired token",
  "Not authenticated",
  "Missing token",
])

/**
 * What a 401 answer means for the account that sent it.
 * - "expired": the server said the token is bad, so mark the account expired.
 * - "check": a vague answer ({ error: "Unauthorized" } or "Please log in again." from the AI
 *   routes). Those routes also answer this way during a short server problem, so ask the
 *   server again before throwing the token away.
 */
export function classifyUnauthorized(data: unknown): "expired" | "check" {
  if (isRecord(data) && typeof data.detail === "string") {
    if (EXPIRED_DETAILS.has(data.detail) || data.detail.startsWith("Session expired")) {
      return "expired"
    }
  }
  return "check"
}
