import { useEffect, useState } from "react"

import { useAuth } from "../auth"
import { SIGN_IN_AGAIN_EVENT } from "./leave"
import { SignInAgainDialog } from "./SignInAgainDialog"

/**
 * Opens the sign-in-again box while this tab holds unsaved work and its account can't save:
 * the sign-in ended (expired), it was signed out in another tab (held), or a "Sign in" button
 * on a save line asked for an expired account.
 */
export function SignInAgainHost() {
  const { isAuthenticated, signedOutElsewhere, activeAccount, accounts } = useAuth()
  const [asked, setAsked] = useState<string | null>(null)

  useEffect(() => {
    const onAsk = (event: Event) => {
      const id = (event as CustomEvent<{ accountId?: string | null }>).detail?.accountId
      setAsked(typeof id === "string" ? id : null)
    }
    window.addEventListener(SIGN_IN_AGAIN_EVENT, onAsk)
    return () => window.removeEventListener(SIGN_IN_AGAIN_EVENT, onAsk)
  }, [])

  let target: { id: string; email: string; username: string; reason: "expired" | "elsewhere" } | null = null
  if (signedOutElsewhere?.held && signedOutElsewhere.id) {
    target = {
      id: signedOutElsewhere.id,
      email: signedOutElsewhere.email ?? "",
      username: signedOutElsewhere.username,
      reason: "elsewhere",
    }
  } else if (!isAuthenticated && activeAccount) {
    target = { id: activeAccount.id, email: activeAccount.email, username: activeAccount.username, reason: "expired" }
  } else if (asked) {
    const account = accounts.find((item) => item.id === asked && item.status === "expired")
    if (account) target = { id: account.id, email: account.email, username: account.username, reason: "expired" }
  }

  if (!target) return null
  return <SignInAgainDialog key={`${target.id}-${target.reason}`} account={target} reason={target.reason} />
}
