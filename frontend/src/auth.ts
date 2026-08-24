import { createContext, useContext } from "react"

import type { BasicUser, Profile } from "./api"

export type SignupInput = {
  email: string
  username: string
  password: string
}

export type LoginInput = {
  email: string
  password: string
}

export type AuthContextValue = {
  user: Profile | BasicUser | null
  accessToken: string | null
  loading: boolean
  isAuthenticated: boolean
  login: (input: LoginInput) => Promise<void>
  signup: (input: SignupInput) => Promise<void>
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
