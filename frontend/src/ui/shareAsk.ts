// "Share with the crowd?" is asked once, right after a student makes a deck, note or summary.
// Memory only: per tab and per account. A reload or another tab never asks again, and nothing
// is stored anywhere. No window or React here, so `node --test` can run it.

/** Same as StudyType in ui/common.tsx (kept here so `node --test` needs no JSX). */
type StudyType = "note" | "flashcards" | "summary"

const justMade = new Set<string>()

const keyOf = (accountId: string | null | undefined, kind: StudyType, id: string) => `${accountId ?? ""}|${kind}|${id}`

/** Call right after a create succeeds. The item's page then asks once. */
export function markJustMade(accountId: string | null | undefined, kind: StudyType, id: string): void {
  justMade.add(keyOf(accountId, kind, id))
}

/** True when this item was just made in this tab and hasn't asked yet. Reading changes nothing. */
export function shouldAskToShare(accountId: string | null | undefined, kind: StudyType, id: string | null | undefined): boolean {
  return Boolean(id) && justMade.has(keyOf(accountId, kind, id as string))
}

/** The page has asked (or decided not to): never ask about this item again in this tab. */
export function forgetShareAsk(accountId: string | null | undefined, kind: StudyType, id: string | null | undefined): void {
  if (id) justMade.delete(keyOf(accountId, kind, id))
}
