import { useState } from "react"
import type { ReactNode } from "react"

import { useAuth, useProfile } from "../auth"
import { api, getErrorMessage } from "../api"

export type Notice = {
  type: "success" | "error" | "info"
  text: string
}

export type StudyType = "note" | "flashcards" | "summary"

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  )
}

export function NoticeBanner({ notice }: { notice: Notice | null }) {
  if (!notice) {
    return null
  }

  return (
    <div className={`notice ${notice.type}`} role={notice.type === "error" ? "alert" : "status"}>
      {notice.text}
    </div>
  )
}

type PublishableItem = {
  id: string
  is_public?: boolean
  title?: unknown
  [key: string]: unknown
}

/**
 * Floating Publish / Unpublish action for a saved study set.
 * Only mount this on an existing item's view, never on a creation form.
 */
export function PublishActionButton<T extends PublishableItem>({
  endpoint,
  studyType,
  item,
  onUpdated,
  setNotice,
}: {
  endpoint: string
  studyType: StudyType
  item: T
  onUpdated: (item: T) => void
  setNotice: (notice: Notice | null) => void
}) {
  const profile = useProfile()
  const { user } = useAuth()
  const [modalOpen, setModalOpen] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const publisherUsername = profile?.username ?? user?.username ?? "Student"

  const publishItem = async () => {
    if (!(typeof item.title === "string" && item.title.trim())) {
      setModalOpen(false)
      setNotice({ type: "error", text: "Please give this study set a title before publishing." })
      return
    }

    setPublishing(true)
    setNotice(null)

    try {
      const response = await api.put<T>(`${endpoint}/${item.id}`, {
        is_public: true,
        published_at: new Date().toISOString(),
        published_by: publisherUsername,
        study_type: studyType,
      })
      onUpdated(response.data)
      setModalOpen(false)
      setNotice({ type: "success", text: "Published." })
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Could not publish this study set.") })
    } finally {
      setPublishing(false)
    }
  }

  const unpublishItem = async () => {
    setPublishing(true)
    setNotice(null)

    try {
      const response = await api.put<T>(`${endpoint}/${item.id}`, {
        is_public: false,
        published_at: null,
        published_by: null,
      })
      onUpdated(response.data)
      setNotice({ type: "success", text: "Unpublished." })
    } catch (error: unknown) {
      setNotice({ type: "error", text: getErrorMessage(error, "Could not unpublish this study set.") })
    } finally {
      setPublishing(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className={item.is_public ? "floating-publish unpublish" : "floating-publish"}
        onClick={() => {
          if (item.is_public) {
            void unpublishItem()
            return
          }
          setModalOpen(true)
        }}
        disabled={publishing}
      >
        {item.is_public ? "Unpublish" : "Publish"}
      </button>
      {modalOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={() => !publishing && setModalOpen(false)}>
          <section
            className="modal-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="publish-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="publish-title">Publish this study set?</h2>
            <p>
              Publishing makes this study set visible to other students. Your username will appear as the
              creator. You can unpublish it anytime.
            </p>
            <div className="button-row">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setModalOpen(false)}
                disabled={publishing}
              >
                Cancel
              </button>
              <button type="button" className="primary-button" onClick={() => void publishItem()} disabled={publishing}>
                {publishing ? "Publishing..." : "Publish"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  )
}
