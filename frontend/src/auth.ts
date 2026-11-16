import { createContext, useContext } from "react"

import type { BasicUser, Profile, SignupPending } from "./api"

export type SignupInput = {
  email: string
  username: string
  password: string
}

export type LoginInput = {
  email: string
  password: string
}

export type VerifyEmailInput = {
  code: string
  /** Pending signup: the email and this browser's ticket. Logged in: leave both out. */
  email?: string
  ticket?: string
}

export type AuthContextValue = {
  user: Profile | BasicUser | null
  accessToken: string | null
  loading: boolean
  isAuthenticated: boolean
  /** Logs in and returns the user (check email_verified). */
  login: (input: LoginInput) => Promise<BasicUser>
  /** Starts an account. No session yet: the emailed code logs the user in. */
  signup: (input: SignupInput) => Promise<SignupPending>
  /** Checks an emailed code; on success the user is logged in and verified. */
  verifyEmail: (input: VerifyEmailInput) => Promise<void>
  logout: () => void
  refreshProfile: () => Promise<void>
  setProfile: (profile: Profile) => void
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined)

function isProfile(user: Profile | BasicUser | null): user is Profile {
  return Boolean(user && "subscription_status" in user)
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) {
    throw new Error("useAuth must be used inside AuthProvider.")
  }

  return value
}

export function useProfile(): Profile | null {
  const { user } = useAuth()
  return isProfile(user) ? user : null
}
