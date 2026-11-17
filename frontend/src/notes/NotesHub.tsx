import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { toast } from "sonner"
import {
  ArrowSquareOut,
  DownloadSimple,
  Image,
  MagnifyingGlass,
  Microphone,
  Notebook,
  PencilSimple,
  PencilSimpleLine,
  TextAlignLeft,
  Trash,
} from "@phosphor-icons/react"
import type { Icon } from "@phosphor-icons/react"

import { api, getErrorMessage, getTabAccountId } from "../api"
import { ConfirmDialog } from "../ui/ConfirmDialog"
import { NoticeBanner } from "../ui/common"
import type { Notice } from "../ui/common"
import { Scribble } from "../ui/Scribble"
import { RowMenu } from "./RowMenu"
import type { RowMenuHandle } from "./RowMenu"
import {
  IMAGE_NOTES,
  IMPORT_NOTES,
  NEW_NOTE,
  VOICE_NOTES,
  changedAt,
  matchesFind,
  mergeByChanged,
  previewLine,
  shortChangedDate,
  tabFromQuery,
} from "./paths"
import type { HubItem, HubTab } from "./paths"

/** The four ways to start. The same words as the + New menu. */
const startLinks: { to: string; label: string; hint: string; icon: Icon }[] = [
  { to: NEW_NOTE, label: "Write a note", hint: "Start with a blank page.", icon: PencilSimpleLine },
  { to: IMPORT_NOTES, label: "Import a file or link", hint: "PDF, Word, a web page or a video transcript.", icon: DownloadSimple },
  { to: VOICE_NOTES, label: "Voice to notes", hint: "Record or upload. Check the words. Get notes.", icon: Microphone },
  { to: IMAGE_NOTES, label: "Image to notes", hint: "Take a photo of a page or the board.", icon: Image },
]

const tabs: { id: HubTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "notes", label: "Notes" },
  { id: "summaries", label: "Summaries" },
]

type RawItem = Omit<HubItem, "kind"> & { [key: string]: unknown }

const KIND = {
  note: { label: "Note", endpoint: "/notes", path: "/notes" },
  summary: { label: "Summary", endpoint: "/summaries", path: "/summaries" },
} as const

const itemTitle = (item: HubItem) => item.title?.trim() || (item.kind === "summary" ? "Untitled summary" : "Untitled note")

