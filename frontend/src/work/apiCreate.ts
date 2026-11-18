// createOnce (see createOnce.ts) over Luma's axios client.
import { AxiosError } from "axios"
import type { AxiosRequestConfig } from "axios"

import { api } from "../api"
import { createOnce } from "./createOnce"
import type { CreatedRow } from "./createOnce"

/**
 * POST a new item with `createKey` as its Idempotency-Key and resolve only when the server
 * confirmed the words in `body` (a replay with older words is followed by a checked update).
 */
export function createWithApi<Row extends CreatedRow>(
  path: string,
  body: Record<string, unknown>,
  matches: (row: Row) => boolean,
  createKey: string,
  config: AxiosRequestConfig = {},
): Promise<Row> {
  const headers = { ...((config.headers as Record<string, string> | undefined) ?? {}) }
  return createOnce<Row>(
    {
      post: (p, b) => api.post<Row>(p, b, { ...config, headers: { ...headers, "Idempotency-Key": createKey } }),
      put: (p, b) => api.put<Row>(p, b, { ...config, headers }),
      statusOf: (error) => (error instanceof AxiosError ? (error.response?.status ?? null) : null),
    },
    path,
    body,
    matches,
  )
}
