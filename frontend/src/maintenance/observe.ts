// How this tab learns about a maintenance break, without endless polling (owner rule):
// - once when the app opens;
// - when any API answer carries a different X-Luma-Maintenance-Rev than we know
//   (every answer from the server has it, errors included);
// - on focus, or when the tab is shown again, if the last check is over a minute old.
// Imported once from main.tsx. Nothing here ever navigates, reloads or signs anyone out.
import { useSyncExternalStore } from "react"
import { AxiosError } from "axios"
import type { AxiosResponse } from "axios"

import { api } from "../api"
import { fetchMaintenanceStatus } from "./maintenance-api"
import {
  getMaintenanceSnapshot,
  needsRefresh,
  shouldRecheckOnFocus,
  subscribeMaintenance,
  updateMaintenance,
} from "./store"
import type { MaintenanceSnapshot } from "./store"

let inFlight: Promise<void> | null = null

/** Reads the status once (calls made while one is running share it). */
export function checkMaintenanceNow(): Promise<void> {
  if (inFlight) return inFlight
  updateMaintenance({ checking: true })
  inFlight = fetchMaintenanceStatus()
    .then(
      (status) => updateMaintenance({ status, checkedAt: Date.now(), failed: false, checking: false }),
      () => updateMaintenance({ checkedAt: Date.now(), failed: true, checking: false }),
    )
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

function headerRev(response: AxiosResponse | undefined): number | null {
  const raw = response?.headers?.["x-luma-maintenance-rev"]
  if (typeof raw !== "string" || raw === "") return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function noticeRev(response: AxiosResponse | undefined): void {
  const snap = getMaintenanceSnapshot()
  // After a failed check, wait a minute before trying again because of a header.
  if (snap.failed && !shouldRecheckOnFocus(snap.checkedAt, Date.now())) return
  if (needsRefresh(snap.status, headerRev(response), inFlight !== null)) {
    void checkMaintenanceNow()
  }
}

api.interceptors.response.use(
  (response) => {
    noticeRev(response)
    return response
  },
  (error: unknown) => {
    if (error instanceof AxiosError) noticeRev(error.response)
    return Promise.reject(error)
  },
)

function onFocus(): void {
  if (document.visibilityState === "hidden") return
  if (shouldRecheckOnFocus(getMaintenanceSnapshot().checkedAt, Date.now())) {
    void checkMaintenanceNow()
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("focus", onFocus)
  document.addEventListener("visibilitychange", onFocus)
  void checkMaintenanceNow()
}

export function useMaintenance(): MaintenanceSnapshot {
  return useSyncExternalStore(subscribeMaintenance, getMaintenanceSnapshot, getMaintenanceSnapshot)
}
