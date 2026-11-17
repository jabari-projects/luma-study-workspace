import { useEffect, useRef, useState } from "react"
import type { FormEvent } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { toast } from "sonner"
import { ArrowLeft, Lightbulb } from "@phosphor-icons/react"

import { api, getErrorMessage, getTabAccountId } from "../api"
import { noteDraftKey } from "../accounts"
import { NoticeBanner } from "../ui/common"
import type { Notice } from "../ui/common"
import { Scribble } from "../ui/Scribble"
import { NOTES_HUB, defaultNoteTitle, parseTags } from "./paths"

type Draft = { title: string; content: string; tags: string }
type SavedItem = { id: string; title?: string; content?: string; tags?: string[] }

function readDraft(accountId: string | null): Draft | null {
  if (!accountId) return null
  try {
    const raw = window.localStorage.getItem(noteDraftKey(accountId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Draft>
    if (typeof parsed?.content !== "string" || typeof parsed.title !== "string") return null
    return { title: parsed.title, content: parsed.content, tags: typeof parsed.tags === "string" ? parsed.tags : "" }
  } catch {
    return null
  }
}

function writeDraft(accountId: string | null, draft: Draft | null): boolean {
  if (!accountId) return false
  try {
    if (draft) window.localStorage.setItem(noteDraftKey(accountId), JSON.stringify(draft))
    else window.localStorage.removeItem(noteDraftKey(accountId))
    return true
  } catch {
    return false
  }
}

/**
 * Write a new note (/notes/new) or change a saved one (/notes/:id/edit, /summaries/:id/edit).
 * A new note's words are kept on this device as you type, so a closed tab doesn't lose them.
 */
export function NoteEditorPage({ kind = "note" }: { kind?: "note" | "summary" }) {
  const { itemId } = useParams()
  const isNew = !itemId
  const navigate = useNavigate()
  const endpoint = kind === "summary" ? "/summaries" : "/notes"
  const label = kind === "summary" ? "summary" : "note"
  // This tab's account when the page opened. Saving goes to it, even if the tab switches.
  const [accountId] = useState(() => getTabAccountId())
  const [restored] = useState(() => (isNew ? readDraft(accountId) : null))
  const [fields, setFields] = useState<Draft>(() => restored ?? { title: isNew ? defaultNoteTitle() : "", content: "", tags: "" })
  const { title, content, tags } = fields
  const [loading, setLoading] = useState(!isNew)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [saving, setSaving] = useState(false)
  const [draftSaved, setDraftSaved] = useState(Boolean(restored))
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const savedRef = useRef(false)

  /** Changes one field. A new note's words stay on this device until it is saved. */
  const change = (patch: Partial<Draft>) => {
    const next = { ...fields, ...patch }
    setFields(next)
    if (!isNew || savedRef.current) return
    const empty = !next.content.trim() && !next.tags.trim()
    setDraftSaved(writeDraft(accountId, empty ? null : next) && !empty)
  }

  useEffect(() => {
    if (isNew) return
    let active = true
    api
      .get<SavedItem>(`${endpoint}/${itemId}`)
      .then((response) => {
        if (!active) return
        setFields({
          title: typeof response.data.title === "string" ? response.data.title : "",
          content: typeof response.data.content === "string" ? response.data.content : "",
          tags: Array.isArray(response.data.tags) ? response.data.tags.join(", ") : "",
        })
      })
      .catch((error: unknown) => active && setLoadError(getErrorMessage(error, `We could not find this ${label}.`)))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [endpoint, isNew, itemId, label])

  const backTo = isNew ? NOTES_HUB : `${endpoint}/${itemId}`

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setNotice(null)
    // A summary may have no title (the hub calls it "Untitled summary"), so only notes need one.
    if (kind === "note" && !title.trim()) {
      setNotice({ type: "error", text: `Give your ${label} a title.` })
      return
    }
    if (!content.trim()) {
      setNotice({ type: "error", text: "Write something first." })
      bodyRef.current?.focus()
      return
    }
    setSaving(true)
    const payload = { title: title.trim().slice(0, 200), content, tags: parseTags(tags) }
    const pinned = accountId ? { lumaAccountId: accountId } : undefined
    try {
      const response = isNew
        ? await api.post<{ id: string }>(endpoint, payload, pinned)
        : await api.put<{ id: string }>(`${endpoint}/${itemId}`, payload, pinned)
      if (isNew) {
        savedRef.current = true
        writeDraft(accountId, null)
      }
      // Another account took over this tab while saving: the note is saved, but don't open it here.
      if ((getTabAccountId() ?? null) !== accountId) return
      toast.success(isNew ? "Saved your note!" : "Saved your changes.")
      navigate(`${endpoint}/${response.data.id || itemId}`, { replace: true })
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "We couldn't save that. Your words are still here.") })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="loading-card" role="status">
        <span className="spinner" />
        <p>Opening your {label}...</p>
      </div>
    )
  }

  return (
    <div className="note-editor-page">
      <header className="page-head note-head">
        <div>
          <Link className="back-link" to={backTo}>
            <ArrowLeft weight="bold" aria-hidden="true" /> {isNew ? "Back to notes" : `Back to the ${label}`}
          </Link>
          <h1>{isNew ? <>Write a <Scribble type="underline">note</Scribble></> : <>Change your <Scribble type="underline">{label}</Scribble></>}</h1>
          <p className="lede">{isNew ? "Write it your way. Save it when you're ready." : "Fix a word, add more, then save."}</p>
        </div>
      </header>

      <NoticeBanner notice={loadError ? { type: "error", text: loadError } : notice} />

      {loadError ? null : (
        <form className="note-editor" onSubmit={save} noValidate>
          <label className="editor-title">
            Title
            <input value={title} onChange={(event) => change({ title: event.target.value })} maxLength={200} required={kind === "note"} />
          </label>
          <div className="editor-body">
            <label htmlFor="note-editor-body">Your notes</label>
            <div className="sheet-note editor-sheet">
              <textarea
                id="note-editor-body"
                ref={bodyRef}
                value={content}
                onChange={(event) => change({ content: event.target.value })}
                placeholder="Write your notes here."
                rows={14}
                required
                autoFocus={isNew && !restored}
              />
            </div>
          </div>
          <p className="editor-tip">
            <Lightbulb weight="duotone" aria-hidden="true" />
            <span>
              Write <code>Question :: Answer</code> on a line to make a flashcard.
            </span>
          </p>
          <div className="editor-tags">
            <label htmlFor="note-editor-tags">Tags (optional)</label>
            <input
              id="note-editor-tags"
              value={tags}
              onChange={(event) => change({ tags: event.target.value })}
              placeholder="biology, cells"
              aria-describedby="note-editor-tags-help"
            />
            <small id="note-editor-tags-help" className="muted">
              Put a comma between tags.
            </small>
          </div>
          <div className="button-row editor-actions">
            <button type="submit" className="primary-button" disabled={saving}>
              {saving ? "Saving..." : isNew ? "Save note" : "Save changes"}
            </button>
            <Link className="secondary-button" to={backTo}>
              Cancel
            </Link>
            {isNew && draftSaved ? (
              <small className="draft-line" role="status">
                Draft saved on this device.
              </small>
            ) : null}
          </div>
        </form>
      )}
    </div>
  )
}
