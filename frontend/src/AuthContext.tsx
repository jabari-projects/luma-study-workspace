import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { ReactNode } from "react"

import { AuthContext } from "./auth"
import {
  ACCOUNT_EXPIRED_EVENT,
  AUTH_STORAGE_KEY,
  api,
  clearAllStoredSessions,
  getTabAccountId,
  readBook,
  removeStoredAccount,
  setTabAccountId,
  signupWithBackend,
  writeBook,
  writeStoredSession,
} from "./api"
import {
  AccountLimitError,
  MAX_ACCOUNTS,
  canAdd,
  chatbotAccountId as findChatbotAccountId,
  orderedAccounts,
  pickActive,
  updateUser,
} from "./accounts"
import type { AccountBook } from "./accounts"
import type { AccountSummary, AuthContextValue, LoginInput, SignupInput, VerifyEmailInput } from "./auth"
import type { AuthSession, Profile } from "./api"

type AuthState = {
  book: AccountBook
  tabId: string | null
}

type StartState = AuthState & { lostBinding: boolean }

// A fresh tab picks the last account used on this device. A reloaded tab keeps its own.
// A reloaded or restored tab whose account was signed out while it was asleep shows the
// "signed out" notice instead of quietly opening another account.
function initialState(): StartState {
  const book = readBook()
  const saved = getTabAccountId()
  const { id, lostBinding } = pickActive(book, saved, saved !== null)
  if (id !== saved) {
    setTabAccountId(id)
  }
  return { book: readBook(), tabId: id, lostBinding }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [start] = useState<StartState>(initialState)
  const [state, setState] = useState<AuthState>(() => ({ book: start.book, tabId: start.tabId }))
  const [loading, setLoading] = useState(true)
  /** The account whose profile a log in is fetching right now. */
  const [profileLoadingId, setProfileLoadingId] = useState<string | null>(null)
  const [signedOutElsewhere, setSignedOutElsewhere] = useState<{ username: string } | null>(() =>
    // The account is gone from the book, so its name is unknown.
    start.lostBinding ? { username: "This account" } : null,
  )
  const stateRef = useRef(state)
  const signedOutRef = useRef(signedOutElsewhere)

  useEffect(() => {
    stateRef.current = state
    signedOutRef.current = signedOutElsewhere
  }, [state, signedOutElsewhere])

  /** Re-reads the saved accounts after a write made in this tab. */
  const resync = useCallback(() => {
    const next = { book: readBook(), tabId: getTabAccountId() }
    stateRef.current = next
    setState(next)
  }, [])

  // Another tab changed the saved accounts.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== AUTH_STORAGE_KEY) {
        return
      }
      const previous = stateRef.current
      const book = readBook()
      const tabId = getTabAccountId()
      if (tabId) {
        const pick = pickActive(book, tabId, true)
        if (pick.lostBinding) {
          // Show a notice instead of quietly moving this tab to someone else.
          const username = previous.book.accounts[tabId]?.user.username ?? "This account"
          setTabAccountId(null)
          setSignedOutElsewhere({ username })
        }
      } else if (!signedOutRef.current) {
        const pick = pickActive(book, null, false)
        if (pick.id) {
          setTabAccountId(pick.id)
        }
      }
      resync()
    }
    const onExpired = () => resync()
    window.addEventListener("storage", onStorage)
    window.addEventListener(ACCOUNT_EXPIRED_EVENT, onExpired)
    return () => {
      window.removeEventListener("storage", onStorage)
      window.removeEventListener(ACCOUNT_EXPIRED_EVENT, onExpired)
    }
  }, [resync])

  /** Loads one account's profile with that account's own token. A 401 marks it expired. */
  const refreshProfile = useCallback(
    async (id?: string) => {
      const targetId = id ?? getTabAccountId()
      if (!targetId) {
        return
      }
      const account = readBook().accounts[targetId]
      if (!account || account.status !== "signed_in") {
        return
      }
      const sentToken = account.accessToken
      const response = await api.get<Profile>("/me/profile", { lumaAccountId: targetId })
      writeBook(updateUser(readBook(), targetId, response.data, sentToken))
      resync()
    },
    [resync],
  )

  useEffect(() => {
    let active = true

    async function hydrate() {
      const tabId = getTabAccountId()
      try {
        await refreshProfile(tabId ?? undefined)
      } catch {
        // A 401 already marked the account expired. Network or server errors keep it.
      } finally {
        if (active) {
          setLoading(false)
        }
      }

      // Then check the other accounts one at a time, so the menu shows who must sign in again.
      for (const account of orderedAccounts(readBook())) {
        if (!active) {
          return
        }
        if (account.id === tabId || account.status !== "signed_in") {
          continue
        }
        try {
          await refreshProfile(account.id)
        } catch {
          // Same rules as above.
        }
      }
    }

    void hydrate()

    return () => {
      active = false
    }
  }, [refreshProfile])

  const login = useCallback(
    async (input: LoginInput) => {
      if (!canAdd(readBook(), input.email)) {
        throw new AccountLimitError()
      }
      const response = await api.post<AuthSession>("/login", input, { lumaAuth: "none" })
      const user = response.data.user
      const alreadyListed = Boolean(readBook().accounts[user.id])
      writeStoredSession({ accessToken: response.data.access_token, user })
      setSignedOutElsewhere(null)
      // While the profile loads, the app waits on its loading screen instead of drawing
      // the dashboard in Light for a student who picked Dark (see AppLayout).
      setProfileLoadingId(user.id)
      resync()

      try {
        await refreshProfile(user.id)
      } catch {
        // The login token is valid even when profile hydration is unavailable.
      } finally {
        setProfileLoadingId((current) => (current === user.id ? null : current))
      }
      return { user, alreadyListed }
    },
    [refreshProfile, resync],
  )

  // Signup no longer logs in: the account waits for the emailed code.
  const signup = useCallback(async (input: SignupInput) => signupWithBackend(input), [])

  const verifyEmail = useCallback(
    async (input: VerifyEmailInput) => {
      let response
      if (input.ticket) {
        // A new account from a signup in this tab. It is added next to the others.
        if (!canAdd(readBook(), input.email ?? "")) {
          throw new AccountLimitError()
        }
        response = await api.post<AuthSession>("/auth/verify-email", input, { lumaAuth: "none" })
      } else {
        const tabId = getTabAccountId()
        if (!tabId) {
          throw new Error("Please log in first, then enter your code.")
        }
        response = await api.post<AuthSession>("/auth/verify-email", { code: input.code }, { lumaAccountId: tabId })
        if (response.data.user.id !== tabId) {
          throw new Error("That code is for a different account.")
        }
      }
      writeStoredSession({
        accessToken: response.data.access_token,
        user: { ...response.data.user, email_verified: true },
      })
      setSignedOutElsewhere(null)
      resync()
    },
    [resync],
  )

  const switchAccount = useCallback(
    (id: string) => {
      if (!readBook().accounts[id]) {
        return
      }
      setTabAccountId(id)
      setSignedOutElsewhere(null)
      resync()
    },
    [resync],
  )

  const logoutAccount = useCallback(
    (id: string) => {
      const wasTabAccount = id === getTabAccountId()
      removeStoredAccount(id)
      if (wasTabAccount) {
        const rest = orderedAccounts(readBook())
        const next = rest.find((account) => account.status === "signed_in") ?? rest[0]
        setTabAccountId(next?.id ?? null)
      }
      resync()
      return { nextId: getTabAccountId() }
    },
    [resync],
  )

  const logout = useCallback(() => {
    const id = getTabAccountId()
    if (id) {
      logoutAccount(id)
    }
  }, [logoutAccount])

  const logoutAll = useCallback(() => {
    clearAllStoredSessions()
    setSignedOutElsewhere(null)
    resync()
  }, [resync])

  // Never writes a token, so a late answer can't put an old token back.
  const setProfile = useCallback(
    (profile: Profile) => {
      writeBook(updateUser(readBook(), profile.id, profile))
      resync()
    },
    [resync],
  )

  const dismissSignedOutElsewhere = useCallback(() => setSignedOutElsewhere(null), [])

  const value = useMemo<AuthContextValue>(() => {
    const { book, tabId } = state
    const chatbotId = findChatbotAccountId(book)
    const accounts: AccountSummary[] = orderedAccounts(book).map((account) => ({
      id: account.id,
      username: account.user.username || account.user.email,
      email: account.user.email,
      status: account.status,
      isActive: account.id === tabId,
      isChatbot: account.id === chatbotId,
    }))
    const active = tabId ? book.accounts[tabId] : undefined
    const signedIn = active?.status === "signed_in" && Boolean(active.accessToken)
    return {
      user: signedIn && active ? active.user : null,
      accessToken: signedIn && active ? active.accessToken : null,
      loading,
      profileLoading: Boolean(tabId && tabId === profileLoadingId),
      isAuthenticated: signedIn,
      accounts,
      activeAccountId: active ? tabId : null,
      activeAccount: accounts.find((account) => account.isActive) ?? null,
      chatbotAccountId: chatbotId,
      isChatbotAccount: Boolean(tabId && tabId === chatbotId),
      canAddAccount: accounts.length < MAX_ACCOUNTS,
      signedOutElsewhere,
      login,
      signup,
      verifyEmail,
      switchAccount,
      logout,
      logoutAccount,
      logoutAll,
      refreshProfile,
      setProfile,
      dismissSignedOutElsewhere,
    }
  }, [
    dismissSignedOutElsewhere,
    loading,
    login,
    logout,
    logoutAccount,
    logoutAll,
    profileLoadingId,
    refreshProfile,
    setProfile,
    signedOutElsewhere,
    signup,
    state,
    switchAccount,
    verifyEmail,
  ])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
