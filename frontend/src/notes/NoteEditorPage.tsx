import { useEffect, useRef, useState } from "react"
import type { FocusEvent, FormEvent, ReactNode } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { toast } from "sonner"
import { ArrowLeft, Lightbulb } from "@phosphor-icons/react"

import { api, getErrorMessage, getTabAccountId } from "../api"
import { NoticeBanner } from "../ui/common"
import type { Notice } from "../ui/common"
import { Scribble } from "../ui/Scribble"
import { ConflictPanel, YourVersionBox } from "../work/ConflictPanel"
import { DraftOffer } from "../work/DraftOffer"
import { SaveStatus } from "../work/SaveStatus"
import { clearDraft, readDraft, sessionDraftStore } from "../work/drafts"
import type { Draft } from "../work/drafts"
import { newCreateKey, toReply, useAutosave } from "../work/useAutosave"
import { NOTES_HUB, defaultNoteTitle, parseTags } from "./paths"

type Fields = { title: string; content: string; tags: string }
type NoteRow = { id: string; title?: string; content?: string; tags?: string[]; version?: number }
type Kind = "note" | "summary"

/** Autosave waits this long after the last change (B.4). */
const AUTOSAVE_MS = 1500

// A new note becomes its edit page after the first save. The words and version go along,
// so the edit page doesn't load the note again over what the student is typing.
const justCreated = new Map<string, { fields: Fields; version: number; savedAt: number | null }>()

function fieldsFrom(row: NoteRow): Fields {
  return {
    title: typeof row.title === "string" ? row.title : "",
    content: typeof row.content === "string" ? row.content : "",
    tags: Array.isArray(row.tags) ? row.tags.join(", ") : "",
  }
}

function isFields(value: unknown): value is Fields {
  const v = value as Partial<Fields> | null
  return Boolean(v && typeof v.title === "string" && typeof v.content === "string" && typeof v.tags === "string")
}

const body = (fields: Fields) => ({ title: fields.title.trim().slice(0, 200), content: fields.content, tags: parseTags(fields.tags) })
const textOf = (fields: Fields) => [fields.title.trim(), fields.content.trim()].filter(Boolean).join("\n\n")

/** Why these words can't be saved yet, or null. A summary may have no title. */
function problem(kind: Kind, fields: Fields): string | null {
  if (kind === "note" && !fields.title.trim()) return `Give your ${kind} a title.`
  if (!fields.content.trim()) return "Write something first."
  return null
}

/**
 * Write a new note (/notes/new) or change a saved one (/notes/:id/edit, /summaries/:id/edit).
 * A saved note saves by itself a moment after each change. A new note is saved with its Save
 * button first (so no half notes show up in the list), then it saves by itself too.
 * Unsaved words are kept only in this tab, for this account.
 */
export function NoteEditorPage({ kind = "note" }: { kind?: Kind }) {
  const { itemId } = useParams()
  // This tab's account when the page opened. Saving goes to it, even if the tab switches.
  const [accountId] = useState(() => getTabAccountId())
  if (!itemId) return <NewNote key="new" kind={kind} accountId={accountId} />
  return <LoadNote key={itemId} kind={kind} accountId={accountId} itemId={itemId} />
}

function NewNote({ kind, accountId }: { kind: Kind; accountId: string | null }) {
  // A draft from earlier in this tab keeps its Idempotency-Key, so a reload and retry can't make a copy.
  const [start, setStart] = useState(() => {
    const draft = readDraft<Fields>(sessionDraftStore(), getTabAccountId(), accountId, kind, "new")
    const usable = draft && isFields(draft.data) ? draft : null
    return { round: 0, draft: usable, createKey: usable?.createKey ?? newCreateKey() }
  })
  return (
    <NoteForm
      key={start.round}
      kind={kind}
      accountId={accountId}
      itemId={null}
      version={null}
      createKey={start.createKey}
      initial={{ title: defaultNoteTitle(), content: "", tags: "" }}
      offer={start.draft}
      onThrowAwayOffer={() => {
        clearDraft(sessionDraftStore(), accountId, kind, "new")
        setStart((current) => ({ round: current.round + 1, draft: null, createKey: newCreateKey() }))
      }}
    />
  )
}

function LoadNote({ kind, accountId, itemId }: { kind: Kind; accountId: string | null; itemId: string }) {
  const endpoint = kind === "summary" ? "/summaries" : "/notes"
  const [handoff] = useState(() => justCreated.get(itemId) ?? null)
  const [state, setState] = useState<{ row: NoteRow | null; error: string | null }>({ row: null, error: null })

  useEffect(() => {
    justCreated.delete(itemId)
  }, [itemId])

  useEffect(() => {
    if (handoff) return
    let active = true
    api
      .get<NoteRow>(`${endpoint}/${itemId}`)
      .then((response) => active && setState({ row: response.data, error: null }))
      .catch((error: unknown) => active && setState({ row: null, error: getErrorMessage(error, `We could not find this ${kind}.`) }))
    return () => {
      active = false
    }
  }, [endpoint, handoff, itemId, kind])

  if (handoff) {
    return (
      <NoteForm
        kind={kind}
        accountId={accountId}
        itemId={itemId}
        version={handoff.version}
        savedAt={handoff.savedAt}
        createKey={null}
        initial={handoff.fields}
        offer={null}
      />
    )
  }
  if (state.error) {
    return <EditorFrame kind={kind} isNew={false} backTo={`${endpoint}/${itemId}`} notice={{ type: "error", text: state.error }} />
  }
  if (!state.row) {
    return (
      <div className="loading-card" role="status">
        <span className="spinner" />
        <p>Opening your {kind}...</p>
      </div>
    )
  }
  return <LoadedNote kind={kind} accountId={accountId} itemId={itemId} row={state.row} />
}

