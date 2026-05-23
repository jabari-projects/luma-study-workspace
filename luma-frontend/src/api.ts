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
}

export type AuthSession = {
  user: BasicUser
  access_token: string
}

export type StoredAuthSession = {
  accessToken: string
  user: BasicUser | Profile
}

type ApiValidationError = {
  msg?: string
}

type ApiErrorPayload = {
  detail?: string | ApiValidationError[]
  error?: string
  message?: string
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

export function getErrorMessage(error: unknown, fallback = "Something went wrong."): string {
  if (error instanceof AxiosError) {
    if (!error.response) {
      return "Could not reach the Luma backend. Confirm the backend is running and try again."
    }

    const data = error.response.data as ApiErrorPayload | undefined
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

export async function checkBackendHealth(): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/health`, {
    method: "GET",
  })

  if (response.status !== 200) {
    throw new Error(`Backend health check returned HTTP ${response.status}.`)
  }
}
