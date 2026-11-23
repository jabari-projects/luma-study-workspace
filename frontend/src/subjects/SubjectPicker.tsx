import { useEffect, useId, useMemo, useRef, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"
import { CaretDown, CaretLeft, X } from "@phosphor-icons/react"

import { NO_SUBJECT, findSubject, groupedSubjects, matchLabel, searchSubjects, subjectLabel } from "./subjects"
import type { Subject, SubjectChoice, SubjectList } from "./subjects"
import { useSubjects } from "./useSubjects"

/** One row the student can pick, in the order the keyboard moves through them. */
type Option = { key: string; label: string; detail?: string; onPick: () => void; group?: string }

/**
 * "Subject (optional)": pick a subject, then (if you like) one of its subtopics.
 * A pop-up under the button on wide screens, a sheet from the bottom on phones.
 * Search box on top (a combobox): Up and Down move, Enter picks, Escape goes back a step or closes.
 */
export function SubjectPicker({
  value,
  onChange,
  hint = "A subject helps people find it if you share it.",
  disabled = false,
}: {
  value: SubjectChoice
  onChange: (next: SubjectChoice) => void
  /** A soft line under an empty picker, or null for none. */
  hint?: string | null
  disabled?: boolean
}) {
  const { list, failed, retry } = useSubjects()
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const labelId = useId()
  const valueId = useId()
  const hintId = useId()
  const label = subjectLabel(list, value.subject, value.subtopic)
  const text = failed ? "Subjects didn't load. Try again" : value.subject ? label || "Subject saved" : "Pick a subject"

  const close = (focusButton = true) => {
    setOpen(false)
    if (focusButton) buttonRef.current?.focus()
  }

  return (
    <div className="subject-picker">
      <span className="subject-picker-label" id={labelId}>
        Subject (optional)
      </span>
      <div className="subject-picker-row">
        <button
          ref={buttonRef}
          type="button"
          className={value.subject ? "subject-picker-button chosen" : "subject-picker-button"}
          aria-labelledby={`${labelId} ${valueId}`}
          aria-describedby={!value.subject && hint ? hintId : undefined}
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => {
            if (failed) retry()
            else setOpen((now) => !now)
          }}
        >
          <span id={valueId}>{text}</span>
          <CaretDown weight="bold" aria-hidden="true" />
        </button>
        {value.subject ? (
          <button type="button" className="icon-button subject-clear" aria-label="Remove subject" disabled={disabled} onClick={() => onChange(NO_SUBJECT)}>
            <X weight="bold" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {!value.subject && hint ? (
        <small id={hintId} className="muted subject-picker-hint">
          {hint}
        </small>
      ) : null}
      {open ? (
        <SubjectPanel
          list={list}
          value={value}
          onPick={(next) => {
            onChange(next)
            close()
          }}
          onClose={close}
        />
      ) : null}
    </div>
  )
}

function SubjectPanel({
  list,
  value,
  onPick,
  onClose,
}: {
  list: SubjectList | null
  value: SubjectChoice
  onPick: (next: SubjectChoice) => void
  onClose: (focusButton?: boolean) => void
}) {
  const [text, setText] = useState("")
  // Step 2 (a subject's subtopics) opens on the chosen subject, so changing a subtopic is one tap.
  const [subject, setSubject] = useState<Subject | null>(() => findSubject(list, value.subject))
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const optionId = (index: number) => `${listId}-option-${index}`

  useEffect(() => {
    inputRef.current?.focus()
  }, [subject])

  // A tap or click outside the panel closes it, without moving focus back (the student tapped elsewhere).
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const panel = panelRef.current
      const picker = panel?.closest(".subject-picker")
      if (picker && !picker.contains(event.target as Node)) onClose(false)
    }
    document.addEventListener("pointerdown", onDown)
    return () => document.removeEventListener("pointerdown", onDown)
  }, [onClose])

  const openSubject = (next: Subject) => {
    setSubject(next)
    setText("")
    setActive(0)
  }

  const options = useMemo<Option[]>(() => {
    if (!list) return []
    if (subject) {
      const wanted = text.trim().toLowerCase()
      const subs = subject.subtopics.filter((sub) => !sub.retired && (!wanted || sub.name.toLowerCase().includes(wanted)))
      return [
        ...(wanted ? [] : [{ key: "just", label: `Just ${subject.name}`, detail: "No subtopic", onPick: () => onPick({ subject: subject.slug, subtopic: null }) }]),
        ...subs.map((sub) => ({ key: sub.slug, label: sub.name, onPick: () => onPick({ subject: subject.slug, subtopic: sub.slug }) })),
      ]
    }
    if (text.trim()) {
      return searchSubjects(list, text).map((match) => ({
        key: match.kind === "subject" ? match.subject.slug : `${match.subject.slug}/${match.subtopic.slug}`,
        label: matchLabel(match),
        onPick: match.kind === "subject" ? () => openSubject(match.subject) : () => onPick({ subject: match.subject.slug, subtopic: match.subtopic.slug }),
      }))
    }
    return groupedSubjects(list).flatMap(({ group, subjects }) =>
      subjects.map((item) => ({ key: item.slug, label: item.name, group: group.name, onPick: () => openSubject(item) })),
    )
  }, [list, subject, text, onPick])

  const current = Math.min(active, Math.max(options.length - 1, 0))

  useEffect(() => {
    document.getElementById(optionId(current))?.scrollIntoView?.({ block: "nearest" })
    // optionId only depends on listId, which never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, options])

  const back = () => {
    setSubject(null)
    setText("")
    setActive(0)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setActive(Math.min(current + 1, options.length - 1))
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setActive(Math.max(current - 1, 0))
    } else if (event.key === "Home" && !text) {
      event.preventDefault()
      setActive(0)
    } else if (event.key === "End" && !text) {
      event.preventDefault()
      setActive(Math.max(options.length - 1, 0))
    } else if (event.key === "Enter") {
      // Never submit the form around the picker.
      event.preventDefault()
      options[current]?.onPick()
    } else if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      if (subject) back()
      else onClose()
    }
  }

  // Group headings sit between options; the keyboard skips them.
  let lastGroup: string | undefined
  const rows = options.map((option, index) => {
    const heading = option.group && option.group !== lastGroup ? option.group : null
    lastGroup = option.group
    return { option, index, heading }
  })

  return (
    <>
      <div className="subject-scrim" aria-hidden="true" />
      <div ref={panelRef} className="subject-panel" role="dialog" aria-label={subject ? `Pick a topic in ${subject.name}` : "Pick a subject"}>
        {subject ? (
          <div className="subject-step">
            <button type="button" className="text-button subject-back" onClick={back}>
              <CaretLeft weight="bold" aria-hidden="true" /> All subjects
            </button>
            <p className="subject-step-name">{subject.name}</p>
          </div>
        ) : null}
        <input
          ref={inputRef}
          className="subject-search"
          type="search"
          role="combobox"
          aria-label={subject ? `Search topics in ${subject.name}` : "Search subjects"}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={options.length ? optionId(current) : undefined}
          placeholder={subject ? `Search topics in ${subject.name}` : "Search, like algebra or Spanish"}
          value={text}
          autoComplete="off"
          onChange={(event) => {
            setText(event.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
        />
        {!list ? (
          <p className="muted subject-empty" role="status">
            Loading subjects...
          </p>
        ) : options.length === 0 ? (
          <p className="muted subject-empty" role="status">
            Nothing matches. You can skip this and use tags.
          </p>
        ) : null}
        <div className="subject-options" id={listId} role="listbox" aria-label={subject ? `Topics in ${subject.name}` : "Subjects"}>
          {rows.map(({ option, index, heading }) => (
            <div key={option.key} role="presentation">
              {heading ? (
                <p className="subject-group-name" aria-hidden="true">
                  {heading}
                </p>
              ) : null}
              <div
                id={optionId(index)}
                role="option"
                aria-selected={index === current}
                className={index === current ? "subject-option active" : "subject-option"}
                // Keep focus in the search box, so the keyboard keeps working after a tap.
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => index !== current && setActive(index)}
                onClick={option.onPick}
              >
                <span>{option.label}</span>
                {option.detail ? <small className="muted">{option.detail}</small> : null}
              </div>
            </div>
          ))}
        </div>
        <div className="subject-done">
          <button type="button" className="secondary-button small" onClick={() => onClose()}>
            Done
          </button>
        </div>
      </div>
    </>
  )
}
