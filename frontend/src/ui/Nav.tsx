import { useCallback, useEffect, useId, useRef, useState } from "react"
import type { CSSProperties, ComponentType, KeyboardEvent as ReactKeyboardEvent } from "react"
import { Link, useLocation } from "react-router-dom"
import { AnimatePresence, motion } from "motion/react"
import type { IconProps } from "@phosphor-icons/react"
import {
  CaretUpDown,
  DownloadSimple,
  Cards,
  GearSix,
  House,
  Image,
  MagnifyingGlass,
  Microphone,
  Notebook,
  PencilSimpleLine,
  Plus,
  X,
} from "@phosphor-icons/react"

import { AccountMenuPopover, AccountSheet } from "./AccountMenu"
import { accountMenuPosition } from "./accountActions"
import { IMAGE_NOTES, IMPORT_NOTES, NEW_NOTE, VOICE_NOTES } from "../notes/paths"

type NavItem = { to: string; label: string; icon: ComponentType<IconProps>; match?: string[] }

// The four places a student goes. The same words on every screen size.
// `match` lists every path that belongs to the place, so the right one lights up.
const HOME: NavItem = { to: "/dashboard", label: "Home", icon: House }
const STUDY: NavItem = {
  to: "/flashcards",
  label: "Study",
  icon: Cards,
  match: ["/flashcards", "/quizzes", "/study-sessions", "/study"],
}
const NOTES: NavItem = {
  to: "/notes",
  label: "Notes",
  icon: Notebook,
  match: ["/notes", "/summaries"],
}
const SEARCH: NavItem = { to: "/search", label: "Search", icon: MagnifyingGlass, match: ["/search", "/discover", "/saved"] }
const SETTINGS: NavItem = { to: "/settings", label: "Settings", icon: GearSix, match: ["/settings"] }

/**
 * Sidebar (desktop), icon rail (tablet) and phone bottom bar. Settings sits apart: at the
 * bottom of the sidebar, and in the avatar menu at the top of a phone.
 */
const placeItems: NavItem[] = [HOME, STUDY, NOTES, SEARCH]

/** One list of things to make, for the + New menu (desktop, tablet) and the + sheet (phone). */
const createItems: (NavItem & { hint: string })[] = [
  { to: NEW_NOTE, label: "Write a note", hint: "Start with a blank page.", icon: PencilSimpleLine },
  { to: IMPORT_NOTES, label: "Import a file or link", hint: "PDF, Word, a web page or a video.", icon: DownloadSimple },
  { to: VOICE_NOTES, label: "Voice to notes", hint: "Record or upload. Get notes.", icon: Microphone },
  { to: IMAGE_NOTES, label: "Image to notes", hint: "Take a photo of a page.", icon: Image },
  { to: "/flashcards/new", label: "New flashcard deck", hint: "Questions and answers to study.", icon: Cards },
]

const NEW_LABEL = "Make something new"
const SHEET_TITLE = "What do you want to make?"

/** "free" becomes "Free", so the line reads "Free plan" (not "Free Plan"). */
function sentenceCase(text: string) {
  return text ? text[0].toUpperCase() + text.slice(1).toLowerCase() : text
}

function isActive(pathname: string, item: NavItem) {
  const roots = item.match ?? [item.to]
  return roots.some((root) => pathname === root || pathname.startsWith(`${root}/`))
}

function SideLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = isActive(pathname, item)
  return (
    <Link
      to={item.to}
      className={active ? "nav-link active" : "nav-link"}
      aria-current={active ? "page" : undefined}
      title={item.label}
    >
      <item.icon weight={active ? "fill" : "duotone"} aria-hidden="true" />
      <span>{item.label}</span>
    </Link>
  )
}

/** Where the + New menu opens: under the button in the sidebar (same width, so it stays inside the sidebar), or beside the icon rail. */
function newMenuPosition(anchor: HTMLElement): CSSProperties {
  const rect = anchor.getBoundingClientRect()
  if (window.innerWidth >= 1100) {
    return { left: rect.left, top: rect.bottom + 8, width: rect.width, minWidth: 0 }
  }
  const railRight = anchor.closest("aside")?.getBoundingClientRect().right ?? rect.right
  return { left: railRight + 10, top: Math.max(12, rect.top) }
}

/**
 * The + New button and its menu (desktop and tablet). A real menu: arrow keys move,
 * Escape closes and puts focus back on the button, Tab or a click outside closes it.
 */
