import { AxiosError } from "axios"

import { api, getErrorMessage } from "../api"
import { MAX_TEXT_CHARS } from "./extract"

export type SourceKind = "audio" | "paste" | "file" | "link" | "youtube"

export type DraftCard = { id: string; front: string; back: string; keep: boolean }

export type NotesDraft = {
  title: string
  summary: string
  notes: string
  keyTerms: string[]
  cards: DraftCard[]
  truncated: boolean
  source: { kind: SourceKind; label: string }
}

type NotesResponse = {
  title: string
  summary: string
  notes: string
  key_terms: string[]
  flashcards: { front: string; back: string }[]
  truncated: boolean
}

export type LinkImport = { title: string; text: string; site_name: string; url: string; truncated: boolean }

/** A friendly error that also says whether it was the daily free limit. */
export class CaptureError extends Error {
  readonly limitReached: boolean
  readonly code?: string
  constructor(message: string, limitReached = false, code?: string) {
    super(message)
    this.limitReached = limitReached
    this.code = code
  }
}

function toCaptureError(error: unknown, fallback: string): CaptureError {
  if (error instanceof AxiosError && error.response) {
    const data = error.response.data as { code?: string } | undefined
    return new CaptureError(getErrorMessage(error, fallback), error.response.status === 403, data?.code)
  }
  return new CaptureError(getErrorMessage(error, fallback))
}

let cardCounter = 0
const nextId = () => `draft-${Date.now().toString(36)}-${(cardCounter += 1)}`

export async function transcribeAudio(blob: Blob, filename: string): Promise<string> {
  const form = new FormData()
  // Only the file type matters; the student's own file name stays on this device.
  const dot = filename.lastIndexOf(".")
  const extension = dot >= 0 ? filename.slice(dot).toLowerCase().replace(/[^a-z0-9.]/g, "") : ""
  form.append("audio", blob, `recording${extension}`)
  try {
    const response = await api.post<{ transcript: string }>("/api/transcribe", form, { timeout: 180000 })
    return response.data.transcript
  } catch (error: unknown) {
    throw toCaptureError(error, "We couldn't turn your audio into words.")
  }
}

export async function makeNotes(text: string, kind: SourceKind, label: string): Promise<NotesDraft> {
  try {
    const response = await api.post<NotesResponse>(
      "/api/notes-from-text",
      { text: text.slice(0, MAX_TEXT_CHARS), source_kind: kind, source_label: label.slice(0, 300) || undefined },
      { timeout: 120000 },
    )
    const data = response.data
    return {
      title: data.title || "My notes",
      summary: data.summary ?? "",
      notes: data.notes ?? "",
      keyTerms: data.key_terms ?? [],
      cards: (data.flashcards ?? []).map((card) => ({ id: nextId(), front: card.front, back: card.back, keep: true })),
      truncated: Boolean(data.truncated) || text.length > MAX_TEXT_CHARS,
      source: { kind, label },
    }
  } catch (error: unknown) {
    throw toCaptureError(error, "We couldn't make notes right now.")
  }
}

export async function importLink(url: string): Promise<LinkImport> {
  try {
    const response = await api.post<LinkImport>("/api/import/link", { url: url.trim() }, { timeout: 30000 })
    return response.data
  } catch (error: unknown) {
    throw toCaptureError(error, "We couldn't open that link.")
  }
}

export function newDraftCard(): DraftCard {
  return { id: nextId(), front: "", back: "", keep: true }
}
