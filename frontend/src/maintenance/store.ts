// What this tab knows about Luma's maintenance break. One small store for every component
// (React reads it with useSyncExternalStore). No network here: observe.ts fills it.

export type MaintenancePhase = "none" | "announced" | "draining" | "active" | "checking"
export type MaintenanceReason = "" | "database_update" | "website_update" | "backup_check" | "other"

export type MaintenanceStatus = {
  phase: MaintenancePhase
  rev: number
  reason: MaintenanceReason
  note: string
  start_at: string | null
  estimated_end_at: string | null
  drain_started_at: string | null
  grace_ends_at: string | null
  recently_reopened: boolean
  server_time: string
}

export type MaintenanceSnapshot = {
  status: MaintenanceStatus | null
  /** When the status was last read from the server (ms since 1970), or null. */
  checkedAt: number | null
  /** The last check failed (we couldn't reach Luma). */
  failed: boolean
  /** A check is running now. */
  checking: boolean
}

const PHASES: MaintenancePhase[] = ["none", "announced", "draining", "active", "checking"]

/** Reads a status body safely; anything odd becomes null (the UI then shows nothing). */
export function parseStatus(value: unknown): MaintenanceStatus | null {
  if (!value || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  if (typeof v.phase !== "string" || !PHASES.includes(v.phase as MaintenancePhase)) return null
  const text = (key: string) => (typeof v[key] === "string" ? (v[key] as string) : null)
  return {
    phase: v.phase as MaintenancePhase,
    rev: typeof v.rev === "number" ? v.rev : 0,
    reason: (text("reason") ?? "") as MaintenanceReason,
    note: text("note") ?? "",
    start_at: text("start_at"),
    estimated_end_at: text("estimated_end_at"),
    drain_started_at: text("drain_started_at"),
    grace_ends_at: text("grace_ends_at"),
    recently_reopened: v.recently_reopened === true,
    server_time: text("server_time") ?? "",
  }
}

/** A response told us the state is at `headerRev`: do we need to read the status again? */
export function needsRefresh(known: MaintenanceStatus | null, headerRev: number | null, checking: boolean): boolean {
  if (headerRev === null || Number.isNaN(headerRev) || checking) return false
  return known === null || headerRev !== known.rev
}

/** Re-read on focus or when the tab comes back, but not more than once a minute. */
export const FOCUS_RECHECK_MS = 60_000

export function shouldRecheckOnFocus(checkedAt: number | null, now: number): boolean {
  return checkedAt === null || now - checkedAt >= FOCUS_RECHECK_MS
}

/**
 * The status page's own checks while a break is on: 30 s, 60 s, 2 min, 4 min, then stop
 * and show "Check again". This is the bounded exception to the no-polling rule (it ends
 * by itself, and pauses while the tab is hidden); see StatusPage.tsx.
 */
export const STATUS_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000] as const

export function nextBackoff(step: number): number | null {
  return step < STATUS_BACKOFF_MS.length ? STATUS_BACKOFF_MS[step] : null
}

/** True while a break is close or on (the status page then checks again by itself). */
export function breakIsOn(status: MaintenanceStatus | null): boolean {
  return Boolean(status && (status.phase === "draining" || status.phase === "active" || status.phase === "checking"))
}

type Listener = () => void

let snapshot: MaintenanceSnapshot = { status: null, checkedAt: null, failed: false, checking: false }
const listeners = new Set<Listener>()

export function getMaintenanceSnapshot(): MaintenanceSnapshot {
  return snapshot
}

export function subscribeMaintenance(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function updateMaintenance(change: Partial<MaintenanceSnapshot>): void {
  snapshot = { ...snapshot, ...change }
  for (const listener of [...listeners]) listener()
}

/** Tests only: start from nothing. */
export function resetMaintenanceForTests(): void {
  snapshot = { status: null, checkedAt: null, failed: false, checking: false }
  listeners.clear()
}
