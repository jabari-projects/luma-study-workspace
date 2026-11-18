import { useRef, useState } from "react"
import type { ChangeEvent, FormEvent } from "react"
import { Link } from "react-router-dom"
import { ArrowLeft, Image as ImageIcon, MagicWand } from "@phosphor-icons/react"

import { getErrorMessage } from "../api"
import { NoticeBanner } from "../ui/common"
import { Scribble } from "../ui/Scribble"
import { NOTES_HUB } from "../notes/paths"
import { CaptureError, makeNotesFromImage } from "./capture-api"
import type { NotesDraft } from "./capture-api"
import { LimitNudge, NotesWorkbench, WorkingSteps } from "./Workbench"

const ACCEPTED_IMAGES = "image/png,image/jpeg,image/webp"
const MAX_IMAGE_BYTES = 15 * 1024 * 1024

type Stage = "pick" | "working" | "review"

/**
 * Image to notes: pick a photo of a page or the board. Luma reads it and makes notes
 * and flashcards, which the student checks on the same workbench as the other tools.
 */
export function ImagePage() {
  const [fileName, setFileName] = useState("")
  const [imageData, setImageData] = useState<string | null>(null)
  const [stage, setStage] = useState<Stage>("pick")
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<NotesDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [limit, setLimit] = useState<string | null>(null)
  // Each pick gets a number, so a slow read of an older picture is ignored.
  const pickRef = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const readImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // Clear the picker so choosing the same picture again still fires a change.
    event.target.value = ""
    const pick = (pickRef.current += 1)
    setError(null)
    setLimit(null)
    setFileName(file?.name ?? "")
    setImageData(null)
    if (!file) return
    if (file.size > MAX_IMAGE_BYTES) {
      setFileName("")
      setError("That picture is too big. Try one under 15 MB.")
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (pick === pickRef.current) setImageData(typeof reader.result === "string" ? reader.result : null)
    }
    reader.readAsDataURL(file)
  }

  const run = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!imageData) {
      setError(fileName ? "Still opening your image. Try again in a moment." : "Choose an image first.")
      return
    }
    const pick = pickRef.current
    setError(null)
    setLimit(null)
    setStage("working")
    setStep(0)
    const timers = [window.setTimeout(() => setStep(1), 4000), window.setTimeout(() => setStep(2), 9000)]
    try {
      // The file name stays on this device: it only goes into the saved note's "Source:" line.
      const result = await makeNotesFromImage(imageData, fileName ? `Image: ${fileName}` : "Image")
      if (pick !== pickRef.current) return
      setDraft(result)
      setStage("review")
    } catch (err: unknown) {
      if (pick !== pickRef.current) return
      setStage("pick")
      if (err instanceof CaptureError && err.limitReached) setLimit(err.message)
      else setError(getErrorMessage(err, "Something went wrong. Your image is still here."))
    } finally {
      timers.forEach((timer) => window.clearTimeout(timer))
    }
  }

  const startOver = () => {
    pickRef.current += 1
    setDraft(null)
    setImageData(null)
    setFileName("")
    setError(null)
    setLimit(null)
    setStage("pick")
    if (inputRef.current) inputRef.current.value = ""
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
          <p className="lede">Take a photo of a page or the board. Luma makes notes and flashcards from it.</p>
        </div>
      </header>

      {limit ? <LimitNudge message={limit} onClose={() => setLimit(null)} /> : null}
      <NoticeBanner notice={error ? { type: "error", text: error } : null} />

      <div className={stage === "review" ? "capture-layout has-results" : "capture-layout"}>
        <section className={stage === "review" ? "capture-source collapsed" : "capture-source"} aria-label="Your image">
          {stage === "review" ? (
            <button type="button" className="ghost-button small back-to-source" onClick={() => setStage("pick")}>
              <ArrowLeft weight="bold" aria-hidden="true" /> Back to my image
            </button>
          ) : null}

          {draft && stage === "pick" ? (
            <button type="button" className="primary-button back-to-notes" onClick={() => setStage("review")}>
              Back to my notes
            </button>
          ) : null}

          <form className="image-pick" onSubmit={run}>
            <label className="paper-tray">
              <span className="tray-sheet" aria-hidden="true" />
              <ImageIcon size={42} weight="duotone" aria-hidden="true" />
              <strong>Choose an image</strong>
              <small>A photo or screenshot. PNG, JPG or WEBP. Up to 15&nbsp;MB.</small>
              <input ref={inputRef} type="file" accept={ACCEPTED_IMAGES} onChange={readImage} disabled={stage === "working"} />
            </label>
            {fileName ? <p className="ready-label">Selected: {fileName}</p> : null}
            {imageData ? <img className="image-preview" src={imageData} alt="The image you picked" /> : null}
            <div className="button-row">
              <button className="primary-button" type="submit" disabled={stage === "working"}>
                <MagicWand weight="bold" aria-hidden="true" /> {stage === "working" ? "Reading your image..." : "Make notes"}
              </button>
            </div>
            <p className="field-hint">Free plan: making notes uses 1 notes turn.</p>
          </form>

          <p className="hand-note privacy-note">
            Your notes are private unless you share them. To make notes, Luma sends your picture to OpenAI. Luma does not save
            the picture.
          </p>
        </section>

        <div className="capture-results">
          {stage === "working" ? (
            <WorkingSteps steps={["Reading your image...", "Writing notes...", "Making cards..."]} current={step} />
          ) : null}
          {stage === "review" && draft ? <NotesWorkbench draft={draft} onChange={setDraft} onStartOver={startOver} /> : null}
          {stage === "pick" && !draft ? (
            <aside className="capture-tip">
              <h2>How it works</h2>
              <ol>
                <li>Take a clear photo of a page, a worksheet or the board.</li>
                <li>Luma reads it and writes notes.</li>
                <li>You get notes and flashcards. Keep the ones you like.</li>
              </ol>
              <p className="muted small-text">
                Have a file or a link instead? <Link to="/notes/import">Import it</Link>.
              </p>
            </aside>
          ) : null}
        </div>
      </div>
    </>
  )
}
