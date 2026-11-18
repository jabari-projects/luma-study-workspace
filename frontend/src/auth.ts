import { createContext, useContext } from "react"

import type { AccountStatus } from "./accounts"
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

export type AccountSummary = {
  id: string
  username: string
  email: string
  status: AccountStatus
  /** The account this tab is using. */
  isActive: boolean
  /** First signed in on this device: the only one that can use the AI chat. */
  isChatbot: boolean
}

export type AuthContextValue = {
  /** This tab's account while it is signed in. */
  user: Profile | BasicUser | null
  accessToken: string | null
  loading: boolean
  /** A log in is still fetching this tab's account profile (its theme comes with it). */
  profileLoading: boolean
  /** This tab's account exists and is signed in. */
  isAuthenticated: boolean
  /** Every account saved on this device, oldest sign-in first. */
  accounts: AccountSummary[]
  activeAccountId: string | null
  /** This tab's account, which may be "expired". */
  activeAccount: AccountSummary | null
  chatbotAccountId: string | null
  isChatbotAccount: boolean
  canAddAccount: boolean
  /**
   * Set when this tab's account was signed out in another tab. `held` means this tab still has
   * unsaved work for that account, so the page stays open with the sign-in-again box.
   */
  signedOutElsewhere: SignedOutElsewhereInfo | null
  /** Logs in (adds or refreshes an account) and binds this tab to it. Check user.email_verified. */
  login: (input: LoginInput) => Promise<{ user: BasicUser; alreadyListed: boolean }>
  /** Starts an account. No session yet: the emailed code logs the user in. */
  signup: (input: SignupInput) => Promise<SignupPending>
  /** Checks an emailed code; on success the user is logged in and verified. */
  verifyEmail: (input: VerifyEmailInput) => Promise<void>
  switchAccount: (id: string) => void
  /** Signs out of this tab's account. */
  logout: () => void
  /** Signs out of one account. Returns the account this tab uses next, if any. */
  logoutAccount: (id: string) => { nextId: string | null }
  logoutAll: () => void
  /** Reloads the profile of one account (this tab's account by default). */
  refreshProfile: (id?: string) => Promise<void>
  setProfile: (profile: Profile) => void
  dismissSignedOutElsewhere: () => void
  /**
   * Signs the same account in again without leaving the page (its sign-in ended, or it was
   * signed out in another tab while this tab had unsaved work). Refuses a different account.
   */
  signInAgain: (accountId: string, email: string, password: string) => Promise<void>
}

export type SignedOutElsewhereInfo = {
  username: string
  id?: string
  email?: string
  held?: boolean
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
