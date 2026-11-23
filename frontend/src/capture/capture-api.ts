import { AxiosError } from "axios"

import { api, getErrorMessage } from "../api"
import { MAX_TEXT_CHARS } from "./extract"
import { draftHasWords, nextDraftCardId, toNotesDraft } from "./draft"
import type { DraftCard, NotesDraft, NotesResponse, SourceKind } from "./draft"

export type { DraftCard, DraftSourceKind, NotesDraft, SourceKind } from "./draft"

export type LinkImport = { title: string; text: string; site_name: string; url: string; truncated: boolean }

/** A friendly error that also says whether it was the daily free limit, and the HTTP status (if any). */
export class CaptureError extends Error {
  readonly limitReached: boolean
  readonly code?: string
  readonly status?: number
  constructor(message: string, limitReached = false, code?: string, status?: number) {
    super(message)
    this.limitReached = limitReached
    this.code = code
    this.status = status
  }
}

function toCaptureError(error: unknown, fallback: string): CaptureError {
  if (error instanceof CaptureError) return error
  if (error instanceof AxiosError && error.response) {
    const data = error.response.data as { code?: string } | undefined
    return new CaptureError(getErrorMessage(error, fallback), error.response.status === 403, data?.code, error.response.status)
  }
  return new CaptureError(getErrorMessage(error, fallback))
}

export async function transcribeAudio(blob: Blob, filename: string, hint?: string): Promise<string> {
  const form = new FormData()
  // Only the file type matters; the student's own file name stays on this device.
  const dot = filename.lastIndexOf(".")
  const extension = dot >= 0 ? filename.slice(dot).toLowerCase().replace(/[^a-z0-9.]/g, "") : ""
  form.append("audio", blob, `recording${extension}`)
  const cleanedHint = (hint ?? "").replace(/\s+/g, " ").trim().slice(0, 300)
  if (cleanedHint) form.append("hint", cleanedHint)
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
    return toNotesDraft(response.data, { kind, label }, text.length > MAX_TEXT_CHARS)
  } catch (error: unknown) {
    throw toCaptureError(error, "We couldn't make notes right now.")
  }
}

/**
 * Image to notes: one picture in, the same notes and flashcards as the other tools out.
 * It uses 1 notes turn. `label` stays on this device (it goes in the saved note only).
 */
export async function makeNotesFromImage(image: string, label: string): Promise<NotesDraft> {
  try {
    const response = await api.post<NotesResponse>("/api/generate-notes", { image }, { timeout: 120000 })
    const draft = toNotesDraft(response.data, { kind: "image", label })
    if (!draftHasWords(draft)) throw new CaptureError("We couldn't find words in that image. Try a clearer photo.")
    return draft
  } catch (error: unknown) {
    throw toCaptureError(error, "We couldn't make notes from that image.")
  }
}

export type NoteSummary = { title: string; summary: string }

/**
 * Make a summary of a note: text in, `{title, summary}` out. It uses 1 notes turn and
 * saves nothing; the caller saves it with POST /summaries.
 */
export async function makeSummary(text: string): Promise<NoteSummary> {
  try {
    const response = await api.post<NoteSummary>("/api/summarize", { text: text.slice(0, MAX_TEXT_CHARS) }, { timeout: 120000 })
    const title = typeof response.data?.title === "string" ? response.data.title.trim() : ""
    const summary = typeof response.data?.summary === "string" ? response.data.summary.trim() : ""
    if (!summary) throw new CaptureError("We couldn't make a summary this time. Try again.")
    return { title, summary }
  } catch (error: unknown) {
    throw toCaptureError(error, "We couldn't make a summary right now.")
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
  return { id: nextDraftCardId(), front: "", back: "", keep: true }
}