function LoadedNote({ kind, accountId, itemId, row }: { kind: Kind; accountId: string | null; itemId: string; row: NoteRow }) {
  // Read once when the note opens: a draft from earlier in this tab, for this account only.
  const [draft] = useState(() => readDraft<Fields>(sessionDraftStore(), getTabAccountId(), accountId, kind, itemId))
  return (
    <NoteForm
      kind={kind}
      accountId={accountId}
      itemId={itemId}
      version={typeof row.version === "number" ? row.version : 1}
      createKey={null}
      initial={fieldsFrom(row)}
      currentRow={row}
      offer={draft && isFields(draft.data) ? draft : null}
    />
  )
}

function EditorFrame({
  kind,
  isNew,
  backTo,
  notice,
  children,
}: {
  kind: Kind
  isNew: boolean
  backTo: string
  notice: Notice | null
  children?: ReactNode
}) {
  return (
    <div className="note-editor-page">
      <header className="page-head note-head">
        <div>
          <Link className="back-link" to={backTo}>
            <ArrowLeft weight="bold" aria-hidden="true" /> {isNew ? "Back to notes" : `Back to the ${kind}`}
          </Link>
          <h1>{isNew ? <>Write a <Scribble type="underline">note</Scribble></> : <>Change your <Scribble type="underline">{kind}</Scribble></>}</h1>
          <p className="lede">{isNew ? "Write it your way. Save it when you're ready." : "Luma saves your changes as you go."}</p>
        </div>
      </header>
      <NoticeBanner notice={notice} />
      {children}
    </div>
  )
}

