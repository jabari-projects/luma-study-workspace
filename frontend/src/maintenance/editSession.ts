// CONTRACT owned by the maintenance track. Editors call beginEditing() once when they open.
//
// Outside a break this asks the server for an edit-session token. While Luma gets ready for
// a break (draining), only editors that opened BEFORE the drain began may still save, for a
// few minutes; their saves carry the token in X-Luma-Edit-Session. New editors are told that
// new work can't start right now. The server makes every one of these decisions again.
import { AxiosError } from "axios"

import { getMaintenanceSnapshot } from "./store"
import { startEditSession } from "./maintenance-api"

export type EditSession = {
  allowed: boolean
  message: string | null
  headers: () => Record<string, string>
}

export const NEW_WORK_BLOCKED_MESSAGE = "New work can't start right now."

const noHeaders = () => ({})

export async function beginEditing(): Promise<EditSession> {
  const phase = getMaintenanceSnapshot().status?.phase
  if (phase === "draining" || phase === "active" || phase === "checking") {
    return { allowed: false, message: NEW_WORK_BLOCKED_MESSAGE, headers: noHeaders }
  }
  try {
    const { token } = await startEditSession()
    return { allowed: true, message: null, headers: () => ({ "X-Luma-Edit-Session": token }) }
  } catch (error: unknown) {
    const code = error instanceof AxiosError ? (error.response?.data as { error_code?: string } | undefined)?.error_code : undefined
    if (code === "maintenance_draining" || code === "maintenance_active") {
      return { allowed: false, message: NEW_WORK_BLOCKED_MESSAGE, headers: noHeaders }
    }
    // Offline or signed out: editing can still start. The token only matters during a
    // drain, and the server refuses saves without it then (the editor keeps the text).
    return { allowed: true, message: null, headers: noHeaders }
  }
}
