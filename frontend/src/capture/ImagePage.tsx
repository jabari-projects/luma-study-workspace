import { useRef, useState } from "react"
import type { ChangeEvent, FormEvent } from "react"
import { Link, useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { ArrowCounterClockwise, ArrowLeft, Image as ImageIcon, MagicWand } from "@phosphor-icons/react"

import { api, getErrorMessage, getTabAccountId } from "../api"
import { NoticeBanner } from "../ui/common"
import type { Notice } from "../ui/common"
import { Scribble } from "../ui/Scribble"
import { NOTES_HUB, defaultNoteTitle } from "../notes/paths"

const ACCEPTED_IMAGES = "image/png,image/jpeg,image/webp"

/**
 * Image to notes: pick a photo of a page or the board, Luma reads it and writes notes,
 * then the student can fix the words and save them as a note.
 */
export function ImagePage() {
  const navigate = useNavigate()
  const [fileName, setFileName] = useState("")
  const [imageData, setImageData] = useState<string | null>(null)
  const [notes, setNotes] = useState<string | null>(null)
  const [title, setTitle] = useState(defaultNoteTitle)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [working, setWorking] = useState(false)
  const [saving, setSaving] = useState(false)
  const notesRef = useRef<HTMLTextAreaElement>(null)
  // Each pick gets a number, so a slow read of an older picture is ignored.
  const pickRef = useRef(0)

  const readImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    const pick = (pickRef.current += 1)
    setNotes(null)
    setNotice(null)
    setFileName(file?.name ?? "")
    setImageData(null)
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      if (pick === pickRef.current) setImageData(typeof reader.result === "string" ? reader.result : null)
    }
    reader.readAsDataURL(file)
  }

  const makeNotes = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!imageData) {
      setNotice({ type: "error", text: fileName ? "Still opening your image. Try again in a moment." : "Choose an image first." })
      return
    }
    setWorking(true)
    setNotice(null)
    try {
      const response = await api.post<{ notes: string }>("/api/generate-notes", { image: imageData })
      const text = typeof response.data?.notes === "string" ? response.data.notes.trim() : ""
      if (!text) {
        setNotice({ type: "error", text: "We couldn't find words in that image. Try a clearer photo." })
        return
      }
      setNotes(text)
      requestAnimationFrame(() => notesRef.current?.focus())
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "We couldn't make notes from that image.") })
    } finally {
      setWorking(false)
    }
  }

  const saveNote = async () => {
    if (!notes?.trim()) {
      setNotice({ type: "error", text: "Your notes are empty." })
      return
    }
    setSaving(true)
    setNotice(null)
    // Save into the account that made these notes, even if this tab switches meanwhile.
    const accountId = getTabAccountId() ?? undefined
    try {
      const response = await api.post<{ id: string }>(
        "/notes",
        { title: title.trim().slice(0, 200) || defaultNoteTitle(), content: notes, tags: [] },
        { lumaAccountId: accountId },
      )
      if ((getTabAccountId() ?? undefined) !== accountId) return
      toast.success("Saved your note!")
      navigate(`/notes/${response.data.id}`)
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "We couldn't save that. Your notes are still here.") })
    } finally {
      setSaving(false)
    }
  }

  const startOver = () => {
    pickRef.current += 1
    setNotes(null)
    setImageData(null)
    setFileName("")
    setNotice(null)
    setTitle(defaultNoteTitle())
  }

  return (
    <>
      <header className="page-head note-head">
        <div>
          <Link className="back-link" to={NOTES_HUB}>
            <ArrowLeft weight="bold" aria-hidden="true" /> Back to notes
          </Link>
          <h1>
            Image to <Scribble type="underline">notes</Scribble>
          </h1>
          <p className="lede">Take a photo of a page or the board. Luma reads it and writes notes.</p>
        </div>
      </header>
      <NoticeBanner notice={notice} />

      {notes === null ? (
        <form className="image-pick" onSubmit={makeNotes}>
          <label className="paper-tray">
            <span className="tray-sheet" aria-hidden="true" />
            <ImageIcon size={42} weight="duotone" aria-hidden="true" />
            <strong>Choose an image</strong>
            <small>A photo or screenshot. PNG, JPG or WEBP.</small>
            <input type="file" accept={ACCEPTED_IMAGES} onChange={readImage} disabled={working} />
          </label>
          {fileName ? <p className="ready-label">Selected: {fileName}</p> : null}
          <p className="muted small-text">To make notes, Luma sends your picture to OpenAI. Luma does not save the picture.</p>
          <div className="button-row">
            <button className="primary-button" type="submit" disabled={working}>
              <MagicWand weight="bold" aria-hidden="true" /> {working ? "Reading your image..." : "Make notes"}
            </button>
          </div>
        </form>
      ) : (
        <section className="image-result" aria-labelledby="image-result-title">
          <h2 id="image-result-title">Check your notes</h2>
          <p className="muted">Fix anything Luma read wrong. Then save it as a note.</p>
          <label className="editor-title">
            Name your notes
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} />
          </label>
          <div className="editor-body">
            <label htmlFor="image-notes-text">Your notes (you can change them)</label>
            <div className="sheet-note editor-sheet">
              <textarea
                id="image-notes-text"
                ref={notesRef}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={14}
              />
            </div>
          </div>
          <div className="button-row">
            <button type="button" className="primary-button" onClick={() => void saveNote()} disabled={saving}>
              {saving ? "Saving..." : "Save as note"}
            </button>
            <button type="button" className="ghost-button" onClick={startOver} disabled={saving}>
              <ArrowCounterClockwise weight="bold" aria-hidden="true" /> Use another image
            </button>
          </div>
        </section>
      )}
    </>
  )
}
