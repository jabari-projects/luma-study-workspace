// One editor's saves, one at a time, with the rules from the safety design (B.6, B.7):
// - "Saved" only after a 2xx whose body has a numeric `version` (the server confirmed it).
// - At most one request in flight. Newer edits wait; only the newest words go next.
// - Updates send `expected_version`. A 409 stops autosaving until the student picks.
// - New items send the same Idempotency-Key every time, so a retry never makes a copy.
// - Bounded retries for network trouble, timeouts, 502/503/504 and 429 only.
// No window, React or axios here (the transport and the clock are passed in), so
// `node --test` can run it with a fake clock.

export type SaveState =
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

export type SavedRow = { id?: unknown; version?: unknown }

/** What the transport answers. It never throws. */
export type SaveReply<Row> =
  | { kind: "ok"; status: number; row: Row | null }
  | { kind: "http"; status: number; data: unknown; retryAfterHeader: string | null }
  | { kind: "network" }
  | { kind: "signed_out" }

export type SaveRequest<C> = {
  content: C
  /** "create" (POST with createKey) until the item exists, then "update" (PUT/PATCH). */
  mode: "create" | "update"
  itemId: string | null
  expectedVersion: number | null
  createKey: string | null
}

export type SaveEnv = {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  now: () => number
  isOnline: () => boolean
  isHidden: () => boolean
  /** Calls back on the `online` event and when the tab becomes visible or focused again. */
  onWake: (listener: (reason: "online" | "visible") => void) => () => void
}

export type SaveSnapshot<Row> = {
  state: SaveState
  /** True after SLOW_AFTER_MS of saving: "Still saving...". */
  slow: boolean
  savedAt: number | null
  itemId: string | null
  version: number | null
  /** The newer row from a 409, while the conflict panel is open. */
  current: Row | null
  /** A short reason for "failed" (from the server's detail when it is plain words). */
  message: string | null
  /** Changes that are not confirmed by the server yet (typed, in flight or waiting to retry). */
  hasPending: boolean
}

// The allowed exception to the owner's "no endless polling" rule: a bounded retry with
// backoff. It stops for good after the last wait, pauses while the tab is hidden, and goes
// on when the tab is visible again or the browser is back online.
export const RETRY_WAITS_MS = [2_000, 5_000, 15_000, 30_000, 60_000]
export const MAX_RETRY_AFTER_MS = 300_000
export const SLOW_AFTER_MS = 5_000

const RETRYABLE_STATUS = new Set([429, 502, 503, 504])

type Options<C, Row> = {
  send: (request: SaveRequest<C>) => Promise<SaveReply<Row>>
  env: SaveEnv
  /** Wait this long after the last change before an autosave. 0 saves right away. */
  debounceMs: number
  itemId: string | null
  version: number | null
  createKey: string | null
  /** When this item was last confirmed saved (a new item handed over after its first save). */
  savedAt?: number | null
  /** Autosave existing items after changes. New items are saved only by an explicit save. */
  autosave: boolean
  /** Combines words not sent yet with newer ones (default: the newer ones win). */
  merge?: (older: C, newer: C) => C
  /** After a create replay: false when the returned row lacks the words we sent (so a PUT follows). */
  rowHas?: (row: Row, content: C) => boolean
  onChange?: (snapshot: SaveSnapshot<Row>) => void
  /** Called after every confirmed save, with the stored row and the words that were sent. */
  onSaved?: (row: Row, content: C) => void
}

function retryAfterMs(reply: SaveReply<unknown>): number | null {
  if (reply.kind !== "http") return null
  const body = reply.data as { retry_after?: unknown } | null
  let seconds: number | null = typeof body?.retry_after === "number" && body.retry_after > 0 ? body.retry_after : null
  if (seconds === null && reply.retryAfterHeader) {
    const parsed = Number(reply.retryAfterHeader)
    if (Number.isFinite(parsed) && parsed > 0) seconds = parsed
  }
  return seconds === null ? null : Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
}

function errorCode(data: unknown): string | null {
  const code = (data as { error_code?: unknown } | null)?.error_code
  return typeof code === "string" ? code : null
}

function plainDetail(data: unknown): string | null {
  const detail = (data as { detail?: unknown } | null)?.detail
  if (typeof detail === "string" && detail.trim() && detail.length < 200) return detail
  if (Array.isArray(detail)) {
    const first = detail.find((item) => typeof item?.msg === "string")
    if (first) return String(first.msg).replace(/^Value error, /, "")
  }
  return null
}

