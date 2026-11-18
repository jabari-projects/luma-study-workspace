import { useEffect, useId, useRef, useState } from "react"
import { WarningCircle } from "@phosphor-icons/react"

import "./work.css"

/**
 * Shown when a save finds a newer version (409) or finds the item deleted (404).
 * It never overwrites anything quietly: every choice is a button the student presses.
 */
export function ConflictPanel({
  noun,
  gone,
  busy = false,
  onSeeNewer,
  onKeepMine,
  onSaveAsNew,
  onThrowAway,
}: {
  /** "note", "summary" or "deck". */
  noun: string
  /** True for 404 item_gone: "This note was deleted somewhere else." */
  gone: boolean
  busy?: boolean
  onSeeNewer?: () => void
  onKeepMine?: () => void
  /** Leave out where a copy makes no sense (like the share button). */
  onSaveAsNew?: () => void
  onThrowAway?: () => void
}) {
  const titleId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)

  // Move focus here so a keyboard or screen reader user hears what happened right away.
  useEffect(() => {
    headingRef.current?.focus()
  }, [gone])

  return (
    <section className="work-conflict" role="group" aria-labelledby={titleId} aria-busy={busy || undefined}>
      <WarningCircle weight="duotone" aria-hidden="true" className="work-conflict-icon" />
      <div className="work-conflict-body">
        <h2 id={titleId} ref={headingRef} tabIndex={-1}>
          {gone ? `This ${noun} was deleted somewhere else.` : `This ${noun} was changed in another tab or on another device.`}
        </h2>
        <p>{gone ? "Your words are still here. Pick what to do." : "Nothing was saved over. Pick which one to keep."}</p>
        <div className="button-row">
          {!gone && onSeeNewer ? (
            <button type="button" className="secondary-button" onClick={onSeeNewer} disabled={busy}>
              See the newer one
            </button>
          ) : null}
          {!gone && onKeepMine ? (
            <button type="button" className="secondary-button" onClick={onKeepMine} disabled={busy}>
              Keep mine
            </button>
          ) : null}
          {onSaveAsNew ? (
            <button type="button" className="primary-button" onClick={onSaveAsNew} disabled={busy}>
              {busy ? "Saving..." : `Save mine as a new ${noun}`}
            </button>
          ) : null}
          {gone && onThrowAway ? (
            <button type="button" className="ghost-button" onClick={onThrowAway} disabled={busy}>
              Throw mine away
            </button>
          ) : null}
        </div>
      </div>
    </section>
  )
}

/** After "See the newer one": the student's own words, to copy from. */
export function YourVersionBox({ text, onClose }: { text: string; onClose: () => void }) {
  const boxId = useId()
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <section className="your-version" aria-labelledby={`${boxId}-title`}>
      <h2 id={`${boxId}-title`}>Your version</h2>
      <p>The newer one is in the editor now. Copy anything you want to keep from yours.</p>
      <label htmlFor={boxId} className="sr-only">
        Your version
      </label>
      <textarea id={boxId} readOnly value={text} rows={6} />
      <div className="button-row">
        <button type="button" className="secondary-button small" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy my text"}
        </button>
        <button type="button" className="ghost-button small" onClick={onClose}>
          Done
        </button>
      </div>
    </section>
  )
}
