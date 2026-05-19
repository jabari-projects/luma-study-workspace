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
  writeStoredSession,
} from "./api"
import type { AuthContextValue, LoginInput, SignupInput } from "./auth"
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
      } catch {
        if (active) {
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
    },
    [persistSession, refreshProfile],
  )

  const signup = useCallback(
    async (input: SignupInput) => {
      const response = await api.post<AuthSession>("/signup", input)
      persistSession({
        accessToken: response.data.access_token,
        user: response.data.user,
      })

      try {
        await refreshProfile()
      } catch {
        // The signup session is still useful if optional profile hydration fails.
      }
    },
    [persistSession, refreshProfile],
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
      logout,
      refreshProfile,
      setProfile,
    }),
    [loading, login, logout, refreshProfile, session, setProfile, signup],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