export class SaveClient<C, Row extends SavedRow> {
  private readonly opts: Options<C, Row>
  private state: SaveState = "clean"
  private slow = false
  private savedAt: number | null = null
  private itemId: string | null
  private version: number | null
  private createKey: string | null
  private current: Row | null = null
  private message: string | null = null
  /** Words not sent yet. */
  private pending: C | null = null
  /** Words in flight, or that failed and wait for a retry. */
  private unconfirmed: C | null = null
  private inFlight = false
  private attempt = 0
  private debounceTimer: unknown = null
  private retryTimer: unknown = null
  private slowTimer: unknown = null
  /** A retry that is due but waits because the tab is hidden. */
  private retryPaused = false
  private disposed = false
  /** flush() callers. `patient` ones (the Save button) wait through the bounded retries. */
  private waiters: Array<{ resolve: (saved: boolean) => void; patient: boolean }> = []
  private readonly stopWake: () => void

  constructor(opts: Options<C, Row>) {
    this.opts = opts
    this.itemId = opts.itemId
    this.version = opts.version
    this.createKey = opts.createKey
    this.savedAt = opts.savedAt ?? null
    this.stopWake = opts.env.onWake((reason) => this.wake(reason))
  }

  getSnapshot(): SaveSnapshot<Row> {
    return {
      state: this.state,
      slow: this.slow,
      savedAt: this.savedAt,
      itemId: this.itemId,
      version: this.version,
      current: this.current,
      message: this.message,
      hasPending: this.pending !== null || this.unconfirmed !== null,
    }
  }

  /** The newest words not yet confirmed (in flight, waiting or typed). */
  latest(): C | null {
    return this.pending ?? this.unconfirmed
  }

  /** The student changed something. */
  change(content: C): void {
    if (this.disposed) return
    this.pending = this.pending !== null && this.opts.merge ? this.opts.merge(this.pending, content) : content
    if (this.state === "conflict" || this.state === "gone" || this.state === "signed_out") {
      // After a 409, 404 or 401 nothing saves by itself until the student picks.
      this.emit()
      return
    }
    if (this.state === "failed") this.attempt = 0
    if (!this.inFlight && this.retryTimer === null && !this.retryPaused && this.state !== "offline") {
      this.state = "dirty"
    }
    this.emit()
    if (this.opts.autosave && this.itemId !== null) this.schedule()
  }

  /**
   * Save now. Resolves true when the server confirmed everything (or nothing was waiting).
   * `allowCreate` is for the explicit Save button of a new item: leaving a page never creates one.
   */
  flush({ allowCreate = false }: { allowCreate?: boolean } = {}): Promise<boolean> {
    if (this.disposed) return Promise.resolve(this.isSafe())
    this.clearDebounce()
    if (this.itemId === null && !allowCreate) return Promise.resolve(!this.hasWork())
    if (!this.hasWork()) return Promise.resolve(true)
    if (this.state === "conflict" || this.state === "gone" || this.state === "signed_out") return Promise.resolve(false)
    // The Save button waits for the final answer (through the bounded retries). Leaving a page
    // only waits for this one try, so the student can choose to stay or go.
    const done = new Promise<boolean>((resolve) => this.waiters.push({ resolve, patient: allowCreate }))
    if (!this.inFlight) {
      this.clearRetry()
      this.attempt = 0
      void this.run()
    }
    return done
  }

  /** The "Try again" button. */
  retry(): void {
    if (this.disposed || this.inFlight) return
    this.clearRetry()
    this.attempt = 0
    this.restorePending()
    void this.run()
  }

  /**
   * Luma reopened after a break (maintenance/observe.ts saw it): a save that waits on the
   * break message tries once now. One event, not polling.
   */
  retryAfterBreak(): void {
    if (this.state !== "maintenance") return
    this.retry()
  }

  /** After signing in again: the paused save tries once. */
  resume(): void {
    if (this.state !== "signed_out") return
    this.state = "dirty"
    this.retry()
  }

  /** Conflict panel "Keep mine": save my words over the newer version, because the student said so. */
  keepMine(currentVersion: number): void {
    this.version = currentVersion
    this.current = null
    this.state = "dirty"
    this.retry()
  }