/** /notes: every note and summary in one list, with ways to start a new one. */
export function NotesHub() {
  const [params, setParams] = useSearchParams()
  const tab = tabFromQuery(params.get("show"))
  const [items, setItems] = useState<HubItem[]>([])
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [failed, setFailed] = useState({ notes: false, summaries: false })
  const [find, setFind] = useState("")
  const [deleting, setDeleting] = useState<HubItem | null>(null)
  const [removing, setRemoving] = useState(false)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const panelRef = useRef<HTMLDivElement>(null)
  const menuRefs = useRef(new Map<string, RowMenuHandle>())

  useEffect(() => {
    let active = true
    const load = async () => {
      const [notes, summaries] = await Promise.allSettled([
        api.get<RawItem[]>("/notes"),
        api.get<RawItem[]>("/summaries"),
      ])
      if (!active) return
      const list = (result: PromiseSettledResult<{ data: RawItem[] }>, kind: HubItem["kind"]) =>
        result.status === "fulfilled" && Array.isArray(result.value.data)
          ? result.value.data.filter((row) => row && typeof row.id === "string").map((row) => ({ ...row, kind }))
          : []
      setItems(mergeByChanged(list(notes, "note"), list(summaries, "summary")))
      const notesFailed = notes.status === "rejected"
      const summariesFailed = summaries.status === "rejected"
      setFailed({ notes: notesFailed, summaries: summariesFailed })
      if (notesFailed && summariesFailed) {
        setNotice({
          type: "error",
          text: getErrorMessage(notes.reason, "We couldn't load your notes or summaries. Try again in a moment."),
        })
      } else if (notesFailed) {
        setNotice({ type: "error", text: getErrorMessage(notes.reason, "We couldn't load your notes. Try again in a moment.") })
      } else if (summariesFailed) {
        // Notes loaded, so Luma is reachable. Keep it simple instead of showing a server message.
        setNotice({ type: "error", text: "We couldn't load your summaries. Try again in a moment." })
      }
      setLoading(false)
    }
    void load()
    return () => {
      active = false
    }
  }, [])

  const chooseTab = useCallback(
    (next: HubTab) => {
      setParams(
        (current) => {
          const updated = new URLSearchParams(current)
          if (next === "all") updated.delete("show")
          else updated.set("show", next)
          return updated
        },
        { replace: true },
      )
    },
    [setParams],
  )

  const onTabKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((item) => item.id === tab)
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key as "ArrowRight" | "ArrowLeft"]
    const jump = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null
    if (step === undefined && jump === null) return
    event.preventDefault()
    const next = jump ?? (index + (step ?? 0) + tabs.length) % tabs.length
    chooseTab(tabs[next].id)
    tabRefs.current[next]?.focus()
  }

  const counts = useMemo(
    () => ({
      all: items.length,
      notes: items.filter((item) => item.kind === "note").length,
      summaries: items.filter((item) => item.kind === "summary").length,
    }),
    [items],
  )

  const shown = items.filter(
    (item) => (tab === "all" || (tab === "notes" ? item.kind === "note" : item.kind === "summary")) && matchesFind(item, find),
  )

  const confirmDelete = async () => {
    if (!deleting) return
    const target = deleting
    setRemoving(true)
    try {
      // Delete from the account that showed this list, even if the tab switches meanwhile.
      await api.delete(`${KIND[target.kind].endpoint}/${target.id}`, { lumaAccountId: getTabAccountId() ?? undefined })
      setItems((current) => current.filter((item) => !(item.id === target.id && item.kind === target.kind)))
      toast.success(`Deleted “${itemTitle(target)}”.`)
      setDeleting(null)
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "We couldn't delete that. It is still here.") })
      setDeleting(null)
    } finally {
      setRemoving(false)
    }
  }

  // When a list didn't load, don't tell the student they have nothing.
  const tabFailed = tab === "summaries" ? failed.summaries : tab === "notes" ? failed.notes : failed.notes || failed.summaries
  const emptyText = find.trim() && items.length > 0
    ? `Nothing matches “${find.trim()}”.`
    : tabFailed
      ? "We couldn't load this list. Try again in a moment."
      : items.length === 0
        ? "No notes yet. Pick a way to start above."
        : tab === "summaries"
          ? "No summaries yet."
          : "No notes yet. Pick a way to start above."

  const activeTab = tabs.find((item) => item.id === tab) ?? tabs[0]

  return (
    <div className="notes-hub">
      <header className="page-head">
        <div>
          <h1>
            Your <Scribble type="underline">notes</Scribble>
          </h1>
          <p className="lede">Write, import, talk or snap a photo. Luma helps turn it into notes.</p>
        </div>
      </header>

      <nav className="start-row" aria-label="Start a note">
        <ul>
          {startLinks.map((item) => (
            <li key={item.to}>
              <Link to={item.to} className="start-link">
                <span className="start-icon" aria-hidden="true">
                  <item.icon weight="duotone" />
                </span>
                <span className="start-text">
                  <strong>{item.label}</strong>
                  <small>{item.hint}</small>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <NoticeBanner notice={notice} />

      <section className="hub-list" aria-labelledby="hub-list-title">
        <h2 id="hub-list-title" className="sr-only">
          Your notes and summaries
        </h2>
        <div className="hub-tools">
          <div className="tabs" role="tablist" aria-label="Show" onKeyDown={onTabKey}>
            {tabs.map((item, index) => (
              <button
                key={item.id}
                ref={(element) => {
                  tabRefs.current[index] = element
                }}
                type="button"
                role="tab"
                id={`hub-tab-${item.id}`}
                className="tab"
                aria-selected={tab === item.id}
                aria-controls="hub-panel"
                tabIndex={tab === item.id ? 0 : -1}
                onClick={() => chooseTab(item.id)}
              >
                {item.label}
                {!loading ? <span className="tab-count">{counts[item.id]}</span> : null}
              </button>
            ))}
          </div>
          <label className="find-field">
            <span className="sr-only">Find in my notes</span>
            <MagnifyingGlass aria-hidden="true" />
            <input
              type="search"
              value={find}
              onChange={(event) => setFind(event.target.value)}
              placeholder="Find in my notes"
              autoComplete="off"
            />
          </label>
        </div>

        <div
          ref={panelRef}
          id="hub-panel"
          role="tabpanel"
          aria-labelledby={`hub-tab-${activeTab.id}`}
          tabIndex={-1}
          className="hub-panel"
        >
          {loading ? (
            <p className="hub-empty" role="status">
              <span className="spinner small-spinner" aria-hidden="true" /> Loading your notes...
            </p>
          ) : shown.length === 0 ? (
            <p className="hub-empty" role="status">
              {emptyText}
            </p>
          ) : (
            <ul className="row-list note-rows">
              {shown.map((item) => {
                const kind = KIND[item.kind]
                const title = itemTitle(item)
                const preview = previewLine(item.content)
                const changed = shortChangedDate(changedAt(item))
                const key = `${item.kind}-${item.id}`
                return (
                  <li key={key} className="row note-row">
                    <span className="row-icon" aria-hidden="true">
                      {item.kind === "summary" ? <TextAlignLeft weight="duotone" /> : <Notebook weight="duotone" />}
                    </span>
                    <span className="row-main">
                      <small className="row-kind">{kind.label}</small>
                      <Link className="row-link" to={`${kind.path}/${item.id}`}>
                        {title}
                      </Link>
                      {preview ? <span className="row-preview">{preview}</span> : null}
                    </span>
                    <span className="row-meta">
                      {item.is_public ? <span className="shared-pill">Shared</span> : null}
                      {changed ? <span>Changed {changed}</span> : null}
                    </span>
                    <RowMenu
                      ref={(handle) => {
                        if (handle) menuRefs.current.set(key, handle)
                        else menuRefs.current.delete(key)
                      }}
                      label={`More for ${title}`}
                      items={[
                        { label: "Open", to: `${kind.path}/${item.id}`, icon: <ArrowSquareOut aria-hidden="true" /> },
                        { label: "Edit", to: `${kind.path}/${item.id}/edit`, icon: <PencilSimple aria-hidden="true" /> },
                        { label: "Delete", onSelect: () => setDeleting(item), danger: true, icon: <Trash aria-hidden="true" /> },
                      ]}
                    />
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </section>

      {deleting ? (
        <ConfirmDialog
          title={`Delete “${itemTitle(deleting)}”?`}
          body="You can't get it back."
          confirmLabel="Delete"
          busyLabel="Deleting..."
          cancelLabel="Keep it"
          busy={removing}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
          returnFocus={() => menuRefs.current.get(`${deleting.kind}-${deleting.id}`)?.button() ?? panelRef.current}
        />
      ) : null}
    </div>
  )
}