function NoteForm({
  kind,
  accountId,
  itemId,
  version,
  createKey,
  initial,
  currentRow,
  offer,
  onThrowAwayOffer,
  savedAt = null,
}: {
  kind: Kind
  accountId: string | null
  itemId: string | null
  version: number | null
  savedAt?: number | null
  createKey: string | null
  initial: Fields
  /** The row as loaded (edit pages), for a draft that was based on an older version. */
  currentRow?: NoteRow
  offer: Draft<Fields> | null
  onThrowAwayOffer?: () => void
}) {
  const isNew = itemId === null
  const navigate = useNavigate()
  const endpoint = kind === "summary" ? "/summaries" : "/notes"
  const [fields, setFields] = useState<Fields>(initial)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [saving, setSaving] = useState(false)
  const [mine, setMine] = useState<string | null>(null)
  // A draft from earlier in this tab: same version -> offer it; older version -> conflict panel.
  const [pendingOffer, setPendingOffer] = useState<Draft<Fields> | null>(() =>
    offer && (offer.baseVersion ?? null) === (version ?? null) ? offer : null,
  )
  const [draftConflict, setDraftConflict] = useState<Fields | null>(() =>
    offer && (offer.baseVersion ?? null) !== (version ?? null) ? offer.data : null,
  )
  const [copyBusy, setCopyBusy] = useState(false)
  const copyKey = useRef<string | null>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const { title, content, tags } = fields

  const autosave = useAutosave<Fields, NoteRow>({
    label: kind === "summary" ? "Your summary" : "Your note",
    accountId,
    itemId,
    version,
    createKey,
    savedAt,
    debounceMs: AUTOSAVE_MS,
    autosave: true,
    textOf,
    rowHas: (row, sent) => row.title === body(sent).title && row.content === sent.content,
    draft: { kind, data: (value) => value },
    send: (request, config) => {
      const why = problem(kind, request.content)
      if (why) return Promise.resolve({ kind: "http", status: 422, data: { detail: why }, retryAfterHeader: null })
      if (request.mode === "create") {
        return toReply(() =>
          api.post<NoteRow>(endpoint, body(request.content), {
            ...config,
            headers: { ...config.headers, "Idempotency-Key": request.createKey ?? newCreateKey() },
          }),
        )
      }
      return toReply(() =>
        api.put<NoteRow>(`${endpoint}/${request.itemId}`, { ...body(request.content), expected_version: request.expectedVersion }, config),
      )
    },
  })
  const { snapshot } = autosave
  const backTo = isNew ? NOTES_HUB : `${endpoint}/${itemId}`
  const conflictRow = snapshot.state === "conflict" ? snapshot.current : draftConflict ? (currentRow ?? null) : null
  const showConflict = snapshot.state === "conflict" || snapshot.state === "gone" || draftConflict !== null

  /** Changes one field. Saved notes save by themselves; new ones wait for Save. */
  const change = (patch: Partial<Fields>) => {
    const next = { ...fields, ...patch }
    setFields(next)
    autosave.change(next)
  }

  // Leaving the form (not just moving between its fields) saves right away.
  const onBlur = (event: FocusEvent<HTMLFormElement>) => {
    if (isNew) return
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) void autosave.flush()
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setNotice(null)
    const why = problem(kind, fields)
    if (why) {
      setNotice({ type: "error", text: why })
      if (why === "Write something first.") bodyRef.current?.focus()
      return
    }
    setSaving(true)
    if (isNew) autosave.change(fields)
    const saved = await autosave.flush({ allowCreate: true })
    setSaving(false)
    if (!saved) return // The save line says why, and the words stay here.
    // Another account took over this tab while saving: the note is saved, but don't open it here.
    if ((getTabAccountId() ?? null) !== accountId) return
    if (isNew) {
      const now = autosave.peek()
      if (!now?.itemId || now.version === null) return
      toast.success("Saved your note!")
      justCreated.set(now.itemId, { fields, version: now.version, savedAt: now.savedAt })
      navigate(`${endpoint}/${now.itemId}/edit`, { replace: true })
      return
    }
    toast.success("Saved your changes.")
    navigate(`${endpoint}/${itemId}`, { replace: true })
  }

  const saveMineAsNew = async () => {
    const words = draftConflict ?? fields
    setCopyBusy(true)
    copyKey.current = copyKey.current ?? newCreateKey()
    const key = copyKey.current
    const reply = await toReply(() =>
      api.post<NoteRow>(
        endpoint,
        { ...body(words), title: body(words).title || `Copy of my ${kind}` },
        { lumaAccountId: accountId ?? undefined, headers: { "Idempotency-Key": key } },
      ),
    )
    setCopyBusy(false)
    if (reply.kind !== "ok" || !reply.row || typeof reply.row.version !== "number") {
      setNotice({ type: "error", text: "We couldn't save a copy. Your words are still here. Try again." })
      return
    }
    autosave.discard()
    if (draftConflict) clearDraft(sessionDraftStore(), accountId, kind, itemId ?? "new")
    toast.success(kind === "summary" ? "Saved yours as a new summary." : "Saved yours as a new note.")
    justCreated.set(reply.row.id, { fields: fieldsFrom(reply.row), version: reply.row.version, savedAt: Date.now() })
    navigate(`${endpoint}/${reply.row.id}/edit`, { replace: true })
  }

  const seeNewer = () => {
    const row = conflictRow
    if (!row) return
    setMine(textOf(draftConflict ?? fields))
    setFields(fieldsFrom(row))
    if (draftConflict) {
      clearDraft(sessionDraftStore(), accountId, kind, itemId ?? "new")
      setDraftConflict(null)
    } else {
      autosave.takeTheirs(row)
    }
  }

  const keepMine = () => {
    if (draftConflict) {
      setFields(draftConflict)
      autosave.change(draftConflict)
      setDraftConflict(null)
      return
    }
    const current = snapshot.current
    if (current && typeof current.version === "number") autosave.keepMine(current.version)
  }

  return (
    <EditorFrame kind={kind} isNew={isNew} backTo={backTo} notice={notice}>
      {showConflict ? (
        <ConflictPanel
          noun={kind}
          gone={snapshot.state === "gone"}
          busy={copyBusy}
          onSeeNewer={seeNewer}
          onKeepMine={keepMine}
          onSaveAsNew={() => void saveMineAsNew()}
          onThrowAway={() => {
            autosave.discard()
            navigate(NOTES_HUB, { replace: true })
          }}
        />
      ) : null}
      {mine !== null ? <YourVersionBox text={mine} onClose={() => setMine(null)} /> : null}
      {pendingOffer ? (
        <DraftOffer
          onUse={() => {
            setFields(pendingOffer.data)
            autosave.change(pendingOffer.data)
            setPendingOffer(null)
          }}
          onThrowAway={() => {
            setPendingOffer(null)
            if (onThrowAwayOffer) onThrowAwayOffer()
            else clearDraft(sessionDraftStore(), accountId, kind, itemId ?? "new")
          }}
        />
      ) : null}

      <form className="note-editor" onSubmit={save} onBlur={onBlur} noValidate>
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
              autoFocus={isNew && !offer}
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
          <button type="submit" className="primary-button" disabled={saving || showConflict || (isNew && Boolean(autosave.editBlocked))}>
            {saving ? "Saving..." : isNew ? "Save note" : "Save changes"}
          </button>
          {isNew ? (
            <Link className="secondary-button" to={backTo}>
              Cancel
            </Link>
          ) : null}
          <SaveStatus snapshot={snapshot} onRetry={autosave.retry} accountId={accountId} draftProblem={autosave.draftProblem} />
        </div>
        {autosave.editBlocked ? <p className="field-hint">{autosave.editBlocked}</p> : null}
      </form>
    </EditorFrame>
  )
}