  /** Conflict panel "See the newer one": the editor now shows `row`. My words are dropped here. */
  takeTheirs(row: Row): void {
    this.clearAll()
    this.pending = null
    this.unconfirmed = null
    this.current = null
    if (typeof row.version === "number") this.version = row.version
    this.state = "clean"
    this.emit()
    this.settle()
  }

  /** "Throw mine away" / "Throw it away". */
  discard(): void {
    this.clearAll()
    this.pending = null
    this.unconfirmed = null
    this.current = null
    this.state = "clean"
    this.emit()
    this.settle()
  }

  /** A save made somewhere else (like "Save mine as a new note") now owns this editor. */
  adopt(row: Row): void {
    this.clearAll()
    this.pending = null
    this.unconfirmed = null
    this.current = null
    this.itemId = typeof row.id === "string" ? row.id : this.itemId
    if (typeof row.version === "number") this.version = row.version
    this.savedAt = this.opts.env.now()
    this.state = "saved"
    this.emit()
    this.settle()
  }

  dispose(): void {
    this.disposed = true
    this.clearAll()
    this.stopWake()
    this.settle()
  }

  // ------------------------------------------------------------------ internals

  private hasWork(): boolean {
    return this.pending !== null || this.unconfirmed !== null || this.inFlight
  }

  private isSafe(): boolean {
    return (this.state === "clean" || this.state === "saved") && !this.hasWork()
  }

  private emit(): void {
    this.opts.onChange?.(this.getSnapshot())
  }

  /** Resolves flush() callers once nothing is in flight (patient ones: once no retry is waiting either). */
  private settle(): void {
    if (this.inFlight) return
    const waiting = this.state === "dirty" && this.pending !== null && this.retryTimer === null && !this.retryPaused
    if (waiting) return
    const retrying = !this.disposed && (this.retryTimer !== null || this.retryPaused)
    const saved = this.isSafe()
    const ready = this.waiters.filter((waiter) => !(waiter.patient && retrying))
    this.waiters = this.waiters.filter((waiter) => waiter.patient && retrying)
    ready.forEach((waiter) => waiter.resolve(saved))
  }

  private schedule(): void {
    this.clearDebounce()
    this.debounceTimer = this.opts.env.setTimeout(() => {
      this.debounceTimer = null
      if (this.retryTimer === null && !this.retryPaused && this.state !== "offline") void this.run()
    }, this.opts.debounceMs)
  }

