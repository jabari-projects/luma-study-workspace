import { useEffect, useMemo, useState } from "react"
import type { CSSProperties } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { toast } from "sonner"
import { ArrowLeft, Cards, Check, Lightbulb, MagicWand, X } from "@phosphor-icons/react"

import { api, getErrorMessage } from "../api"
import { CaptureError, makeNotes } from "../capture/capture-api"
import { newCardId } from "../study/deck"
import { NoticeBanner, PageHeader, PublishActionButton } from "../ui/common"
import type { Notice, StudyType } from "../ui/common"
import { NoteMarkdown } from "./markdown"
import { aiCardsToFound, findCardsInNote } from "./findCards"
import type { FoundCard } from "./findCards"

type NoteItem = {
  id: string
  title?: string
  content?: string
  tags?: string[]
  is_public?: boolean
  published_by?: string | null
  created_at?: string
  updated_at?: string | null
  [key: string]: unknown
}

function friendlyDate(value?: string | null) {
  if (!value) return ""
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

/** A saved note (or summary) shown as a clean page, with one-tap flashcards made from it. */
export function NotePage({ endpoint, studyType, backTo, kindLabel }: { endpoint: string; studyType: StudyType; backTo: string; kindLabel: string }) {
  const { itemId } = useParams()
  const navigate = useNavigate()
  const [state, setState] = useState<{ id?: string; item: NoteItem | null; error: string | null }>({ item: null, error: null })
  const [notice, setNotice] = useState<Notice | null>(null)
  const [extraCards, setExtraCards] = useState<FoundCard[] | null>(null)
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const [askingAi, setAskingAi] = useState(false)
  const [saving, setSaving] = useState(false)

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
        setNotice({ type: "error", text: error instanceof Error ? error.message : "We couldn't make more cards right now." })
      }
    } finally {
      setAskingAi(false)
    }
  }

  const makeDeck = async () => {
    if (kept.length === 0) return
    setSaving(true)
    try {
      const response = await api.post<{ id: string }>("/flashcards", {
        title: `${title} cards`.slice(0, 200),
        tags: Array.isArray(item?.tags) ? item!.tags!.slice(0, 5) : [],
        cards: kept.map((card) => ({ id: newCardId(), front: card.front, back: card.back, review: null })),
      })
      toast.success("Your deck is ready!")
      navigate(`/flashcards/${response.data.id}`)
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "We couldn't make the deck. Your note is safe.") })
    } finally {
      setSaving(false)
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
          Back
        </Link>
      </>
    )
  }

  return (
    <>
      <PageHeader
        eyebrow={`${kindLabel} · ${item.is_public ? "Public" : "Private"}`}
        title={title}
        description={[friendlyDate(item.updated_at ?? item.created_at), item.is_public && item.published_by ? `Shared by ${item.published_by}` : ""]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <Link className="ghost-button" to={backTo}>
            <ArrowLeft weight="bold" aria-hidden="true" /> All {kindLabel.toLowerCase()}s
          </Link>
        }
      />
      <NoticeBanner notice={notice} />

      <div className="note-layout">
        <article className="note-sheet" aria-label={title}>
          {content.trim() ? <NoteMarkdown source={content} /> : <p className="muted">This note is empty.</p>}
          {Array.isArray(item.tags) && item.tags.length > 0 ? (
            <p className="tag-row">
              {item.tags.map((tag) => (
                <span key={tag}>#{tag}</span>
              ))}
            </p>
          ) : null}
        </article>

        <aside className="note-study paper-panel" aria-labelledby="study-this">
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
        </aside>
      </div>

      <PublishActionButton
        endpoint={endpoint}
        studyType={studyType}
        item={item}
        onUpdated={(updated) => setState({ id: itemId, item: updated, error: null })}
        setNotice={setNotice}
      />
    </>
  )
}
