// CONTRACT owned by the student-work track. Counts are for this tab only.
export type UnsavedSummary = { unsaved: number; saving: number; failed: number }
export function getUnsavedSummary(): UnsavedSummary {
  return { unsaved: 0, saving: 0, failed: 0 }
}
export function subscribeUnsaved(listener: () => void): () => void {
  void listener
  return () => {}
}
export function hasUnsavedWork(): boolean {
  return false
}
export function copyUnsavedText(): string {
  return ""
}