  private clearDebounce(): void {
    if (this.debounceTimer !== null) this.opts.env.clearTimeout(this.debounceTimer)
    this.debounceTimer = null
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) this.opts.env.clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.retryPaused = false
  }

  private clearAll(): void {
    this.clearDebounce()
    this.clearRetry()
    if (this.slowTimer !== null) this.opts.env.clearTimeout(this.slowTimer)
    this.slowTimer = null
    this.slow = false
  }

  /** Puts words that did not make it back in front of the queue (newer words still win). */
  private restorePending(): void {
    if (this.unconfirmed === null) return
    const older = this.unconfirmed
    this.unconfirmed = null
    this.pending = this.pending === null ? older : this.opts.merge ? this.opts.merge(older, this.pending) : this.pending
  }

  private async run(): Promise<void> {
    if (this.disposed || this.inFlight) return
    this.restorePending()
    if (this.pending === null) {
      this.settle()
      return
    }
    const content = this.pending
    this.pending = null
    this.unconfirmed = content
    this.inFlight = true
    this.retryPaused = false
    this.state = "saving"
    this.message = null
    if (this.slowTimer === null && !this.slow) {
      this.slowTimer = this.opts.env.setTimeout(() => {
        this.slowTimer = null
        if (this.state === "saving") {
          this.slow = true
          this.emit()
        }
      }, SLOW_AFTER_MS)
    }
    this.emit()
    const request: SaveRequest<C> = {
      content,
      mode: this.itemId === null ? "create" : "update",
      itemId: this.itemId,
      expectedVersion: this.itemId === null ? null : this.version,
      createKey: this.itemId === null ? this.createKey : null,
    }
    let reply: SaveReply<Row>
    try {
      reply = await this.opts.send(request)
    } catch {
      reply = { kind: "network" }
    }
    this.inFlight = false
    if (this.disposed) {
      this.settle()
      return
    }
    this.handle(reply, request)
  }

  private stopSlow(): void {
    if (this.slowTimer !== null) this.opts.env.clearTimeout(this.slowTimer)
    this.slowTimer = null
    this.slow = false
  }

  private handle(reply: SaveReply<Row>, request: SaveRequest<C>): void {
    if (reply.kind === "ok") {
      const row = reply.row
      if (!row || typeof row.version !== "number") {
        // A 2xx without a version is not proof the words are stored: never say "Saved".
        this.fail("We couldn't check that your work was saved.")
        return
      }
      this.stopSlow()
      this.unconfirmed = null
      this.attempt = 0
      this.version = row.version
      if (request.mode === "create") {
        this.itemId = typeof row.id === "string" ? row.id : this.itemId
        // A 200 here is a replay: the first copy landed earlier, and the server answers with
        // the row as it is NOW. If it lacks the words we just sent, send ours as an update,
        // checked against version 1 (the version a create makes), never the replayed row's
        // version: if the item was edited since (another tab with the same key, say), that
        // is a 409 and the conflict panel, not a quiet overwrite.
        if (reply.status === 200 && this.opts.rowHas && !this.opts.rowHas(row, request.content)) {
          this.pending = this.pending ?? request.content
          this.version = 1
        }
      }
      this.savedAt = this.opts.env.now()
      this.opts.onSaved?.(row, request.content)
      if (this.pending !== null) {
        this.state = "dirty"
        this.emit()
        void this.run()
        return
      }
      this.state = "saved"
      this.emit()
      this.settle()
      return
    }

    this.stopSlow()
    if (reply.kind === "signed_out") return this.stop("signed_out")
    if (reply.kind === "network") {
      if (!this.opts.env.isOnline()) return this.stop("offline")
      return this.retryLater(null, "saving")
    }
    const code = errorCode(reply.data)
    if (reply.status === 401) return this.stop("signed_out")
    if (reply.status === 409 && code === "edit_conflict") {
      const current = (reply.data as { current?: Row } | null)?.current ?? null
      this.current = current
      return this.stop("conflict")
    }
    if (reply.status === 404) return this.stop("gone")
    if (reply.status === 503 && code?.startsWith("maintenance_")) return this.retryLater(retryAfterMs(reply), "maintenance")
    if (RETRYABLE_STATUS.has(reply.status) || (reply.status === 409 && code === "progress_busy")) {
      return this.retryLater(retryAfterMs(reply), "saving")
    }
    // A server error's own words are technical: only a 4xx explains itself in plain words.
    this.fail(reply.status >= 500 ? null : plainDetail(reply.data))
  }

  /** Stops here until the student (or the browser coming back online) acts. Words are kept. */
  private stop(state: SaveState): void {
    this.restorePending()
    this.state = state
    this.emit()
    this.settle()
  }

  private fail(message: string | null): void {
    this.stopSlow()
    this.restorePending()
    this.state = "failed"
    this.message = message
    this.emit()
    this.settle()
  }

  private retryLater(waitMs: number | null, state: "saving" | "maintenance"): void {
    this.restorePending()
    if (this.attempt >= RETRY_WAITS_MS.length) {
      if (state === "maintenance") {
        // Out of tries during a break: stay on the break message, keep the words.
        this.state = "maintenance"
        this.emit()
        this.settle()
        return
      }
      this.fail(null)
      return
    }
    const wait = waitMs ?? RETRY_WAITS_MS[this.attempt]
    this.attempt += 1
    this.state = state
    this.slow = state === "saving"
    if (this.opts.env.isHidden()) {
      this.retryPaused = true
    } else {
      this.retryTimer = this.opts.env.setTimeout(() => {
        this.retryTimer = null
        if (this.opts.env.isHidden()) {
          this.retryPaused = true
          return
        }
        void this.run()
      }, wait)
    }
    this.emit()
    // Leaving a page doesn't wait while we back off: tell it the work isn't saved yet.
    this.settle()
  }

  private wake(reason: "online" | "visible"): void {
    if (this.disposed || this.inFlight) return
    if (reason === "online" && (this.state === "offline" || this.retryTimer !== null || this.retryPaused)) {
      this.clearRetry()
      void this.run()
      return
    }
    if (reason === "visible" && this.retryPaused) {
      this.retryPaused = false
      void this.run()
    }
  }
}
