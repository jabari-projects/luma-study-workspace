import { useCallback, useRef, useState } from "react"
import type { ChangeEvent } from "react"
import { Link } from "react-router-dom"
import { ArrowLeft, Microphone, Pause, Play, Stop, UploadSimple } from "@phosphor-icons/react"

import { NoticeBanner, PageHeader } from "../ui/common"
import { Scribble } from "../ui/Scribble"
import { CaptureError, makeNotes, transcribeAudio } from "./capture-api"
import type { NotesDraft } from "./capture-api"
import { LimitNudge, NotesWorkbench, WorkingSteps } from "./Workbench"
import { MAX_RECORDING_SECONDS, canRecord, formatClock, useRecorder } from "./useRecorder"

const MAX_AUDIO_BYTES = 25 * 1024 * 1024
const AUDIO_ACCEPT = "audio/*,.mp3,.m4a,.wav,.webm,.ogg"
const BAR_COUNT = 14

type Stage = "capture" | "working" | "transcript" | "review"

export function AudioToNotesPage() {
  const barsRef = useRef<HTMLDivElement>(null)
  const onLevel = useCallback((level: number) => {
    const bars = barsRef.current?.children
    if (!bars || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    for (let index = 0; index < bars.length; index += 1) {
      const wobble = 0.55 + 0.45 * Math.sin(index * 1.7 + performance.now() / 160)
      const height = Math.max(0.08, Math.min(1, level * wobble * (1 - Math.abs(index - BAR_COUNT / 2) / BAR_COUNT)))
      ;(bars[index] as HTMLElement).style.transform = `scaleY(${height.toFixed(3)})`
    }
  }, [])
  const recorder = useRecorder(onLevel)

  const [file, setFile] = useState<File | null>(null)
  const [stage, setStage] = useState<Stage>("capture")
  const [step, setStep] = useState(0)
  const [transcript, setTranscript] = useState("")
  const [hint, setHint] = useState("")
  const [draft, setDraft] = useState<NotesDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [limit, setLimit] = useState<string | null>(null)

  const live = recorder.state === "recording" || recorder.state === "paused"
  const audioToSend = file
    ? { blob: file as Blob, filename: file.name, label: "Uploaded sound file" }
    : recorder.recording
      ? { blob: recorder.recording.blob, filename: recorder.recording.filename, label: `Recording (${formatClock(recorder.recording.seconds)})` }
      : null

  const pickFile = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0] ?? null
    event.target.value = ""
    setError(null)
    if (!chosen) return
    if (chosen.size > MAX_AUDIO_BYTES) {
      setError("That file is too big. Try one under 25 MB.")
      return
    }
    recorder.reset()
    setTranscript("")
    setFile(chosen)
  }

  // Step 1: turn the sound into words. The student checks and fixes them next.
  const listen = async () => {
    if (!audioToSend) return
    setError(null)
    setLimit(null)
    setStage("working")
    setStep(0)
    try {
      const heard = await transcribeAudio(audioToSend.blob, audioToSend.filename, hint)
      setTranscript(heard)
      setStage("transcript")
    } catch (err: unknown) {
      setStage("capture")
      if (err instanceof CaptureError && err.limitReached) setLimit(err.message)
      else setError(err instanceof Error ? err.message : "Something went wrong. Your recording is still here.")
    }
  }

  // Step 2: make notes from the (possibly corrected) words.
  const makeFromWords = async () => {
    const words = transcript.trim()
    if (!words) {
      setError("There are no words to make notes from. Type some, or start over.")
      return
    }
    setError(null)
    setLimit(null)
    setStage("working")
    setStep(1)
    const timer = window.setTimeout(() => setStep(2), 6000)
    try {
      setDraft(await makeNotes(words, "audio", audioToSend?.label ?? "Recording"))
      setStage("review")
    } catch (err: unknown) {
      setStage("transcript")
      if (err instanceof CaptureError && err.limitReached) setLimit(err.message)
      else setError(err instanceof Error ? err.message : "Something went wrong. Your words are still here.")
    } finally {
      window.clearTimeout(timer)
    }
  }

  const startOver = () => {
    recorder.reset()
    setFile(null)
    setTranscript("")
    setDraft(null)
    setError(null)
    setStage("capture")
  }

  const toggleMic = () => {
    if (recorder.state === "recording" || recorder.state === "paused") recorder.stop()
    else {
      setFile(null)
      setTranscript("")
      void recorder.start()
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Create"
        title={
          <>
            Talk it, <Scribble type="underline">keep it</Scribble>.
          </>
        }
        description="Upload audio and turn it into text. Then Luma makes notes and flashcards for you."
      />

      {limit ? <LimitNudge message={limit} onClose={() => setLimit(null)} /> : null}
      <NoticeBanner notice={error ? { type: "error", text: error } : recorder.error && recorder.state === "error" ? { type: "error", text: recorder.error } : null} />

      <div className={stage === "review" ? "capture-layout has-results" : "capture-layout"}>
        <section className={stage === "review" ? "capture-source collapsed" : "capture-source"} aria-label="Your audio">
          {stage === "review" ? (
            <button type="button" className="ghost-button small back-to-source" onClick={() => setStage("capture")}>
              <ArrowLeft weight="bold" aria-hidden="true" /> Back to my audio
            </button>
          ) : null}

          {draft && stage === "capture" ? (
            <button type="button" className="primary-button back-to-notes" onClick={() => setStage("review")}>
              Back to my notes
            </button>
          ) : null}

          <div
            className={
              recorder.state === "recording"
                ? "recorder-deck is-live"
                : recorder.state === "paused"
                  ? "recorder-deck is-paused"
                  : "recorder-deck"
            }
          >
            <div className="reels" aria-hidden="true">
              <span className="reel" />
              <span className="tape-window" />
              <span className="reel" />
            </div>
            <button
              type="button"
              className={live ? "star-mic on" : "star-mic"}
              onClick={toggleMic}
              aria-label={live ? "Stop recording" : "Start recording"}
              disabled={recorder.state === "asking" || stage === "working" || !canRecord()}
            >
              {live ? <Stop weight="fill" aria-hidden="true" /> : <Microphone weight="fill" aria-hidden="true" />}
            </button>
            <div className="level-meter" ref={barsRef} aria-hidden="true">
              {Array.from({ length: BAR_COUNT }, (_, index) => (
                <span key={index} />
              ))}
            </div>
            <p className="sr-only" role="status">
              {recorder.state === "asking"
                ? "Waiting for the mic."
                : recorder.state === "recording"
                  ? recorder.seconds >= MAX_RECORDING_SECONDS - 60
                    ? "Recording. One minute left."
                    : "Recording."
                  : recorder.state === "paused"
                    ? "Paused."
                    : recorder.state === "done"
                      ? recorder.seconds >= MAX_RECORDING_SECONDS
                        ? "Recording stopped at 10 minutes and saved."
                        : "Recording saved."
                      : ""}
            </p>
            <p className="rec-status" aria-hidden={live ? "true" : undefined}>
              {recorder.state === "asking"
                ? "Say yes to the mic question..."
                : recorder.state === "recording"
                  ? `Recording ${formatClock(recorder.seconds)}`
                  : recorder.state === "paused"
                    ? `Paused at ${formatClock(recorder.seconds)}. Tap Keep going.`
                    : canRecord()
                      ? "Tap the mic to record"
                      : "This browser can't record, but you can upload a file."}
            </p>
            {recorder.state === "recording" && recorder.seconds >= MAX_RECORDING_SECONDS - 60 ? (
              <p className="hand-note">Almost out of tape!</p>
            ) : null}
            {live ? (
              <div className="button-row center">
                {recorder.state === "recording" ? (
                  <button type="button" className="secondary-button small" onClick={recorder.pause}>
                    <Pause weight="fill" aria-hidden="true" /> Pause
                  </button>
                ) : (
                  <button type="button" className="secondary-button small" onClick={recorder.resume}>
                    <Play weight="fill" aria-hidden="true" /> Keep going
                  </button>
                )}
                <button type="button" className="primary-button small" onClick={recorder.stop}>
                  <Stop weight="fill" aria-hidden="true" /> Done
                </button>
              </div>
            ) : null}
          </div>

          {!live ? (
            <label className="upload-link">
              <UploadSimple weight="bold" aria-hidden="true" />
              <span>Or pick a sound file</span>
              <small>MP3, M4A, WAV, WEBM or OGG. Up to 25 MB.</small>
              <small>Free plan: each recording uses 1 talk-to-text turn and 1 notes turn.</small>
              <input
                type="file"
                accept={AUDIO_ACCEPT}
                onChange={pickFile}
                disabled={stage === "working" || recorder.state === "asking"}
              />
            </label>
          ) : null}

          {audioToSend && !live && stage !== "working" && stage !== "transcript" && recorder.state !== "asking" ? (
            <div className="audio-ready ruled-block">
              <p className="ready-label">{file ? `File: ${file.name}` : "Your recording"}</p>
              {recorder.recording && !file ? <audio controls src={recorder.recording.url} /> : null}
              {transcript ? (
                <details className="heard">
                  <summary>What we heard</summary>
                  <p>{transcript}</p>
                </details>
              ) : null}
              {!transcript ? (
                <label className="hint-field">
                  Names or words to listen for (optional)
                  <input
                    value={hint}
                    maxLength={300}
                    onChange={(event) => setHint(event.target.value)}
                    placeholder="Ms. Okafor, Nkrumah, photosynthesis"
                    aria-describedby="hint-help"
                  />
                  <small id="hint-help" className="field-hint">
                    Helps Luma spell names and new words right.
                  </small>
                </label>
              ) : null}
              <div className="button-row">
                {transcript ? (
                  <button type="button" className={draft ? "secondary-button" : "primary-button"} onClick={() => setStage("transcript")}>
                    Fix the words and make new notes
                  </button>
                ) : (
                  <button type="button" className="primary-button" onClick={() => void listen()}>
                    Turn it into words
                  </button>
                )}
                <button type="button" className="ghost-button" onClick={startOver}>
                  Start over
                </button>
              </div>
            </div>
          ) : null}

          <p className="hand-note privacy-note">
            Your notes are private unless you share them. Luma sends your recording to OpenAI (or Deepgram as a backup) to turn
            it into words, then sends the words to OpenAI to make notes. Luma does not save the recording.
          </p>
        </section>

        <div className="capture-results">
          {stage === "working" ? (
            <WorkingSteps steps={["Listening...", "Writing notes...", "Making cards..."]} current={step} />
          ) : null}
          {stage === "transcript" ? (
            <section className="ruled-block transcript-editor" aria-labelledby="transcript-heading">
              <h2 id="transcript-heading">Check the words</h2>
              <p className="muted">
                Fix names, numbers or anything we heard wrong. Your notes are made from these words.
              </p>
              <label>
                What we heard
                <textarea
                  value={transcript}
                  onChange={(event) => setTranscript(event.target.value)}
                  rows={10}
                  spellCheck
                />
              </label>
              <div className="button-row">
                <button type="button" className="primary-button" onClick={() => void makeFromWords()}>
                  Make my notes
                </button>
                <button type="button" className="ghost-button" onClick={startOver}>
                  Start over
                </button>
              </div>
              <p className="field-hint">Free plan: making notes uses 1 notes turn.</p>
            </section>
          ) : null}
          {stage === "review" && draft ? <NotesWorkbench draft={draft} onChange={setDraft} onStartOver={startOver} /> : null}
          {stage === "capture" && !draft ? (
            <aside className="capture-tip">
              <h2>How it works</h2>
              <ol>
                <li>Record your class or yourself talking. You can also pick a sound file.</li>
                <li>Luma turns the sound into words.</li>
                <li>You get notes and flashcards. Keep the ones you like.</li>
              </ol>
              <p className="muted small-text">
                Have a video or a document instead? <Link to="/notes/import">Import it</Link>.
              </p>
            </aside>
          ) : null}
        </div>
      </div>
    </>
  )
}
