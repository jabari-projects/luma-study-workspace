// Explicit "Save" buttons that make a new item (a note from the workbench, a deck or a summary
// from a note, a study plan) keep one Idempotency-Key until the save works. If the first try
// landed but its answer was lost, pressing Save again gets the FIRST row back (a 200 replay).
// The student may have changed the words in between, so a replay is checked here:
// - the row must have a numeric `version` (the server confirmed it, design B.6);
// - when it lacks the words just sent, they are sent as an update checked against version 1
//   (the version a create makes). If someone changed the item since, that is a 409 and nothing
//   is overwritten; the words stay on the page.
// No React or axios here (the transport is passed in), so `node --test` can run it.

export type CreatedRow = { id?: unknown; version?: unknown }

export type CreateTransport<Row> = {
  post: (path: string, body: Record<string, unknown>) => Promise<{ status: number; data: Row }>
  put: (path: string, body: Record<string, unknown>) => Promise<{ status: number; data: Row }>
  /** The HTTP status of a thrown error, or null when it isn't an HTTP answer. */
  statusOf: (error: unknown) => number | null
}

export const NOT_CHECKED_MESSAGE = "We couldn't check that your work was saved. Your work is still here."
export const CHANGED_SINCE_MESSAGE =
  "This was saved before and changed since, so we didn't save over it. Your work is still here."

/** An error whose message is plain words for the student. */
export class CreateNotConfirmedError extends Error {}

function confirmed<Row extends CreatedRow>(row: Row | null | undefined): row is Row {
  return Boolean(row && typeof row.id === "string" && typeof row.version === "number")
}

/**
 * POST `body` to `path` (the transport adds the Idempotency-Key). Resolves with the stored row
 * only once the server confirmed these words. `matches` says whether a row holds the words sent.
 */
export async function createOnce<Row extends CreatedRow>(
  transport: CreateTransport<Row>,
  path: string,
  body: Record<string, unknown>,
  matches: (row: Row) => boolean,
): Promise<Row> {
  const created = await transport.post(path, body)
  const row = created.data
  if (!confirmed(row)) throw new CreateNotConfirmedError(NOT_CHECKED_MESSAGE)
  if (created.status !== 200 || matches(row)) return row

  // A replay with older words: send ours, checked against the version the create made.
  let updated: { status: number; data: Row }
  try {
    updated = await transport.put(`${path}/${row.id as string}`, { ...body, expected_version: 1 })
  } catch (error: unknown) {
    if (transport.statusOf(error) === 409) throw new CreateNotConfirmedError(CHANGED_SINCE_MESSAGE)
    throw error
  }
  if (!confirmed(updated.data)) throw new CreateNotConfirmedError(NOT_CHECKED_MESSAGE)
  return updated.data
}

/** The same text, ignoring spaces at the ends. */
export function sameText(a: unknown, b: unknown): boolean {
  return String(a ?? "").trim() === String(b ?? "").trim()
}

/** Card words (front and back, in order) are the same. Card ids are not compared. */
export function sameCards(stored: unknown, sent: unknown): boolean {
  const words = (cards: unknown) =>
    Array.isArray(cards) ? cards.map((card) => [String(card?.front ?? "").trim(), String(card?.back ?? "").trim()]) : []
  return JSON.stringify(words(stored)) === JSON.stringify(words(sent))
}