function NewMenu() {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const startAt = useRef<"first" | "last">("first")
  const [position, setPosition] = useState<CSSProperties | null>(null)
  const open = position !== null
  const menuId = useId()

  const close = useCallback((returnFocus: boolean) => {
    setPosition(null)
    if (returnFocus) buttonRef.current?.focus()
  }, [])

  const openMenu = (from: "first" | "last") => {
    if (!buttonRef.current) return
    startAt.current = from
    setPosition(newMenuPosition(buttonRef.current))
  }

  useEffect(() => {
    if (!open) return
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    ;(startAt.current === "last" ? items[items.length - 1] : items[0])?.focus()
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) close(false)
    }
    const onResize = () => close(false)
    document.addEventListener("pointerdown", onPointer)
    window.addEventListener("resize", onResize)
    return () => {
      document.removeEventListener("pointerdown", onPointer)
      window.removeEventListener("resize", onResize)
    }
  }, [close, open])

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    const at = items.indexOf(document.activeElement as HTMLElement)
    const focusAt = (index: number) => items[(index + items.length) % items.length]?.focus()
    switch (event.key) {
      case "Escape":
        event.preventDefault()
        event.stopPropagation()
        close(true)
        return
      case "Tab":
        // Let Tab move on as usual; the menu just closes behind it.
        close(false)
        return
      case "ArrowDown":
        event.preventDefault()
        focusAt(at + 1)
        return
      case "ArrowUp":
        event.preventDefault()
        focusAt(at - 1)
        return
      case "Home":
        event.preventDefault()
        focusAt(0)
        return
      case "End":
        event.preventDefault()
        focusAt(items.length - 1)
        return
      default:
        // Typing a letter jumps to the next item that starts with it.
        if (event.key.length === 1 && /\S/.test(event.key)) {
          const letter = event.key.toLowerCase()
          for (let step = 1; step <= items.length; step += 1) {
            const index = (at + step) % items.length
            if (items[index].textContent?.trim().toLowerCase().startsWith(letter)) {
              focusAt(index)
              break
            }
          }
        }
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={open ? "new-button open" : "new-button"}
        aria-label={NEW_LABEL}
        title={NEW_LABEL}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : openMenu("first"))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault()
            openMenu(event.key === "ArrowUp" ? "last" : "first")
          }
        }}
      >
        <Plus weight="bold" aria-hidden="true" />
        <span>New</span>
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          className="new-menu"
          role="menu"
          aria-label={NEW_LABEL}
          style={position ?? undefined}
          onKeyDown={onMenuKeyDown}
        >
          {createItems.map((item) => (
            <Link
              key={item.to + item.label}
              to={item.to}
              role="menuitem"
              tabIndex={-1}
              className="new-menu-item"
              onClick={() => close(false)}
            >
              <item.icon weight="duotone" aria-hidden="true" />
              <span>{item.label}</span>
            </Link>
          ))}
        </div>
      ) : null}
    </>
  )
}

export function SideNav({ username, plan, initials }: { username: string; plan: string; initials: string }) {
  const { pathname } = useLocation()
  const identityRef = useRef<HTMLButtonElement>(null)
  const [menuPosition, setMenuPosition] = useState<CSSProperties | null>(null)
  const closeMenu = useCallback(() => setMenuPosition(null), [])
  return (
    <aside className="sidebar" aria-label="Main navigation">
      <Link className="brand" to="/dashboard" aria-label="Luma home">
        <img src="/luma-star.png" alt="" />
        <span>Luma</span>
      </Link>
      <NewMenu />
      <nav className="nav-stack">
        {placeItems.map((item) => (
          <SideLink key={item.to} item={item} pathname={pathname} />
        ))}
      </nav>
      <div className="sidebar-footer">
        <SideLink item={SETTINGS} pathname={pathname} />
        <button
          ref={identityRef}
          type="button"
          className="identity"
          aria-haspopup="dialog"
          aria-expanded={menuPosition !== null}
          title="Switch accounts or sign out"
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
            <small>{sentenceCase(plan)} plan</small>
          </span>
          <CaretUpDown className="identity-caret" weight="bold" aria-hidden="true" />
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
          aria-label="Accounts and settings"
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
  const titleId = useId()

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

  const renderTab = (item: NavItem) => {
    const active = isActive(pathname, item)
    return (
      <Link
        key={item.to}
        to={item.to}
        className={active ? "tab active" : "tab"}
        aria-current={active ? "page" : undefined}
        onClick={() => setSheetOpen(false)}
      >
        <item.icon weight={active ? "fill" : "regular"} aria-hidden="true" />
        <span>{item.label}</span>
      </Link>
    )
  }

  return (
    <>
      <nav className="tab-bar" aria-label="Main navigation">
        {placeItems.slice(0, 2).map(renderTab)}
        <button
          ref={plusRef}
          type="button"
          className={sheetOpen ? "tab create open" : "tab create"}
          onClick={() => (sheetOpen ? closeSheet() : setSheetOpen(true))}
          aria-expanded={sheetOpen}
          aria-haspopup="dialog"
          aria-label="Create something"
        >
          <span className="create-bubble">
            <Plus weight="bold" aria-hidden="true" />
          </span>
        </button>
        {placeItems.slice(2).map(renderTab)}
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
              aria-labelledby={titleId}
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", stiffness: 340, damping: 32 }}
            >
              <div className="sheet-head">
                <span className="sheet-grip" aria-hidden="true" />
                <h2 id={titleId}>{SHEET_TITLE}</h2>
                <button ref={closeRef} type="button" className="icon-button" onClick={closeSheet} aria-label="Close">
                  <X weight="bold" aria-hidden="true" />
                </button>
              </div>
              <ul className="sheet-list">
                {createItems.map((item) => (
                  <li key={item.to + item.label}>
                    <Link to={item.to} className="sheet-item" onClick={() => setSheetOpen(false)}>
                      <item.icon weight="duotone" aria-hidden="true" />
                      <span className="sheet-item-text">
                        <strong>{item.label}</strong>
                        <small>{item.hint}</small>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </motion.section>
          </>
        ) : null}
      </AnimatePresence>
    </>
  )
}
