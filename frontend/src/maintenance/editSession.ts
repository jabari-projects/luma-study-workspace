// CONTRACT owned by the maintenance track. Editors call beginEditing() once when they open.
export type EditSession = {
  allowed: boolean
  message: string | null
  headers: () => Record<string, string>
}
export async function beginEditing(): Promise<EditSession> {
  return { allowed: true, message: null, headers: () => ({}) }
}
