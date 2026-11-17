import axios, { AxiosError, AxiosHeaders } from "axios"
import type { AxiosInstance } from "axios"

import {
  AUTH_STORAGE_KEY,
  AccountBlockedError,
  LEGACY_ACTIVITY_KEY,
  TAB_ACCOUNT_KEY,
  activityKey,
  classifyUnauthorized,
  markExpired,
  parseBook,
  remove,
  resolveRequestAuth,
  upsertSignedIn,
} from "./accounts"
import type { AccountBook } from "./accounts"
import type { BasicUser, Profile } from "./types"

export type { BasicUser, Profile } from "./types"
export { AUTH_STORAGE_KEY }

declare module "axios" {
  interface AxiosRequestConfig {
    /** "none": send no token (login, reset and other sign-in steps). */
    lumaAuth?: "none"
    /** Send this saved account's token instead of the tab's account. */
    lumaAccountId?: string
    /** Internal: a check that a vague 401 really means the sign-in ended. */
    lumaConfirm?: boolean
  }
  interface InternalAxiosRequestConfig {
    /** Which account and token this request went out with. */
    lumaStamp?: { id: string; token: string }
  }
}

function normalizeBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim()
  if (!trimmed) {
    throw new Error("VITE_API_BASE_URL is not configured.")
  }
  return trimmed.replace(/\/+$/, "")
}

export const API_BASE_URL = normalizeBaseUrl(import.meta.env.VITE_API_BASE_URL)
export type AuthSession = {
  user: BasicUser
  access_token: string
}

export type StoredAuthSession = {
  accessToken: string
  user: BasicUser | Profile
}

export type SignupPending = {
  status: "check_email"
  email: string
  /** Random value only this browser knows; needed with the emailed code. */
  ticket: string
  resend_after_seconds: number
  code_expires_in_seconds: number
}

export type SignupPayload = {
  email: string
  username: string
  password: string
}

type ApiValidationError = {
  msg?: string
}

type ApiErrorPayload = {
  detail?: string | ApiValidationError[]
  error?: string
  message?: string
  error_code?: string
  retry_after?: number
}

const CANT_REACH_MESSAGE = "We can't reach Luma right now. Try again in a minute."

export class ApiRequestError extends Error {
  status: number
  payload?: ApiErrorPayload

  constructor(message: string, status: number, payload?: ApiErrorPayload) {
    super(message)
    this.status = status
    this.payload = payload
  }
}

function errorPayload(error: unknown): ApiErrorPayload | undefined {
  if (error instanceof AxiosError) {
    return error.response?.data as ApiErrorPayload | undefined
  }
  if (error instanceof ApiRequestError) {
    return error.payload
  }
  return undefined
}

/** Stable machine-readable reason from the account routes, e.g. "code_expired". */
export function getErrorCode(error: unknown): string | undefined {
  const code = errorPayload(error)?.error_code
  return typeof code === "string" ? code : undefined
}

/** Seconds to wait before trying again (429 answers), if the server said. */
export function getRetryAfter(error: unknown): number | undefined {
  const value = errorPayload(error)?.retry_after
  return typeof value === "number" && value > 0 ? value : undefined
}

function isMissingRoute(status: number | undefined, data: ApiErrorPayload | undefined): boolean {
  // A 404 with FastAPI's default body means the server we reached doesn't have
  // this route at all (wrong server or an old fake server), not "account not found".
  if (status !== 404) {
    return false
  }
  const detail = typeof data?.detail === "string" ? data.detail : ""
  return detail === "" || detail === "Not Found" || detail === "Not found" || detail.startsWith("Fake server has no route")
}

export const api: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    Accept: "application/json",
  },
})

/* ------------------------------------------------ saved accounts on this device */

/** Fired on window when a saved account's sign-in stops working. detail: { id }. */
export const ACCOUNT_EXPIRED_EVENT = "luma:account-expired"

const SIGNUP_TICKET_KEY = "luma.signupTicket"

function storageGet(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key)
  } catch {
    return null
  }
}

/** False when the browser blocked the write (private mode, blocked site data, or full). */
function storageSet(storage: () => Storage, key: string, value: string | null): boolean {
  try {
    if (value === null) {
      storage().removeItem(key)
    } else {
      storage().setItem(key, value)
    }
    return true
  } catch {
    // Storage can be blocked (private mode). The app then acts signed out.
    return false
  }
}

