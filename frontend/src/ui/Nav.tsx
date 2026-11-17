import { useCallback, useEffect, useRef, useState } from "react"
import type { CSSProperties, ComponentType } from "react"
import { Link, NavLink, useLocation } from "react-router-dom"
import { AnimatePresence, motion } from "motion/react"
import type { IconProps } from "@phosphor-icons/react"
import {
  CalendarCheck,
  CaretUpDown,
  DownloadSimple,
  Cards,
  GearSix,
  House,
  Image,
  ListChecks,
  MagnifyingGlass,
  Microphone,
  Notebook,
  Plus,
  SignOut,
  Article,
  X,
} from "@phosphor-icons/react"

import { AccountMenuPopover, AccountSheet } from "./AccountMenu"
import { accountMenuPosition } from "./accountActions"

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
    ],
  },
  {
    title: "You",
    items: [
      { to: "/settings", label: "Settings", icon: GearSix },
    ],
  },
]

const tabItems: NavItem[] = [
  { to: "/dashboard", label: "Today", icon: House },
  { to: "/flashcards", label: "Study", icon: Cards, match: ["/flashcards", "/quizzes", "/study-sessions"] },
  { to: "/search", label: "Search", icon: MagnifyingGlass },
  { to: "/settings", label: "Me", icon: GearSix, match: ["/settings"] },
]

const createItems: (NavItem & { hint: string })[] = [
  { to: "/flashcards/new", label: "Flashcard deck", hint: "Questions and answers", icon: Cards },
  { to: "/notes", label: "Note", hint: "Write what you learn", icon: Notebook },
  { to: "/summaries", label: "Summary", hint: "A short version", icon: Article },
  { to: "/voice-input", label: "Voice to notes", hint: "Record or upload audio", icon: Microphone },
  { to: "/import", label: "Import to notes", hint: "File, link or video", icon: DownloadSimple },
  { to: "/image-to-notes", label: "Image to notes", hint: "Snap a page", icon: Image },
  { to: "/study-sessions", label: "Study plan", hint: "Plan your study time", icon: CalendarCheck },
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
  const identityRef = useRef<HTMLButtonElement>(null)
  const [menuPosition, setMenuPosition] = useState<CSSProperties | null>(null)
  const closeMenu = useCallback(() => setMenuPosition(null), [])
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
        <button
          ref={identityRef}
          type="button"
          className="identity"
          aria-haspopup="dialog"
          aria-expanded={menuPosition !== null}
          title="Switch or add accounts"
          onClick={(event) => {
            const anchor = event.currentTarget
            setMenuPosition((current) => (current ? null : accountMenuPosition(anchor)))
          }}
        >
          {/* Named by its own text (WCAG 2.5.3), so voice users can say what they see. */}
          <span className="sr-only">Accounts. Using </span>
          <span className="avatar" aria-hidden="true">
            {initials}
            {/* Tablet rail: a small mark on the avatar shows it opens a menu. */}
            <span className="identity-badge" aria-hidden="true">
              <CaretUpDown weight="bold" />
            </span>
          </span>
          <span className="identity-text">
            <strong>{username}</strong>
            <small>{plan} plan</small>
          </span>
          <CaretUpDown className="identity-caret" weight="bold" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={onLogout}
          aria-label={`Sign out of ${username}`}
          title={`Sign out of ${username}`}
        >
          <SignOut weight="bold" aria-hidden="true" />
        </button>
      </div>
      <AccountMenuPopover anchorRef={identityRef} position={menuPosition} onClose={closeMenu} />
    </aside>
  )
}

export function MobileTopBar({ initials }: { initials: string }) {
  const [sheetOpen, setSheetOpen] = useState(false)
  const closeSheet = useCallback(() => setSheetOpen(false), [])
  return (
    <>
      <header className="mobile-top">
        <Link className="brand" to="/dashboard" aria-label="Luma home">
          <img src="/luma-star.png" alt="" />
          <span>Luma</span>
        </Link>
        <button
          type="button"
          className="avatar"
          aria-label="Accounts"
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          onClick={() => setSheetOpen(true)}
        >
          {initials}
        </button>
      </header>
      <AccountSheet open={sheetOpen} onClose={closeSheet} />
    </>
  )
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function MobileTabBar() {
  const { pathname } = useLocation()
  const [sheetOpen, setSheetOpen] = useState(false)
  const plusRef = useRef<HTMLButtonElement>(null)
  const sheetRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  // Close the sheet and put keyboard focus back on the + button.
  const closeSheet = useCallback(() => {
    setSheetOpen(false)
    plusRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!sheetOpen) return
    // Move focus into the sheet when it opens.
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeSheet()
        return
      }
      if (event.key !== "Tab") return
      // Keep Tab inside the open sheet.
      const sheet = sheetRef.current
      if (!sheet) return
      const items = Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (!sheet.contains(active)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [closeSheet, sheetOpen])

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
          ref={plusRef}
          type="button"
          className={sheetOpen ? "tab create open" : "tab create"}
          onClick={() => (sheetOpen ? closeSheet() : setSheetOpen(true))}
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
              onClick={closeSheet}
            />
            <motion.section
              ref={sheetRef}
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
                <button ref={closeRef} type="button" className="icon-button" onClick={closeSheet} aria-label="Close">
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
            </motion.section>
          </>
        ) : null}
      </AnimatePresence>
    </>
  )
}
