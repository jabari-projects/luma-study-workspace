import axios, { AxiosError, AxiosHeaders } from "axios"
import type { AxiosInstance } from "axios"

function normalizeBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim()
  if (!trimmed) {
    throw new Error("VITE_API_BASE_URL is not configured.")
  }
  return trimmed.replace(/\/+$/, "")
}

export const API_BASE_URL = normalizeBaseUrl(import.meta.env.VITE_API_BASE_URL)
export const AUTH_STORAGE_KEY = "luma.auth"

export type BasicUser = {
  id: string
  email: string
  username: string
  email_verified?: boolean
}

export type Profile = BasicUser & {
  display_name?: string | null
  avatar_url?: string | null
  theme_color?: string | null
  custom_theme_image_url?: string | null
  timezone?: string | null
  theme_mode?: string | null
  phone_number?: string | null
  birthday?: string | null
  subscription_status: string
  email_verified: boolean
  is_admin?: boolean
}

export type AuthSession = {
  user: BasicUser
  access_token: string
}

export type StoredAuthSession = {
  accessToken: string
  user: BasicUser | Profile
}

export type SignupPending = {
  status: "check_email"
  email: string
  /** Random value only this browser knows; needed with the emailed code. */
  ticket: string
  resend_after_seconds: number
  code_expires_in_seconds: number
}

export type SignupPayload = {
  email: string
  username: string
  password: string
}

type ApiValidationError = {
  msg?: string
}

type ApiErrorPayload = {
  detail?: string | ApiValidationError[]
  error?: string
  message?: string
  error_code?: string
  retry_after?: number
}

const CANT_REACH_MESSAGE = "We can't reach Luma right now. Try again in a minute."

export class ApiRequestError extends Error {
  status: number
  payload?: ApiErrorPayload

  constructor(message: string, status: number, payload?: ApiErrorPayload) {
    super(message)
    this.status = status
    this.payload = payload
  }
}

function errorPayload(error: unknown): ApiErrorPayload | undefined {
  if (error instanceof AxiosError) {
    return error.response?.data as ApiErrorPayload | undefined
  }
  if (error instanceof ApiRequestError) {
    return error.payload
  }
  return undefined
}

/** Stable machine-readable reason from the account routes, e.g. "code_expired". */
export function getErrorCode(error: unknown): string | undefined {
  const code = errorPayload(error)?.error_code
  return typeof code === "string" ? code : undefined
}

/** Seconds to wait before trying again (429 answers), if the server said. */
export function getRetryAfter(error: unknown): number | undefined {
  const value = errorPayload(error)?.retry_after
  return typeof value === "number" && value > 0 ? value : undefined
}

function isMissingRoute(status: number | undefined, data: ApiErrorPayload | undefined): boolean {
  // A 404 with FastAPI's default body means the server we reached doesn't have
  // this route at all (wrong server or an old fake server), not "account not found".
  if (status !== 404) {
    return false
  }
  const detail = typeof data?.detail === "string" ? data.detail : ""
  return detail === "" || detail === "Not Found" || detail === "Not found" || detail.startsWith("Fake server has no route")
}

export const api: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    Accept: "application/json",
  },
})

export function readStoredSession(): StoredAuthSession | null {
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY)
    if (!raw) {
      return null
    }

    const parsed = JSON.parse(raw) as Partial<StoredAuthSession>
    if (
      typeof parsed.accessToken === "string" &&
      parsed.accessToken.trim() &&
      parsed.user &&
      typeof parsed.user.id === "string"
    ) {
      return {
        accessToken: parsed.accessToken,
        user: parsed.user,
      }
    }
  } catch {
    window.localStorage.removeItem(AUTH_STORAGE_KEY)
  }

  return null
}

export function writeStoredSession(session: StoredAuthSession): void {
  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session))
}

export function clearStoredSession(): void {
  window.localStorage.removeItem(AUTH_STORAGE_KEY)
}

export function getStoredAccessToken(): string | null {
  const session = readStoredSession()
  return session?.accessToken ?? null
}

api.interceptors.request.use((config) => {
  const token = getStoredAccessToken()
  const headers = AxiosHeaders.from(config.headers)

  if (token) {
    headers.set("Authorization", `Bearer ${token}`)
  } else {
    headers.delete("Authorization")
  }

  config.headers = headers
  return config
})

// After a password reset, older logins stop working on purpose. When the server says a
// session expired, forget it and send the student to log in again instead of showing errors.
api.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    if (error instanceof AxiosError && error.response?.status === 401) {
      const detail = (error.response.data as { detail?: unknown } | undefined)?.detail
      const onLoginPage = window.location.pathname.startsWith("/login")
      if (typeof detail === "string" && detail.startsWith("Session expired") && getStoredAccessToken() && !onLoginPage) {
        clearStoredSession()
        window.location.assign("/login?expired=1")
      }
    }
    return Promise.reject(error)
  },
)

export function getErrorMessage(error: unknown, fallback = "Something went wrong."): string {
  if (error instanceof AxiosError) {
    if (!error.response) {
      return CANT_REACH_MESSAGE
    }

    const data = error.response.data as ApiErrorPayload | undefined
    if (isMissingRoute(error.response.status, data)) {
      return CANT_REACH_MESSAGE
    }
    if (typeof data?.detail === "string" && data.detail) {
      return data.detail
    }

    if (Array.isArray(data?.detail)) {
      const firstMessage = data.detail.find((item) => typeof item.msg === "string" && item.msg)
      if (firstMessage?.msg) {
        return firstMessage.msg
      }
    }

    if (typeof data?.error === "string" && data.error) {
      return data.error
    }

    if (typeof data?.message === "string" && data.message) {
      return data.message
    }
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
}

export async function signupWithBackend(payload: SignupPayload): Promise<SignupPending> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}/signup`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })
  } catch {
    throw new ApiRequestError(CANT_REACH_MESSAGE, 0)
  }

  if (!response.ok) {
    let data: ApiErrorPayload | undefined
    try {
      data = (await response.json()) as ApiErrorPayload
    } catch {
      // Not JSON; fall back to a plain message below.
    }

    let message = "We couldn't make your account. Try again."
    if (isMissingRoute(response.status, data)) {
      message = CANT_REACH_MESSAGE
    } else if (typeof data?.detail === "string" && data.detail) {
      message = data.detail
    } else if (Array.isArray(data?.detail)) {
      const first = data.detail.find((item) => typeof item.msg === "string" && item.msg)
      if (first?.msg) {
        message = /email/i.test(first.msg) ? "Check your email address." : first.msg
      }
    } else if (typeof data?.error === "string" && data.error) {
      message = data.error
    }
    throw new ApiRequestError(message, response.status, data)
  }

  return response.json() as Promise<SignupPending>
}

export async function checkBackendHealth(): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/health`, {
    method: "GET",
  })

  if (response.status !== 200) {
    throw new Error(`Luma answered with HTTP ${response.status}.`)
  }
}