export const STORAGE_BLOCKED_MESSAGE =
  "This browser won't let Luma save your sign-in. Allow site data for Luma, or leave private mode, then try again."

/** Thrown when the browser won't let us save a sign-in. */
export class StorageBlockedError extends Error {
  constructor(message = STORAGE_BLOCKED_MESSAGE) {
    super(message)
    this.name = "StorageBlockedError"
  }
}

const local = () => window.localStorage
const session = () => window.sessionStorage

let legacyChecked = false

/** Reads the saved accounts. Upgrades the old one-account format once. */
export function readBook(): AccountBook {
  const { book, migratedFromV1, corrupt } = parseBook(storageGet(local, AUTH_STORAGE_KEY))
  if (corrupt) {
    storageSet(local, AUTH_STORAGE_KEY, null)
  }
  if (migratedFromV1) {
    writeBook(book)
    // Study activity from before belongs to the account that was signed in.
    const activity = storageGet(local, LEGACY_ACTIVITY_KEY)
    if (activity !== null && storageGet(local, activityKey(migratedFromV1)) === null) {
      storageSet(local, activityKey(migratedFromV1), activity)
    }
    storageSet(local, LEGACY_ACTIVITY_KEY, null)
    legacyChecked = true
  } else if (!legacyChecked) {
    // Old activity with no signed-in owner: nobody can claim it, so drop it.
    legacyChecked = true
    storageSet(local, LEGACY_ACTIVITY_KEY, null)
  }
  return book
}

/** False when the browser would not save it. */
export function writeBook(book: AccountBook): boolean {
  return storageSet(local, AUTH_STORAGE_KEY, JSON.stringify(book))
}

// Each tab is bound to one account, so switching in one tab never changes another.
let tabAccountId: string | null = typeof window === "undefined" ? null : storageGet(session, TAB_ACCOUNT_KEY)

export function getTabAccountId(): string | null {
  return tabAccountId
}

export function setTabAccountId(id: string | null): void {
  tabAccountId = id
  storageSet(session, TAB_ACCOUNT_KEY, id)
  if (id) {
    const book = readBook()
    if (book.accounts[id] && book.lastActiveId !== id) {
      writeBook({ ...book, lastActiveId: id })
    }
  }
}

/** This tab's account, only while it is signed in. */
export function readStoredSession(): StoredAuthSession | null {
  const id = tabAccountId
  if (!id) {
    return null
  }
  const account = readBook().accounts[id]
  if (!account || account.status !== "signed_in" || !account.accessToken) {
    return null
  }
  return { accessToken: account.accessToken, user: account.user }
}

/**
 * Adds or refreshes an account and binds this tab to it. Throws AccountLimitError when full,
 * and StorageBlockedError when the browser won't save it (so the page can say so).
 */
export function writeStoredSession(stored: StoredAuthSession): void {
  const next = upsertSignedIn(readBook(), stored, Date.now())
  if (!writeBook(next) || !readBook().accounts[stored.user.id]) {
    throw new StorageBlockedError()
  }
  setTabAccountId(stored.user.id)
}

/** Removes one account and its study activity from this device. */
export function removeStoredAccount(id: string): void {
  writeBook(remove(readBook(), id))
  storageSet(local, activityKey(id), null)
}

/** Signs out only this tab's account. */
export function clearStoredSession(): void {
  if (tabAccountId) {
    removeStoredAccount(tabAccountId)
  }
}

/** Signs out every account on this device. */
export function clearAllStoredSessions(): void {
  try {
    const keys: string[] = []
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index)
      if (key && key.startsWith(`${LEGACY_ACTIVITY_KEY}:`)) {
        keys.push(key)
      }
    }
    keys.forEach((key) => window.localStorage.removeItem(key))
  } catch {
    // Nothing more to clear.
  }
  storageSet(local, AUTH_STORAGE_KEY, null)
  storageSet(local, LEGACY_ACTIVITY_KEY, null)
  storageSet(session, SIGNUP_TICKET_KEY, null)
  tabAccountId = null
  storageSet(session, TAB_ACCOUNT_KEY, null)
}

export function getStoredAccessToken(): string | null {
  return readStoredSession()?.accessToken ?? null
}

