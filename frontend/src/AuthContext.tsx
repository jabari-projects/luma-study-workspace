import { AxiosError } from "axios"
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react"
import type { ReactNode } from "react"

import { AuthContext } from "./auth"
import {
  api,
  clearStoredSession,
  readStoredSession,
  signupWithBackend,
  writeStoredSession,
} from "./api"
import type { AuthContextValue, LoginInput, SignupInput, VerifyEmailInput } from "./auth"
import type { AuthSession, Profile, StoredAuthSession } from "./api"

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<StoredAuthSession | null>(() => readStoredSession())
  const [loading, setLoading] = useState(true)

  const persistSession = useCallback((nextSession: StoredAuthSession | null) => {
    setSession(nextSession)
    if (nextSession) {
      writeStoredSession(nextSession)
    } else {
      clearStoredSession()
    }
  }, [])

  const refreshProfile = useCallback(async () => {
    if (!readStoredSession()) {
      persistSession(null)
      return
    }

    const response = await api.get<Profile>("/me/profile")
    const current = readStoredSession()
    if (!current) {
      persistSession(null)
      return
    }

    persistSession({
      accessToken: current.accessToken,
      user: response.data,
    })
  }, [persistSession])

  useEffect(() => {
    let active = true

    async function hydrate() {
      const stored = readStoredSession()
      if (!stored) {
        if (active) {
          setLoading(false)
        }
        return
      }

      try {
        const response = await api.get<Profile>("/me/profile")
        if (active) {
          persistSession({
            accessToken: stored.accessToken,
            user: response.data,
          })
        }
      } catch (error: unknown) {
        // Only forget the login when the server says it is no longer valid.
        // A network hiccup or a server error keeps the student signed in.
        const status = error instanceof AxiosError ? error.response?.status : undefined
        if (active && (status === 401 || status === 403)) {
          persistSession(null)
        }
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }

    hydrate()

    return () => {
      active = false
    }
  }, [persistSession])

  const login = useCallback(
    async (input: LoginInput) => {
      const response = await api.post<AuthSession>("/login", input)
      persistSession({
        accessToken: response.data.access_token,
        user: response.data.user,
      })

      try {
        await refreshProfile()
      } catch {
        // The login token is valid even when profile hydration is unavailable.
      }
      return response.data.user
    },
    [persistSession, refreshProfile],
  )

  // Signup no longer logs in: the account waits for the emailed code.
  const signup = useCallback(async (input: SignupInput) => signupWithBackend(input), [])

  const verifyEmail = useCallback(
    async (input: VerifyEmailInput) => {
      const response = await api.post<AuthSession>("/auth/verify-email", input)
      persistSession({
        accessToken: response.data.access_token,
        user: { ...response.data.user, email_verified: true },
      })
    },
    [persistSession],
  )

  const logout = useCallback(() => {
    persistSession(null)
  }, [persistSession])

  const setProfile = useCallback(
    (profile: Profile) => {
      if (!session) {
        return
      }

      persistSession({
        accessToken: session.accessToken,
        user: profile,
      })
    },
    [persistSession, session],
  )

  const value = useMemo<AuthContextValue>(
    () => ({
      user: session?.user ?? null,
      accessToken: session?.accessToken ?? null,
      loading,
      isAuthenticated: Boolean(session?.accessToken),
      login,
      signup,
      verifyEmail,
      logout,
      refreshProfile,
      setProfile,
    }),
    [loading, login, logout, refreshProfile, session, setProfile, signup, verifyEmail],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
