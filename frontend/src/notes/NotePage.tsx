import { useEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { toast } from "sonner"
import { ArrowLeft, Cards, Check, Lightbulb, MagicWand, PencilSimple, TextAlignLeft, Trash, X } from "@phosphor-icons/react"

import { api, getErrorMessage, getTabAccountId } from "../api"
import { CaptureError, makeNotes, makeSummary } from "../capture/capture-api"
import { newCardId } from "../study/deck"
import { ConfirmDialog } from "../ui/ConfirmDialog"
import { NoticeBanner, PageHeader } from "../ui/common"
import type { Notice, StudyType } from "../ui/common"
import { ShareControl } from "../ui/Share"
import { sharedLine, useShareName } from "../ui/sharing"
import { DraftOffer } from "../work/DraftOffer"
import { LEAVE_ANYWAY_STATE } from "../work/leave"
import { newCreateKey, useEditSession } from "../work/useAutosave"
import { useExplicitWork } from "../work/useExplicitWork"
import { NoteMarkdown } from "./markdown"
import { aiCardsToFound, findCardsInNote } from "./findCards"
import type { FoundCard } from "./findCards"

type NoteItem = {
  id: string
  title?: string
  content?: string
  tags?: string[]
  is_public?: boolean
  created_at?: string
  updated_at?: string | null
  [key: string]: unknown
}

function friendlyDate(value?: string | null) {
  if (!value) return ""
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

type MadeSummary = { title: string; summary: string }
/** A made summary that isn't saved yet, with the Idempotency-Key its save uses. */
type HeldSummary = { made: MadeSummary; key: string }

function isHeldSummary(value: unknown): value is HeldSummary {
  const v = value as Partial<HeldSummary> | null
  return Boolean(v && typeof v.key === "string" && v.made && typeof v.made.title === "string" && typeof v.made.summary === "string")
}

type NotePageProps = { endpoint: string; studyType: StudyType; backTo: string; kindLabel: string }

/**
 * A saved note (or summary) shown as a clean page, with one-tap flashcards made from it.
 * `backTo` is the Notes hub (its Summaries tab for a summary).
 *
 * Each note gets a fresh page: going from a note to its new summary (or any other item)
 * starts with no open box, no notice and no extra AI cards left over from before.
 */
export function NotePage(props: NotePageProps) {
  const { itemId } = useParams()
  return <NoteView key={`${props.endpoint}/${itemId ?? ""}`} {...props} />
}

function NoteView({ endpoint, studyType, backTo, kindLabel }: NotePageProps) {
  const { itemId } = useParams()
  const navigate = useNavigate()
  const [state, setState] = useState<{ id?: string; item: NoteItem | null; error: string | null }>({ item: null, error: null })
  const [notice, setNotice] = useState<Notice | null>(null)
  const [extraCards, setExtraCards] = useState<FoundCard[] | null>(null)
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const [askingAi, setAskingAi] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmingSummary, setConfirmingSummary] = useState(false)
  const [summarizing, setSummarizing] = useState(false)
  // What happened with "Make a summary", shown right under its button (it can sit far down the page).
  const [summaryNotice, setSummaryNotice] = useState<Notice | null>(null)
  // A summary the AI made but we couldn't save. The next tap only tries saving again, so no new AI turn.
  const [unsavedSummary, setUnsavedSummary] = useState<MadeSummary | null>(null)
  // One Idempotency-Key per made summary and per deck from this note: a retry never makes copies.
  const [summaryKey, setSummaryKey] = useState(newCreateKey)
  const deckKey = useRef(newCreateKey())
  const [accountId] = useState(() => getTabAccountId())
  const { headers: sessionHeaders } = useEditSession()
  const heldSummary = useMemo<HeldSummary | null>(() => (unsavedSummary ? { made: unsavedSummary, key: summaryKey } : null), [unsavedSummary, summaryKey])
  const summaryWork = useExplicitWork<HeldSummary>({
    label: "Your new summary",
    accountId,
    kind: "summary-result",
    itemId: itemId ?? "none",
    data: heldSummary,
    saving: false,
    textOf: (held) => [held.made.title, held.made.summary].filter(Boolean).join("\n\n"),
    accept: isHeldSummary,
    onDiscard: () => setUnsavedSummary(null),
  })
  const summaryNoticeRef = useRef<HTMLDivElement>(null)
  // False once the student leaves this note, so a slow AI answer doesn't pull them back here.
  const onThisNote = useRef(true)
  const shareName = useShareName()

  useEffect(() => {
    onThisNote.current = true
    return () => {
      onThisNote.current = false
    }
  }, [])

  useEffect(() => {
    if (summaryNotice) summaryNoticeRef.current?.scrollIntoView?.({ block: "nearest" })
  }, [summaryNotice])

  useEffect(() => {
    if (!itemId) return
    let active = true
    api
      .get<NoteItem>(`${endpoint}/${itemId}`)
      .then((response) => active && setState({ id: itemId, item: response.data, error: null }))
      .catch((error: unknown) => active && setState({ id: itemId, item: null, error: getErrorMessage(error, "We could not find this note.") }))
    return () => {
      active = false
    }
  }, [endpoint, itemId])

  const loading = Boolean(itemId) && state.id !== itemId
  const item = state.id === itemId ? state.item : null
  const content = typeof item?.content === "string" ? item.content : ""
  const title = (typeof item?.title === "string" && item.title.trim()) || "Untitled"

  const found = useMemo(() => findCardsInNote(content), [content])
  const cards = useMemo(
    () => [...found, ...(extraCards ?? [])].map((card) => ({ ...card, keep: overrides[card.id] ?? card.keep })),
    [found, extraCards, overrides],
  )
  const kept = cards.filter((card) => card.keep)

  const askAi = async () => {
    if (!content.trim()) return
    setAskingAi(true)
    try {
      const draft = await makeNotes(content, "paste", title)
      const fresh = aiCardsToFound(draft.cards, cards)
      setExtraCards((current) => [...(current ?? []), ...fresh])
      toast.success(fresh.length ? `Luma found ${fresh.length} more card${fresh.length === 1 ? "" : "s"}.` : "No new cards this time.")
    } catch (error: unknown) {
      if (error instanceof CaptureError && error.limitReached) {
        setNotice({ type: "info", text: error.message })
      } else {
        setNotice({ type: "error", text: getErrorMessage(error, "We couldn't make more cards right now.") })
      }
    } finally {
      setAskingAi(false)
    }
  }

  const makeDeck = async () => {
    if (kept.length === 0) return
    setSaving(true)
    // Make the deck in the account that showed this note, even if the tab switches meanwhile.
    const accountId = getTabAccountId() ?? undefined
    try {
      const response = await api.post<{ id: string }>(
        "/flashcards",
        {
          title: `${title} cards`.slice(0, 200),
          tags: Array.isArray(item?.tags) ? item!.tags!.slice(0, 5) : [],
          cards: kept.map((card) => ({ id: newCardId(), front: card.front, back: card.back, review: null })),
        },
        { lumaAccountId: accountId, timeout: 30_000, headers: { ...sessionHeaders(), "Idempotency-Key": deckKey.current } },
      )
      deckKey.current = newCreateKey()
      if ((getTabAccountId() ?? undefined) !== accountId) return
      toast.success("Your deck is ready!")
      navigate(`/flashcards/${response.data.id}`)
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "We couldn't make the deck. Your note is safe.") })
    } finally {
      setSaving(false)
    }
  }

  // Make a summary (notes only): the student says yes first, because it uses 1 AI notes turn.
  // The summary is saved to their summaries, so it shows in the Notes hub's Summaries tab.
  // If the AI made it but saving failed, the next tap only tries saving again (no new AI turn).
  const makeSummaryOfNote = async () => {
    if (!content.trim() || summarizing) return
    setSummarizing(true)
    setSummaryNotice(null)
    // Save it in the account that showed this note, even if the tab switches meanwhile.
    const accountId = getTabAccountId() ?? undefined
    let made = unsavedSummary
    if (!made) {
      try {
        made = await makeSummary(content)
      } catch (error: unknown) {
        // The student left this note: nothing was saved, so there is nothing to tell them.
        if (!onThisNote.current) return
        setSummarizing(false)
        setConfirmingSummary(false)
        if (error instanceof CaptureError && error.limitReached) {
          setSummaryNotice({ type: "info", text: error.message })
        } else {
          setSummaryNotice({ type: "error", text: getErrorMessage(error, "We couldn't make a summary right now.") })
        }
        return
      }
    }
    try {
      const response = await api.post<{ id: string }>(
        "/summaries",
        {
          title: (made.title || `Summary of ${title}`).slice(0, 200),
          content: made.summary,
          tags: Array.isArray(item?.tags) ? item!.tags!.slice(0, 5) : [],
        },
        { lumaAccountId: accountId, timeout: 30_000, headers: { ...sessionHeaders(), "Idempotency-Key": summaryKey } },
      )
      setSummaryKey(newCreateKey())
      const summaryPath = `/summaries/${response.data.id}`
      if (!onThisNote.current) {
        // They moved on while Luma was working: don't pull them back. Let them open it if they want.
        if ((getTabAccountId() ?? undefined) === accountId) {
          toast.success("Your summary is ready!", { action: { label: "Open it", onClick: () => navigate(summaryPath) } })
        }
        return
      }
      setUnsavedSummary(null)
      setConfirmingSummary(false)
      if ((getTabAccountId() ?? undefined) !== accountId) return
      toast.success("Your summary is ready!")
      // Saved and confirmed, so leaving needs no "are you sure?".
      navigate(summaryPath, { state: LEAVE_ANYWAY_STATE })
    } catch (error: unknown) {
      if (!onThisNote.current) {
        toast.error(getErrorMessage(error, "We made your summary but couldn't save it. Your note is safe."))
        return
      }
      setUnsavedSummary(made)
      setConfirmingSummary(false)
      setSummaryNotice({ type: "error", text: "We made it but couldn't save it. Tap to try saving again." })
    } finally {
      if (onThisNote.current) setSummarizing(false)
    }
  }

  const deleteItem = async () => {
    if (!itemId) return
    setDeleting(true)
    try {
      await api.delete(`${endpoint}/${itemId}`, { lumaAccountId: getTabAccountId() ?? undefined })
      toast.success(`Deleted “${title}”.`)
      navigate(backTo, { replace: true })
    } catch (error: unknown) {
      setConfirmingDelete(false)
      setNotice({ type: "error", text: getErrorMessage(error, `We couldn't delete this ${kindLabel.toLowerCase()}. It is still here.`) })
    } finally {
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="loading-card" role="status">
        <span className="spinner" />
        <p>Opening your {kindLabel.toLowerCase()}...</p>
      </div>
    )
  }

  if (!item) {
    return (
      <>
        <PageHeader title={`${kindLabel} not found`} />
        <NoticeBanner notice={{ type: "error", text: state.error ?? "We could not find this note." }} />
        <Link className="secondary-button" to={backTo}>
          <ArrowLeft weight="bold" aria-hidden="true" /> Back to notes
        </Link>
      </>
    )
  }

  return (
    <>
      {/* Back link on top, then the title, then this note's own actions in one short row. */}
      <header className="page-head note-head">
        <div>
          <Link className="back-link" to={backTo}>
            <ArrowLeft weight="bold" aria-hidden="true" /> Back to notes
          </Link>
          <p className="kicker">{`${kindLabel} · ${item.is_public ? "Shared" : "Private"}`}</p>
          <h1>{title}</h1>
          <p className="lede">
            {[friendlyDate(item.updated_at ?? item.created_at), item.is_public ? sharedLine(shareName) : ""]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="page-head-actions">
          <Link className="secondary-button" to={`${endpoint}/${itemId}/edit`}>
            <PencilSimple weight="bold" aria-hidden="true" /> Edit
          </Link>
          <ShareControl
            endpoint={endpoint}
            studyType={studyType}
            noun={kindLabel.toLowerCase()}
            item={item}
            onUpdated={(updated) => setState({ id: itemId, item: updated, error: null })}
            setNotice={setNotice}
          />
          <button type="button" className="ghost-button danger-text" onClick={() => setConfirmingDelete(true)}>
            <Trash weight="bold" aria-hidden="true" /> Delete
          </button>
        </div>
      </header>
      <NoticeBanner notice={notice} />
      {summaryWork.offer && !unsavedSummary ? (
        <DraftOffer
          text="You have a summary from earlier in this tab that isn't saved yet."
          onUse={() => {
            const held = summaryWork.takeOffer()
            if (!held) return
            setSummaryKey(held.key)
            setUnsavedSummary(held.made)
            setSummaryNotice({ type: "info", text: "Your summary isn't saved yet. Tap to save it." })
          }}
          onThrowAway={summaryWork.dropOffer}
        />
      ) : null}

      {/* The note on a sheet of paper, and a quiet margin beside it for studying it. */}
      <div className="with-margin note-layout">
        <article className="sheet-note note-sheet" aria-label={title}>
          {content.trim() ? <NoteMarkdown source={content} /> : <p className="muted">This note is empty.</p>}
          {Array.isArray(item.tags) && item.tags.length > 0 ? (
            <p className="tag-row">
              {item.tags.map((tag) => (
                <span key={tag}>#{tag}</span>
              ))}
            </p>
          ) : null}
        </article>

        <aside className="margin note-study" aria-labelledby="study-this">
          <h2 id="study-this">
            <Cards weight="duotone" aria-hidden="true" /> Study this {kindLabel.toLowerCase()}
          </h2>
          {cards.length > 0 ? (
            <>
              <p className="small-text muted" aria-live="polite">
                {found.length > 0
                  ? `We found ${found.length} card${found.length === 1 ? "" : "s"} in your ${kindLabel.toLowerCase()}.`
                  : "Here are cards Luma made for you."}{" "}
                Keep the ones you want.
              </p>
              <ul className="found-cards" role="list">
                {cards.map((card, index) => (
                  <li
                    key={card.id}
                    className={card.keep ? "found-card" : "found-card tossed"}
                    style={{ "--tilt": `${[-0.6, 0.5, -0.3, 0.7][index % 4]}deg` } as CSSProperties}
                  >
                    <div>
                      <p className="mini-q">{card.front}</p>
                      <p className="mini-a">{card.back}</p>
                      {card.source === "ai" ? <span className="ai-badge">Made by AI · check it</span> : null}
                    </div>
                    <button
                      type="button"
                      className={card.keep ? "keep-toggle on" : "keep-toggle"}
                      aria-pressed={card.keep}
                      aria-label={card.keep ? `Keeping: ${card.front}. Tap to leave it out.` : `Left out: ${card.front}. Tap to keep it.`}
                      onClick={() => setOverrides((current) => ({ ...current, [card.id]: !card.keep }))}
                    >
                      {card.keep ? <Check weight="bold" aria-hidden="true" /> : <X weight="bold" aria-hidden="true" />}
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="primary-button wide" onClick={() => void makeDeck()} disabled={saving || kept.length === 0}>
                <Cards weight="bold" aria-hidden="true" /> {saving ? "Making..." : `Make a deck (${kept.length})`}
              </button>
            </>
          ) : (
            <div className="note-tip">
              <Lightbulb size={28} weight="duotone" aria-hidden="true" />
              <p>
                <strong>Tip:</strong> write a question, then <code>::</code>, then the answer. Like{" "}
                <code>Capital of France :: Paris</code>. Luma turns those lines into flashcards.
              </p>
            </div>
          )}
          {content.trim().length >= 20 ? (
            <button type="button" className="ghost-button wide" onClick={() => void askAi()} disabled={askingAi}>
              <MagicWand weight="bold" aria-hidden="true" /> {askingAi ? "Thinking..." : "Ask AI for more cards"}
            </button>
          ) : null}
          {content.trim().length >= 20 ? (
            <p className="muted small-text ai-note">AI cards use one of your free AI turns for today. Always check them.</p>
          ) : null}
          {studyType === "note" && content.trim().length >= 20 ? (
            <div className="note-summary-tool">
              <h3>Short on time?</h3>
              <p className="small-text muted">Luma can write a short summary of this note for you.</p>
              {/* Not "disabled" while saving, so focus stays on it; a second tap does nothing. */}
              <button
                type="button"
                className="secondary-button wide"
                aria-disabled={summarizing || undefined}
                onClick={() => {
                  if (summarizing) return
                  if (unsavedSummary) void makeSummaryOfNote()
                  else setConfirmingSummary(true)
                }}
              >
                <TextAlignLeft weight="bold" aria-hidden="true" />{" "}
                {unsavedSummary ? (summarizing ? "Saving..." : "Try saving again") : "Make a summary"}
              </button>
              <div ref={summaryNoticeRef}>
                <NoticeBanner notice={summaryNotice} />
              </div>
            </div>
          ) : null}
        </aside>
      </div>

      {confirmingSummary ? (
        <ConfirmDialog
          tone="primary"
          title="Make a summary?"
          body="Luma will write a short summary. This uses 1 of your AI notes for today."
          confirmLabel="Make summary"
          busyLabel="Making..."
          cancelLabel="Not now"
          busy={summarizing}
          onConfirm={() => void makeSummaryOfNote()}
          onCancel={() => setConfirmingSummary(false)}
        />
      ) : null}

      {confirmingDelete ? (
        <ConfirmDialog
          title={`Delete “${title}”?`}
          body="You can't get it back."
          confirmLabel="Delete"
          busyLabel="Deleting..."
          cancelLabel="Keep it"
          busy={deleting}
          onConfirm={() => void deleteItem()}
          onCancel={() => setConfirmingDelete(false)}
        />
      ) : null}
    </>
  )
}
