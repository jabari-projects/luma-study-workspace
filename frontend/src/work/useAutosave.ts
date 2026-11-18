// React side of saving student work: one SaveClient per open editor, wired to the API,
// the unsaved-work registry and this tab's drafts.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { AxiosError } from "axios"
import type { AxiosResponse } from "axios"

import { readBook } from "../api"
import { AccountBlockedError } from "../accounts"
import { beginEditing } from "../maintenance/editSession"
import type { EditSession } from "../maintenance/editSession"
import { DRAFT_BLOCKED_MESSAGE, clearDraft, sessionDraftStore, writeDraft } from "./drafts"
import type { DraftKind } from "./drafts"
import { SaveClient } from "./saveClient"
import type { SaveEnv, SaveReply, SaveRequest, SaveSnapshot, SavedRow } from "./saveClient"
import { hasUnsavedWork, registerWork, subscribeUnsaved } from "./unsaved"

/** Per request (B.7). */
export const SAVE_TIMEOUT_MS = 30_000
const DRAFT_WRITE_DELAY_MS = 500

/** A fresh Idempotency-Key for one new item. */
export function newCreateKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID()
  // Older browsers: a random v4-shaped id.
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16))
  hex[12] = "4"
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  const s = hex.join("")
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

/** The real browser: timers, online/offline and tab visibility. */
export function browserSaveEnv(): SaveEnv {
  return {
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    now: () => Date.now(),
    isOnline: () => navigator.onLine !== false,
    isHidden: () => document.visibilityState === "hidden",
    onWake: (listener) => {
      const online = () => listener("online")
      const visible = () => {
        if (document.visibilityState !== "hidden") listener("visible")
      }
      window.addEventListener("online", online)
      window.addEventListener("focus", visible)
      document.addEventListener("visibilitychange", visible)
      return () => {
        window.removeEventListener("online", online)
        window.removeEventListener("focus", visible)
        document.removeEventListener("visibilitychange", visible)
      }
    },
  }
}

/** Turns an axios call into a SaveReply (never throws). */
export async function toReply<Row>(call: () => Promise<AxiosResponse<Row>>): Promise<SaveReply<Row>> {
  try {
    const response = await call()
    return { kind: "ok", status: response.status, row: response.data ?? null }
  } catch (error: unknown) {
    if (error instanceof AccountBlockedError) return { kind: "signed_out" }
    if (error instanceof AxiosError && error.response) {
      const header = error.response.headers?.["retry-after"]
      return {
        kind: "http",
        status: error.response.status,
        data: error.response.data,
        retryAfterHeader: typeof header === "string" ? header : null,
      }
    }
    return { kind: "network" }
  }
}

