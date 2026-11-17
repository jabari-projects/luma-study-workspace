import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useRef, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react"
import { Link } from "react-router-dom"
import { DotsThreeVertical } from "@phosphor-icons/react"

export type RowMenuItem =
  | { label: string; icon?: ReactNode; to: string; danger?: false }
  | { label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean }

export type RowMenuHandle = { focusButton: () => void; button: () => HTMLButtonElement | null }

/**
 * The small "⋮" menu at the end of a row (Open, Edit, Delete). A real menu:
 * arrow keys move, Escape closes and returns focus, Tab or a tap outside closes it.
 */
export const RowMenu = forwardRef<RowMenuHandle, { label: string; items: RowMenuItem[] }>(function RowMenu(
  { label, items },
  ref,
) {
  const [open, setOpen] = useState(false)
  const startAt = useRef<"first" | "last">("first")
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useImperativeHandle(ref, () => ({
    focusButton: () => buttonRef.current?.focus(),
    button: () => buttonRef.current,
  }))

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) buttonRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    const entries = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    ;(startAt.current === "last" ? entries[entries.length - 1] : entries[0])?.focus()
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) close(false)
    }
    document.addEventListener("pointerdown", onPointer)
    return () => document.removeEventListener("pointerdown", onPointer)
  }, [close, open])

  const openMenu = (from: "first" | "last") => {
    startAt.current = from
    setOpen(true)
  }

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const entries = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    const at = entries.indexOf(document.activeElement as HTMLElement)
    const focusAt = (index: number) => entries[(index + entries.length) % entries.length]?.focus()
    switch (event.key) {
      case "Escape":
        event.preventDefault()
        event.stopPropagation()
        close(true)
        return
      case "Tab":
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
        focusAt(entries.length - 1)
        return
    }
  }

  return (
    <div className={open ? "row-menu open" : "row-menu"}>
      <button
        ref={buttonRef}
        type="button"
        className="icon-button row-menu-button"
        aria-label={label}
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
        <DotsThreeVertical weight="bold" aria-hidden="true" />
      </button>
      {open ? (
        <div ref={menuRef} id={menuId} className="row-menu-list" role="menu" aria-label={label} onKeyDown={onMenuKeyDown}>
          {items.map((item) =>
            "to" in item ? (
              <Link key={item.label} to={item.to} role="menuitem" tabIndex={-1} className="row-menu-item" onClick={() => close(false)}>
                {item.icon}
                <span>{item.label}</span>
              </Link>
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={item.danger ? "row-menu-item danger-text" : "row-menu-item"}
                onClick={() => {
                  close(false)
                  item.onSelect()
                }}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  )
})
