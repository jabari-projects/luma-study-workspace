import { useRef, useState } from "react"
import type { ChangeEvent, DragEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { ArrowLeft, FileText, Globe, TextAa, Tray, YoutubeLogo } from "@phosphor-icons/react"
import type { Icon } from "@phosphor-icons/react"

import { NoticeBanner, PageHeader } from "../ui/common"
import { Scribble } from "../ui/Scribble"
import { CaptureError, importLink, makeNotes } from "./capture-api"
import type { NotesDraft, SourceKind } from "./capture-api"
import { ACCEPTED_FILES, MAX_TEXT_CHARS, cleanTranscript, countWords, extractFromFile, isYouTubeUrl, tidyText } from "./extract"
import { LimitNudge, NotesWorkbench, WorkingSteps } from "./Workbench"

type Tab = "paste" | "file" | "link" | "youtube"

const tabs: { id: Tab; label: string; icon: Icon }[] = [
  { id: "paste", label: "Paste text", icon: TextAa },
  { id: "file", label: "Upload a file", icon: FileText },
  { id: "link", label: "Web link", icon: Globe },
  { id: "youtube", label: "YouTube", icon: YoutubeLogo },
]

type Source = { text: string; label: string; kind: SourceKind; detail?: string }

export function ImportPage() {
  const [params] = useSearchParams()
  const initialTab = (["paste", "file", "link", "youtube"] as Tab[]).find((tab) => tab === params.get("from")) ?? "paste"
  const [tab, setTab] = useState<Tab>(initialTab)
  const [pasted, setPasted] = useState("")
  const [link, setLink] = useState("")
  const [ytLink, setYtLink] = useState("")
  const [ytText, setYtText] = useState("")
  const [source, setSource] = useState<Source | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [limit, setLimit] = useState<string | null>(null)
  const [stage, setStage] = useState<"source" | "working" | "review">("source")
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<NotesDraft | null>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  // Each new choice gets a number. Slow results from an older choice are ignored.
  const requestRef = useRef(0)
  const newRequest = () => (requestRef.current += 1)
  const isCurrent = (id: number) => id === requestRef.current

  const chooseTab = (next: Tab) => {
    setTab(next)
    setError(null)
  }

  const onTabKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((item) => item.id === tab)
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0
    if (!delta) return
    event.preventDefault()
    const next = (index + delta + tabs.length) % tabs.length
    chooseTab(tabs[next].id)
    tabRefs.current[next]?.focus()
  }

  const readFile = async (file: File | undefined) => {
    if (!file || busy) return
    const id = newRequest()
    setError(null)
    setSource(null)
    setBusy("Opening your file...")
    try {
      const result = await extractFromFile(file, (message) => {
        if (isCurrent(id)) setBusy(message)
      })
      if (!isCurrent(id)) return
      const detail =
        result.pagesTotal && result.pagesRead && result.pagesRead < result.pagesTotal
          ? `We read the first ${result.pagesRead} of ${result.pagesTotal} pages.`
          : undefined
      setSource({ text: result.text, label: result.label, kind: "file", detail })
    } catch (err: unknown) {
      if (isCurrent(id)) setError(err instanceof Error ? err.message : "We couldn't open that file.")
    } finally {
      if (isCurrent(id)) setBusy(null)
    }
  }

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    setDragOver(false)
    void readFile(event.dataTransfer.files?.[0])
  }

  const fetchLink = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setSource(null)
    const value = link.trim()
    if (!value || busy) return
    const id = newRequest()
    if (isYouTubeUrl(value)) {
      setYtLink(value)
      chooseTab("youtube")
      return
    }
    setBusy("Reading the page...")
    try {
      const page = await importLink(/^https?:\/\//i.test(value) ? value : `https://${value}`)
      if (!isCurrent(id)) return
      setSource({
        text: tidyText(page.text),
        label: page.title ? `${page.title} (${page.site_name || new URL(page.url).hostname})` : page.url,
        kind: "link",
        detail: page.truncated ? "That page is long, so we used the first part." : undefined,
      })
    } catch (err: unknown) {
      if (!isCurrent(id)) return
      if (err instanceof CaptureError && err.code === "youtube") {
        setYtLink(value)
        chooseTab("youtube")
        return
      }
      setError(err instanceof Error ? err.message : "We couldn't open that link.")
    } finally {
      if (isCurrent(id)) setBusy(null)
    }
  }

  const usePasted = () => {
    const text = tidyText(pasted)
    if (countWords(text) < 5) {
      setError("Paste a few more words first.")
      return
    }
    newRequest()
    setBusy(null)
    setError(null)
    setSource({ text, label: "Pasted text", kind: "paste" })
  }

  const useYouTube = () => {
    const text = cleanTranscript(ytText)
    if (countWords(text) < 5) {
      setError("Paste the words from the video first.")
      return
    }
    newRequest()
    setBusy(null)
    setError(null)
    setSource({ text, label: ytLink.trim() ? `YouTube: ${ytLink.trim()}` : "YouTube video", kind: "youtube" })
  }

  const run = async () => {
    if (!source) return
    setError(null)
    setLimit(null)
    setStage("working")
    setStep(1)
    const timer = window.setTimeout(() => setStep(2), 6000)
    try {
      // The file name stays on this device; the AI only gets a plain description.
      const aiLabel = source.kind === "file" ? "Uploaded file" : source.label
      const result = await makeNotes(source.text, source.kind, aiLabel)
      setDraft({ ...result, source: { kind: source.kind, label: source.label } })
      setStage("review")
    } catch (err: unknown) {
      setStage("source")
      if (err instanceof CaptureError && err.limitReached) setLimit(err.message)
      else setError(err instanceof Error ? err.message : "Something went wrong. Your text is still here.")
    } finally {
      window.clearTimeout(timer)
    }
  }

  const startOver = () => {
    newRequest()
    setBusy(null)
    setDraft(null)
    setSource(null)
    setPasted("")
    setLink("")
    setYtLink("")
    setYtText("")
    setStage("source")
  }

  const words = source ? countWords(source.text) : 0

  return (
    <>
      <PageHeader
        eyebrow="Create"
        title={
          <>
            Bring it in. <Scribble type="highlight">Make it notes.</Scribble>
          </>
        }
        description="Paste words, add a file, or use a link. Luma turns it into notes and flashcards."
      />

      {limit ? <LimitNudge message={limit} onClose={() => setLimit(null)} /> : null}
      <NoticeBanner notice={error ? { type: "error", text: error } : null} />

      <div className={stage === "review" ? "capture-layout has-results" : "capture-layout"}>
        <section className={stage === "review" ? "capture-source collapsed" : "capture-source"} aria-label="What to import">
          {stage === "review" ? (
            <button type="button" className="ghost-button small back-to-source" onClick={() => setStage("source")}>
              <ArrowLeft weight="bold" aria-hidden="true" /> Back to my source
            </button>
          ) : null}

          <div className="source-tabs" role="tablist" aria-label="Where is it from?" onKeyDown={onTabKey}>
            {tabs.map((item, index) => (
              <button
                key={item.id}
                ref={(element) => {
                  tabRefs.current[index] = element
                }}
                type="button"
                role="tab"
                id={`src-tab-${item.id}`}
                aria-selected={tab === item.id}
                aria-controls={tab === item.id ? `src-panel-${item.id}` : undefined}
                tabIndex={tab === item.id ? 0 : -1}
                className={tab === item.id ? "source-tab active" : "source-tab"}
                onClick={() => chooseTab(item.id)}
                disabled={stage === "working"}
              >
                <item.icon weight={tab === item.id ? "fill" : "duotone"} aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            ))}
          </div>

          <div className="source-panel" role="tabpanel" id={`src-panel-${tab}`} aria-labelledby={`src-tab-${tab}`}>
            {tab === "paste" ? (
              <>
                <label>
                  <span className="sr-only">Your words</span>
                  <textarea
                    className="paste-pad"
                    rows={10}
                    value={pasted}
                    onChange={(event) => setPasted(event.target.value)}
                    placeholder="Paste your words here."
                  />
                </label>
                <button type="button" className="secondary-button" onClick={usePasted} disabled={!pasted.trim() || stage === "working"}>
                  Use these words
                </button>
              </>
            ) : null}

            {tab === "file" ? (
              <label
                className={dragOver ? "paper-tray is-over" : "paper-tray"}
                onDragOver={(event) => {
                  event.preventDefault()
                  setDragOver(true)
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
              >
                <span className="tray-sheet" aria-hidden="true" />
                <Tray size={42} weight="duotone" aria-hidden="true" />
                <strong>Drop a file here, or tap to choose.</strong>
                <small>PDF, Word (.docx), TXT or MD. Up to 15 MB.</small>
                <input
                  type="file"
                  accept={ACCEPTED_FILES}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => {
                    void readFile(event.target.files?.[0])
                    event.target.value = ""
                  }}
                  disabled={Boolean(busy) || stage === "working"}
                />
              </label>
            ) : null}

            {tab === "link" ? (
              <form className="link-field" onSubmit={fetchLink} noValidate>
                <label>
                  Paste a web page link
                  <input
                    type="url"
                    inputMode="url"
                    value={link}
                    onChange={(event) => setLink(event.target.value)}
                    placeholder="https://..."
                    autoComplete="off"
                  />
                </label>
                <button type="submit" className="secondary-button" disabled={!link.trim() || Boolean(busy) || stage === "working"}>
                  Get it
                </button>
                <p className="muted small-text">Some pages are locked. If one doesn't work, copy its words and use Paste text.</p>
              </form>
            ) : null}

            {tab === "youtube" ? (
              <div className="yt-steps">
                <label>
                  Video link (optional)
                  <input
                    type="url"
                    inputMode="url"
                    value={ytLink}
                    onChange={(event) => setYtLink(event.target.value)}
                    placeholder="https://www.youtube.com/watch?v=..."
                    autoComplete="off"
                  />
                </label>
                <ol className="how-to">
                  <li>Open the video on YouTube.</li>
                  <li>
                    Under the video, tap <strong>...more</strong>, then <strong>Show transcript</strong>.
                  </li>
                  <li>Copy all the words and paste them below.</li>
                </ol>
                {ytLink && isYouTubeUrl(ytLink) ? (
                  <a className="ghost-button small" href={ytLink.trim()} target="_blank" rel="noreferrer noopener">
                    <YoutubeLogo weight="fill" aria-hidden="true" /> Open the video
                  </a>
                ) : null}
                <label>
                  <span className="sr-only">Video words</span>
                  <textarea
                    className="paste-pad"
                    rows={8}
                    value={ytText}
                    onChange={(event) => setYtText(event.target.value)}
                    placeholder="Paste the video's words here. We'll take out the times."
                  />
                </label>
                <button type="button" className="secondary-button" onClick={useYouTube} disabled={!ytText.trim() || stage === "working"}>
                  Use these words
                </button>
                <p className="muted small-text">
                  No words under the video? Save its sound and use <Link to="/voice-input">Voice to notes</Link>.
                </p>
              </div>
            ) : null}

            {busy ? (
              <div className="loading-card" role="status">
                <span className="spinner" />
                <p>{busy}</p>
              </div>
            ) : null}
          </div>

          {draft && stage === "source" ? (
            <button type="button" className="primary-button back-to-notes" onClick={() => setStage("review")}>
              Back to my notes
            </button>
          ) : null}

          {source && stage !== "working" ? (
            <section className="extract-preview paper-panel" aria-label="What we found">
              <div className="preview-head">
                <h2>What we found</h2>
                <span className="word-count">{words.toLocaleString()} words</span>
              </div>
              <p className="preview-label">{source.label}</p>
              {source.detail ? <p className="notice info">{source.detail}</p> : null}
              {source.text.length > MAX_TEXT_CHARS ? (
                <p className="notice info">That's a lot! We'll use the first {Math.round(MAX_TEXT_CHARS / 6).toLocaleString()} words or so.</p>
              ) : null}
              <div className="preview-text" tabIndex={0}>
                {source.text.slice(0, 2400)}
                {source.text.length > 2400 ? "…" : ""}
              </div>
              <div className="button-row">
                <button type="button" className="primary-button" onClick={() => void run()}>
                  Make my notes
                </button>
                <button type="button" className="ghost-button" onClick={() => setSource(null)}>
                  Try something else
                </button>
              </div>
            </section>
          ) : null}
          <p className="hand-note privacy-note">
            Files are opened on your device. To make notes, Luma sends the words to OpenAI, plus the page's title or link for web
            and YouTube links. Web links are opened by Luma's server.
          </p>
        </section>

        <div className="capture-results">
          {stage === "working" ? <WorkingSteps steps={["Reading...", "Writing notes...", "Making cards..."]} current={step} /> : null}
          {stage === "review" && draft ? <NotesWorkbench draft={draft} onChange={setDraft} onStartOver={startOver} /> : null}
          {stage === "source" && !draft ? (
            <aside className="capture-tip">
              <h2>How it works</h2>
              <ol>
                <li>Pick where your lesson is from.</li>
                <li>Check the words we found.</li>
                <li>Luma makes notes and flashcards. Keep the ones you like.</li>
              </ol>
            </aside>
          ) : null}
        </div>
      </div>
    </>
  )
}