// Every request uses the token of the account it belongs to: the pinned account
// (lumaAccountId) or this tab's account. It never borrows another account's token.
api.interceptors.request.use((config) => {
  const headers = AxiosHeaders.from(config.headers)
  const decision = resolveRequestAuth(readBook(), getTabAccountId(), config)

  if (decision.kind === "bearer") {
    headers.set("Authorization", `Bearer ${decision.token}`)
    config.lumaStamp = { id: decision.id, token: decision.token }
  } else if (decision.kind === "none") {
    headers.delete("Authorization")
  } else {
    throw new AccountBlockedError()
  }

  config.headers = headers
  return config
})

function expireAccount(stamp: { id: string; token: string }): void {
  writeBook(markExpired(readBook(), stamp.id, stamp.token))
  window.dispatchEvent(new CustomEvent(ACCOUNT_EXPIRED_EVENT, { detail: { id: stamp.id } }))
}

// One check per token at a time, even when several requests fail together.
const pendingChecks = new Map<string, Promise<void>>()

/** Asks the server once more, with this account's token, whether its sign-in still works. */
function confirmExpired(stamp: { id: string; token: string }): void {
  if (pendingChecks.has(stamp.token)) {
    return
  }
  const check = api
    .get("/me/profile", { lumaAccountId: stamp.id, lumaConfirm: true })
    .then(
      () => undefined,
      () => undefined, // A 401 here is handled by this interceptor. Other errors keep the account.
    )
    .finally(() => pendingChecks.delete(stamp.token))
  pendingChecks.set(stamp.token, check)
}

// A clear 401 means that account's sign-in stopped working (time ran out, or the password
// changed). Mark only that account as expired, and only if it still has the same token.
// A vague 401 (the AI routes say this during short server problems too) is checked first.
api.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    if (error instanceof AxiosError && error.response?.status === 401) {
      const stamp = error.config?.lumaStamp
      if (stamp) {
        if (error.config?.lumaConfirm || classifyUnauthorized(error.response.data) === "expired") {
          expireAccount(stamp)
        } else {
          confirmExpired(stamp)
        }
      }
    }
    return Promise.reject(error)
  },
)

export function getErrorMessage(error: unknown, fallback = "Something went wrong."): string {
  if (error instanceof AxiosError) {
    if (!error.response) {
      return CANT_REACH_MESSAGE
    }

    const data = error.response.data as ApiErrorPayload | undefined
    if (isMissingRoute(error.response.status, data)) {
      return CANT_REACH_MESSAGE
    }
    if (typeof data?.detail === "string" && data.detail) {
      return data.detail
    }

    if (Array.isArray(data?.detail)) {
      const firstMessage = data.detail.find((item) => typeof item.msg === "string" && item.msg)
      if (firstMessage?.msg) {
        return firstMessage.msg
      }
    }

    if (typeof data?.error === "string" && data.error) {
      return data.error
    }

    if (typeof data?.message === "string" && data.message) {
      return data.message
    }
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
}

export async function signupWithBackend(payload: SignupPayload): Promise<SignupPending> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}/signup`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })
  } catch {
    throw new ApiRequestError(CANT_REACH_MESSAGE, 0)
  }

  if (!response.ok) {
    let data: ApiErrorPayload | undefined
    try {
      data = (await response.json()) as ApiErrorPayload
    } catch {
      // Not JSON; fall back to a plain message below.
    }

    let message = "We couldn't make your account. Try again."
    if (isMissingRoute(response.status, data)) {
      message = CANT_REACH_MESSAGE
    } else if (typeof data?.detail === "string" && data.detail) {
      message = data.detail
    } else if (Array.isArray(data?.detail)) {
      const first = data.detail.find((item) => typeof item.msg === "string" && item.msg)
      if (first?.msg) {
        message = /email/i.test(first.msg) ? "Check your email address." : first.msg
      }
    } else if (typeof data?.error === "string" && data.error) {
      message = data.error
    }
    throw new ApiRequestError(message, response.status, data)
  }

  return response.json() as Promise<SignupPending>
}

export async function checkBackendHealth(): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/health`, {
    method: "GET",
  })

  if (response.status !== 200) {
    throw new Error(`Luma answered with HTTP ${response.status}.`)
  }
}