/** Asks the maintenance track once, when the editor opens, whether new editing may start. */
export function useEditSession(): { session: EditSession | null; headers: () => Record<string, string> } {
  const [session, setSession] = useState<EditSession | null>(null)
  const ref = useRef<EditSession | null>(null)
  useEffect(() => {
    let active = true
    beginEditing()
      .then((value) => {
        if (!active) return
        ref.current = value
        setSession(value)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])
  const headers = useCallback(() => ref.current?.headers() ?? {}, [])
  return { session, headers }
}

/** True while anything in this tab is not saved yet (re-renders when that changes). */
export function useHasUnsavedWork(): boolean {
  return useSyncExternalStore(subscribeUnsaved, hasUnsavedWork, () => false)
}

export type AutosaveOptions<C, Row extends SavedRow> = {
  /** Plain words for this work, like "Your note". */
  label: string
  /** The account this editor saves to, captured when it opened. */
  accountId: string | null
  itemId: string | null
  version: number | null
  createKey: string | null
  /** When it was last confirmed saved (a new item handed over after its first save). */
  savedAt?: number | null
  debounceMs: number
  /** Existing items save by themselves after a change. New items wait for the Save button. */
  autosave: boolean
  /** Sends one save. Use `config` for every request (account, timeout, edit-session headers). */
  send: (request: SaveRequest<C>, config: SaveConfig) => Promise<SaveReply<Row>>
  /** The student's words, for "Copy my text". */
  textOf: (content: C) => string
  rowHas?: (row: Row, content: C) => boolean
  merge?: (older: C, newer: C) => C
  /** Keep a copy in this tab while unsaved (text only). */
  draft?: { kind: DraftKind; data: (content: C) => unknown } | null
  onSaved?: (row: Row, content: C) => void
}

export type SaveConfig = {
  lumaAccountId?: string
  timeout: number
  headers: Record<string, string>
}

export type Autosave<C, Row extends SavedRow> = {
  snapshot: SaveSnapshot<Row>
  /** The student changed something. */
  change: (content: C) => void
  /** Save now (the Save button passes allowCreate for a new item). */
  flush: (options?: { allowCreate?: boolean }) => Promise<boolean>
  retry: () => void
  keepMine: (currentVersion: number) => void
  takeTheirs: (row: Row) => void
  discard: () => void
  adopt: (row: Row) => void
  /** The newest state right now (the `snapshot` above is the one from the last render). */
  peek: () => SaveSnapshot<Row> | null
  /** Set when this tab can't keep a safety copy (storage blocked or full). */
  draftProblem: string | null
  /** Set when the maintenance track says new work can't start right now. */
  editBlocked: string | null
}

let editorCounter = 0

export function useAutosave<C, Row extends SavedRow>(options: AutosaveOptions<C, Row>): Autosave<C, Row> {
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  })
  const { session, headers } = useEditSession()
  const [snapshot, setSnapshot] = useState<SaveSnapshot<Row>>(() => ({
    state: "clean",
    slow: false,
    savedAt: options.savedAt ?? null,
    itemId: options.itemId,
    version: options.version,
    current: null,
    message: null,
    hasPending: false,
  }))
  const [draftProblem, setDraftProblem] = useState<string | null>(null)
  const clientRef = useRef<SaveClient<C, Row> | null>(null)
  const draftTimer = useRef<number | null>(null)
  const latestContent = useRef<C | null>(null)
  const draftItem = useRef<string>(options.itemId ?? "new")
  const keepCopyRef = useRef<(() => void) | null>(null)

  // The client lives inside an effect so React's StrictMode double mount gets a fresh one.
  useEffect(() => {
    const initial = optionsRef.current
    const store = sessionDraftStore()
    const id = `work-${(editorCounter += 1)}`
    const accountId = initial.accountId
    let registry: ReturnType<typeof registerWork> | null = null

    const writeNow = () => {
      if (draftTimer.current !== null) window.clearTimeout(draftTimer.current)
      draftTimer.current = null
      const draft = optionsRef.current.draft
      const content = latestContent.current
      const snap = client.getSnapshot()
      if (!draft || !accountId || content === null || !snap.hasPending) return
      const result = writeDraft(store, {
        v: 1,
        accountId,
        kind: draft.kind,
        itemId: snap.itemId ?? "new",
        baseVersion: snap.itemId ? snap.version : null,
        ...(snap.itemId ? {} : initial.createKey ? { createKey: initial.createKey } : {}),
        savedAt: Date.now(),
        data: draft.data(content),
      })
      setDraftProblem(result === "ok" ? null : DRAFT_BLOCKED_MESSAGE)
    }

    const client = new SaveClient<C, Row>({
      env: browserSaveEnv(),
      debounceMs: initial.debounceMs,
      itemId: initial.itemId,
      version: initial.version,
      createKey: initial.createKey,
      savedAt: initial.savedAt,
      autosave: initial.autosave,
      merge: initial.merge,
      rowHas: (row, content) => optionsRef.current.rowHas?.(row, content) ?? true,
      send: (request) =>
        optionsRef.current.send(request, {
          lumaAccountId: accountId ?? undefined,
          timeout: SAVE_TIMEOUT_MS,
          headers: headers(),
        }),
      onSaved: (row, content) => optionsRef.current.onSaved?.(row, content),
      onChange: (next) => {
        setSnapshot(next)
        registry?.update(next.state)
        const draft = optionsRef.current.draft
        if (draft && accountId) {
          const key = next.itemId ?? "new"
          if (key !== draftItem.current) {
            // A new item just got its id: its "new" copy is not needed any more.
            clearDraft(store, accountId, draft.kind, draftItem.current)
            draftItem.current = key
          }
          if ((next.state === "saved" || next.state === "clean") && !next.hasPending) {
            if (draftTimer.current !== null) window.clearTimeout(draftTimer.current)
            draftTimer.current = null
            clearDraft(store, accountId, draft.kind, key)
          }
        }
      },
    })
    clientRef.current = client
    registry = registerWork({
      id,
      accountId,
      label: initial.label,
      state: "clean",
      getText: () => {
        const content = client.latest() ?? latestContent.current
        return content === null ? "" : optionsRef.current.textOf(content)
      },
      flush: () => client.flush(),
      resume: () => client.resume(),
      discard: () => client.discard(),
    })
    // Remember how to keep a copy right away (used when the editor closes).
    const keepCopy = writeNow
    keepCopyRef.current = () => {
      if (draftTimer.current !== null) window.clearTimeout(draftTimer.current)
      draftTimer.current = window.setTimeout(keepCopy, DRAFT_WRITE_DELAY_MS)
    }

    return () => {
      registry?.unregister()
      registry = null
      // The editor is closing (another page, or another account in this tab). If the account is
      // still on this device, keep the unsaved words in this tab and let a pending save finish.
      // After a sign-out the account is gone, so nothing is kept.
      const stillHere = accountId ? Boolean(readBook().accounts[accountId]) : false
      if (stillHere) {
        writeNow()
        void client.flush().finally(() => client.dispose())
      } else {
        if (draftTimer.current !== null) window.clearTimeout(draftTimer.current)
        draftTimer.current = null
        client.dispose()
      }
      if (clientRef.current === client) clientRef.current = null
      keepCopyRef.current = null
    }
  }, [headers])

  const change = useCallback((content: C) => {
    latestContent.current = content
    clientRef.current?.change(content)
    keepCopyRef.current?.()
  }, [])
  const flush = useCallback(
    (flushOptions?: { allowCreate?: boolean }) => clientRef.current?.flush(flushOptions) ?? Promise.resolve(false),
    [],
  )
  const retry = useCallback(() => clientRef.current?.retry(), [])
  const keepMine = useCallback((currentVersion: number) => clientRef.current?.keepMine(currentVersion), [])
  const takeTheirs = useCallback((row: Row) => clientRef.current?.takeTheirs(row), [])
  const discard = useCallback(() => clientRef.current?.discard(), [])
  const adopt = useCallback((row: Row) => clientRef.current?.adopt(row), [])
  const peek = useCallback(() => clientRef.current?.getSnapshot() ?? null, [])

  return {
    snapshot,
    change,
    flush,
    retry,
    keepMine,
    takeTheirs,
    discard,
    adopt,
    peek,
    draftProblem,
    editBlocked: session && !session.allowed ? (session.message ?? "New work can't start right now.") : null,
  }
}
