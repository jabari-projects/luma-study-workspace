import { useEffect, useState } from "react"
import type { ComponentType } from "react"
import { Link, NavLink, useLocation } from "react-router-dom"
import { AnimatePresence, motion } from "motion/react"
import type { IconProps } from "@phosphor-icons/react"
import {
  CalendarCheck,
  DownloadSimple,
  Cards,
  Crown,
  GearSix,
  House,
  Image,
  ListChecks,
  MagnifyingGlass,
  Microphone,
  Notebook,
  Plus,
  Robot,
  SignOut,
  Article,
  X,
} from "@phosphor-icons/react"

type NavItem = { to: string; label: string; icon: ComponentType<IconProps>; match?: string[] }

const navGroups: { title: string; items: NavItem[] }[] = [
  { title: "", items: [{ to: "/dashboard", label: "Today", icon: House }] },
  {
    title: "Study",
    items: [
      { to: "/flashcards", label: "Flashcards", icon: Cards },
      { to: "/quizzes", label: "Quizzes", icon: ListChecks },
      { to: "/study-sessions", label: "Study Sessions", icon: CalendarCheck },
    ],
  },
  {
    title: "Create",
    items: [
      { to: "/notes", label: "Notes", icon: Notebook },
      { to: "/summaries", label: "Summaries", icon: Article },
      { to: "/voice-input", label: "Voice to Notes", icon: Microphone },
      { to: "/import", label: "Import to Notes", icon: DownloadSimple },
      { to: "/image-to-notes", label: "Image to Notes", icon: Image },
    ],
  },
  {
    title: "Explore",
    items: [
      { to: "/search", label: "Search", icon: MagnifyingGlass },
      { to: "/ai-tutor", label: "AI Tutor", icon: Robot },
    ],
  },
  {
    title: "You",
    items: [
      { to: "/subscribe", label: "Subscription", icon: Crown },
      { to: "/settings", label: "Settings", icon: GearSix },
    ],
  },
]

const tabItems: NavItem[] = [
  { to: "/dashboard", label: "Today", icon: House },
  { to: "/flashcards", label: "Study", icon: Cards, match: ["/flashcards", "/quizzes", "/study-sessions"] },
  { to: "/search", label: "Search", icon: MagnifyingGlass },
  { to: "/settings", label: "Me", icon: GearSix, match: ["/settings", "/subscribe"] },
]

const createItems: (NavItem & { hint: string })[] = [
  { to: "/flashcards/new", label: "Flashcard deck", hint: "Questions and answers", icon: Cards },
  { to: "/notes", label: "Note", hint: "Write what you learn", icon: Notebook },
  { to: "/summaries", label: "Summary", hint: "A short version", icon: Article },
  { to: "/voice-input", label: "Voice to notes", hint: "Record or upload audio", icon: Microphone },
  { to: "/import", label: "Import to notes", hint: "File, link or video", icon: DownloadSimple },
  { to: "/image-to-notes", label: "Image to notes", hint: "Snap a page", icon: Image },
  { to: "/study-sessions", label: "Study plan", hint: "Plan your study time", icon: CalendarCheck },
  { to: "/ai-tutor", label: "Ask the tutor", hint: "Get help studying", icon: Robot },
  { to: "/quizzes", label: "Quiz", hint: "Test yourself", icon: ListChecks },
]

function isActive(pathname: string, item: NavItem) {
  const roots = item.match ?? [item.to]
  return roots.some((root) => pathname === root || pathname.startsWith(`${root}/`))
}

export function SideNav({
  username,
  plan,
  initials,
  onLogout,
}: {
  username: string
  plan: string
  initials: string
  onLogout: () => void
}) {
  return (
    <aside className="sidebar" aria-label="Main navigation">
      <Link className="brand" to="/dashboard" aria-label="Luma home">
        <img src="/luma-star.png" alt="" />
        <span>Luma</span>
      </Link>
      <nav className="nav-stack">
        {navGroups.map((group) => (
          <div className="nav-group" key={group.title || "home"}>
            {group.title ? <p className="nav-title">{group.title}</p> : null}
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive: active }) => (active ? "nav-link active" : "nav-link")}
                title={item.label}
              >
                <item.icon weight="duotone" aria-hidden="true" />
                <span>{item.label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-footer">
        <div className="identity">
          <span className="avatar">{initials}</span>
          <span>
            <strong>{username}</strong>
            <small>{plan} plan</small>
          </span>
        </div>
        <button type="button" className="icon-button" onClick={onLogout} aria-label="Log out" title="Log out">
          <SignOut weight="bold" aria-hidden="true" />
        </button>
      </div>
    </aside>
  )
}

export function MobileTopBar({ initials }: { initials: string }) {
  return (
    <header className="mobile-top">
      <Link className="brand" to="/dashboard" aria-label="Luma home">
        <img src="/luma-star.png" alt="" />
        <span>Luma</span>
      </Link>
      <Link className="avatar" to="/settings" aria-label="Your settings">
        {initials}
      </Link>
    </header>
  )
}

export function MobileTabBar({ onLogout }: { onLogout: () => void }) {
  const { pathname } = useLocation()
  const [sheetOpen, setSheetOpen] = useState(false)

  useEffect(() => {
    if (!sheetOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSheetOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [sheetOpen])

  const renderTab = (item: NavItem) => (
    <Link key={item.to} to={item.to} className={isActive(pathname, item) ? "tab active" : "tab"} onClick={() => setSheetOpen(false)}>
      <item.icon weight={isActive(pathname, item) ? "fill" : "regular"} aria-hidden="true" />
      <span>{item.label}</span>
    </Link>
  )

  return (
    <>
      <nav className="tab-bar" aria-label="Main navigation">
        {tabItems.slice(0, 2).map(renderTab)}
        <button
          type="button"
          className={sheetOpen ? "tab create open" : "tab create"}
          onClick={() => setSheetOpen((open) => !open)}
          aria-expanded={sheetOpen}
          aria-label="Create something"
        >
          <span className="create-bubble">
            <Plus weight="bold" aria-hidden="true" />
          </span>
        </button>
        {tabItems.slice(2).map(renderTab)}
      </nav>

      <AnimatePresence>
        {sheetOpen ? (
          <>
            <motion.div
              className="sheet-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSheetOpen(false)}
            />
            <motion.section
              className="create-sheet"
              role="dialog"
              aria-modal="true"
              aria-label="Create something"
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", stiffness: 340, damping: 32 }}
            >
              <div className="sheet-head">
                <span className="sheet-grip" aria-hidden="true" />
                <h2>What do you want to do?</h2>
                <button type="button" className="icon-button" onClick={() => setSheetOpen(false)} aria-label="Close">
                  <X weight="bold" aria-hidden="true" />
                </button>
              </div>
              <div className="sheet-grid">
                {createItems.map((item) => (
                  <Link key={item.to + item.label} to={item.to} className="sheet-item" onClick={() => setSheetOpen(false)}>
                    <item.icon weight="duotone" aria-hidden="true" />
                    <strong>{item.label}</strong>
                    <small>{item.hint}</small>
                  </Link>
                ))}
              </div>
              <button type="button" className="ghost-button wide" onClick={onLogout}>
                <SignOut weight="bold" aria-hidden="true" /> Log out
              </button>
            </motion.section>
          </>
        ) : null}
      </AnimatePresence>
    </>
  )
}
