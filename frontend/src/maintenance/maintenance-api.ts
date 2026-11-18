// Calls to the maintenance routes (backend/app/maintenance.py). The status is public; the
// /admin/maintenance routes are for admins only and the server checks that every time.
import { api } from "../api"
import { parseStatus } from "./store"
import type { MaintenancePhase, MaintenanceReason, MaintenanceStatus } from "./store"

export async function fetchMaintenanceStatus(): Promise<MaintenanceStatus | null> {
  // No sign-in needed (lumaAuth "none"), so this works on /status and the sign-in pages too.
  const response = await api.get("/maintenance/status", { lumaAuth: "none", timeout: 15_000 })
  return parseStatus(response.data)
}

export async function startEditSession(): Promise<{ token: string; issued_at: string }> {
  const response = await api.post<{ token: string; issued_at: string }>("/maintenance/edit-session", null, { timeout: 15_000 })
  return response.data
}

export type SafetyReason =
  | { code: "grace_not_over"; seconds_left: number }
  | { code: "jobs_running"; count: number }
  | { code: "requests_in_flight"; count: number }
  | { code: "instance_silent"; count: number }
  | { code: "backup_missing" }
  | { code: "database_unreachable" }

export type CheckResult = { name: string; passed: boolean; detail: Record<string, unknown> }

export type AdminView = {
  status: MaintenanceStatus
  state: {
    phase: MaintenancePhase
    rev: number
    reason: MaintenanceReason
    note: string
    start_at: string | null
    estimated_end_at: string | null
    drain_started_at: string | null
    grace_ends_at: string | null
    activated_at: string | null
    backup_ref: string | null
    counts_at_activation: Record<string, number> | null
    checks: { ran_at: string; results: CheckResult[] } | null
    checks_passed_at: string | null
    reopened_at: string | null
  }
  instances: Array<{
    instance: string
    this_one: boolean
    in_flight: number
    heartbeat_age_seconds: number | null
    phase_seen: string | null
    code_version: string
  }>
  jobs: { running: number; stale: number; by_kind: Record<string, number> }
  log: Array<{ at: string | null; action: string; from_phase: string | null; to_phase: string | null; detail: Record<string, unknown> }>
  safety?: SafetyReason[]
  partial: boolean
  server_time: string
}

export async function loadAdminView(): Promise<AdminView> {
  const response = await api.get<AdminView>("/admin/maintenance", { timeout: 20_000 })
  return response.data
}

export type AdminAction = "schedule" | "postpone" | "cancel" | "drain" | "activate" | "checks" | "reopen"

export async function adminAction(action: AdminAction, body: Record<string, unknown>): Promise<AdminView> {
  // Checks run several database reads in a row, so they get a little longer.
  const response = await api.post<AdminView>(`/admin/maintenance/${action}`, body, { timeout: action === "checks" ? 60_000 : 20_000 })
  return response.data
}
