// CONTRACT owned by the student-work track. Counts are for this tab only.
//
// Every open editor registers here with its save state. The rest of the app asks one
// question, "is any work in this tab not saved yet?", before it leaves a page, switches or
// signs out an account, or (maintenance track) shows its notices.
// No window, React or axios here, so `node --test` can run it.

export type WorkState =
  | "clean"
  | "dirty"
  | "saving"
  | "saved"
  | "offline"
  | "failed"
  | "signed_out"
  | "maintenance"
  | "conflict"
  | "gone"

export type UnsavedSummary = { unsaved: number; saving: number; failed: number }

export type WorkEntry = {
  /** Unique per open editor. */
  id: string
  /** The account the editor saves to (captured when it opened). */
  accountId: string | null
  /** Plain words for this work, like "Your note". */
  label: string
  state: WorkState
  /** The student's own words, for "Copy my text". */
  getText: () => string
  /** Save now. Resolves true when the server confirmed it (or there was nothing to save). */
  flush: () => Promise<boolean>
  /** Try the paused saves again once (after signing in again). */
  resume: () => void
  /** Try a save that waits on the break message once more (Luma reopened). */
  retryAfterBreak?: () => void
  /** Throw this work away (the student said so). */
  discard: () => void
}

const SAFE: ReadonlySet<WorkState> = new Set(["clean", "saved"])

const entries = new Map<string, WorkEntry>()
const listeners = new Set<() => void>()
let cachedSummary: UnsavedSummary = { unsaved: 0, saving: 0, failed: 0 }

function emit(): void {
  let unsaved = 0
  let saving = 0
  let failed = 0
  for (const entry of entries.values()) {
    if (entry.state === "saving") saving += 1
    else if (entry.state === "failed") failed += 1
    else if (!SAFE.has(entry.state)) unsaved += 1
  }
  if (unsaved !== cachedSummary.unsaved || saving !== cachedSummary.saving || failed !== cachedSummary.failed) {
    cachedSummary = { unsaved, saving, failed }
  }
  for (const listener of [...listeners]) listener()
}

/** Adds an editor. Call the returned `update` on every state change and `unregister` when it closes. */
export function registerWork(entry: WorkEntry): { update: (state: WorkState) => void; unregister: () => void } {
  entries.set(entry.id, { ...entry })
  emit()
  return {
    update(state) {
      const current = entries.get(entry.id)
      if (!current || current.state === state) return
      current.state = state
      emit()
    },
    unregister() {
      if (entries.delete(entry.id)) emit()
    },
  }
}

/** The same object until a count changes, so React's useSyncExternalStore can use it. */
export function getUnsavedSummary(): UnsavedSummary {
  return cachedSummary
}

export function subscribeUnsaved(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** True when anything in this tab is changed but not saved, saving, failed, waiting to sign in, or in conflict. */
export function hasUnsavedWork(): boolean {
  for (const entry of entries.values()) {
    if (!SAFE.has(entry.state)) return true
  }
  return false
}

export function hasUnsavedWorkFor(accountId: string | null): boolean {
  for (const entry of entries.values()) {
    if (entry.accountId === accountId && !SAFE.has(entry.state)) return true
  }
  return false
}

/** The words of every unsaved editor in this tab, with a short label each, for the clipboard. */
export function copyUnsavedText(): string {
  return [...entries.values()]
    .filter((entry) => !SAFE.has(entry.state))
    .map((entry) => ({ label: entry.label, text: entry.getText().trim() }))
    .filter((item) => item.text)
    .map((item) => `${item.label}\n${item.text}`)
    .join("\n\n")
}

/** Saves everything now. True only when every editor's save was confirmed by the server. */
export async function flushAllWork(): Promise<boolean> {
  const pending = [...entries.values()].filter((entry) => !SAFE.has(entry.state))
  const results = await Promise.all(pending.map((entry) => entry.flush().catch(() => false)))
  return results.every(Boolean) && !hasUnsavedWork()
}

/** After signing in again: every save paused for that account tries once more. */
export function resumeWork(accountId: string): void {
  for (const entry of [...entries.values()]) {
    if (entry.accountId === accountId && entry.state === "signed_out") entry.resume()
  }
}

/** Luma reopened after a break: every save waiting on the break message tries once more. */
export function retryWorkAfterBreak(): void {
  for (const entry of [...entries.values()]) {
    if (entry.state === "maintenance") entry.retryAfterBreak?.()
  }
}

/** The student chose "Throw it away" for this account's unsaved work. */
export function discardWork(accountId: string | null): void {
  for (const entry of [...entries.values()]) {
    if (entry.accountId === accountId && !SAFE.has(entry.state)) entry.discard()
  }
}
