import type { ReactNode } from "react"

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
  // The "Margins" page head: a small kicker, the title, one short line, and actions on the right.
  return (
    <header className="page-head">
      <div>
        {eyebrow ? <p className="kicker">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p className="lede">{description}</p> : null}
      </div>
      {actions ? <div className="page-head-actions page-actions">{actions}</div> : null}
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
