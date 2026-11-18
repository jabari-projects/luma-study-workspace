import { useEffect, useId, useRef, useState } from "react"
import type { CSSProperties, RefObject } from "react"
import { createPortal } from "react-dom"
import { Link, useNavigate } from "react-router-dom"
import { AnimatePresence, motion } from "motion/react"
import { Check, Flag, GearSix, Plus, SignOut, X } from "@phosphor-icons/react"

import { useAuth, useProfile } from "../auth"
import type { AccountSummary } from "../auth"
import { MAX_ACCOUNTS } from "../accounts"
import { AI_CHAT_UI_ENABLED } from "../config"
import { UNSAVED_WORK_WARNING, useAccountActions } from "./accountActions"

const CHATBOT_HINT = "Only this account can use the AI chat on this device."

function initialOf(account: AccountSummary): string {
  return (account.username || account.email || "L").slice(0, 1).toUpperCase()
}

function AccountInfo({ account }: { account: AccountSummary }) {
  return (
    <>
      <span className="avatar" aria-hidden="true">
        {initialOf(account)}
      </span>
      <span className="account-row-text">
        <strong>{account.username}</strong>
        <small>{account.email}</small>
      </span>
    </>
  )
}

function ChatbotBadge({ account }: { account: AccountSummary }) {
  if (!AI_CHAT_UI_ENABLED || !account.isChatbot) {
    return null
  }
  return (
    <span className="badge-ai" title={CHATBOT_HINT}>
      AI chat
    </span>
  )
}

function SignOutAllButton({ count, busy, onConfirm }: { count: number; busy: boolean; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const askedOnce = useRef(false)
  const questionId = useId()

  // Keep keyboard focus in the menu: on Cancel (the safe choice) while asking, and back
  // on the button after Cancel.
  useEffect(() => {
    if (asking) {
      askedOnce.current = true
      cancelRef.current?.focus()
    } else if (askedOnce.current) {
      triggerRef.current?.focus()
    }
  }, [asking])

  if (!asking) {
    return (
      <button
        ref={triggerRef}
        type="button"
        className="ghost-button wide account-action"
        onClick={() => setAsking(true)}
      >
        <SignOut weight="bold" aria-hidden="true" /> Sign out of all accounts
      </button>
    )
  }
  return (
    <div className="account-confirm" role="alertdialog" aria-labelledby={questionId}>
      <p id={questionId}>
        Sign out of all {count} accounts on this device?{busy ? ` ${UNSAVED_WORK_WARNING}` : ""}
      </p>
      <div className="button-row">
        <button ref={cancelRef} type="button" className="secondary-button small" onClick={() => setAsking(false)}>
          Cancel
        </button>
        <button type="button" className="danger-button small" onClick={onConfirm}>
          Sign out all
        </button>
      </div>
    </div>
  )
}

/**
 * The accounts on this device and what you can do with them.
 * "menu": each row is a button that switches. "panel": rows have their own buttons (Settings).
 */
export function AccountList({
  variant,
  onDone,
  showSettingsLink = false,
}: {
  variant: "menu" | "panel"
  onDone?: () => void
  showSettingsLink?: boolean
}) {
  const { accounts, activeAccount, canAddAccount } = useAuth()
  const { switchTo, signOut, signOutAll, addAccount, busy } = useAccountActions()
  const profile = useProfile()
  const done = () => onDone?.()

  const rows = accounts.map((account) => {
    if (variant === "menu") {
      return (
        <li key={account.id}>
          <button
            type="button"
            className="account-row"
            aria-current={account.isActive ? "true" : undefined}
            onClick={() => {
              // Close the menu first: with unsaved work a "Stay and save?" box may open.
              done()
              if (!account.isActive) void switchTo(account.id)
            }}
          >
            <AccountInfo account={account} />
            <span className="account-row-state">
              <ChatbotBadge account={account} />
              {account.isActive ? (
                <span className="account-using">
                  <Check weight="bold" aria-hidden="true" /> Using now
                </span>
              ) : account.status === "expired" ? (
                <span className="account-expired">Sign in again</span>
              ) : null}
            </span>
          </button>
        </li>
      )
    }

    return (
      <li key={account.id} className="account-row static" aria-current={account.isActive ? "true" : undefined}>
        <AccountInfo account={account} />
        <span className="account-row-state">
          <ChatbotBadge account={account} />
          {account.isActive && account.status === "signed_in" ? (
            <span className="account-using">
              <Check weight="bold" aria-hidden="true" /> Using now
            </span>
          ) : null}
          {account.status === "expired" ? (
            <button type="button" className="secondary-button small" onClick={() => void switchTo(account.id)}>
              Sign in again
            </button>
          ) : account.isActive ? null : (
            <button type="button" className="secondary-button small" onClick={() => void switchTo(account.id)}>
              Switch
            </button>
          )}
          <button
            type="button"
            className="ghost-button small"
            onClick={() => void signOut(account.id)}
            aria-label={account.status === "expired" ? `Remove ${account.username}` : `Sign out of ${account.username}`}
          >
            {account.status === "expired" ? "Remove" : "Sign out"}
          </button>
        </span>
      </li>
    )
  })

  return (
    <div className={`account-list ${variant}`}>
      <ul className="account-rows">{rows}</ul>
      <div className="account-actions">
        {showSettingsLink ? (
          <Link className="ghost-button wide account-action" to="/settings" onClick={done}>
            <GearSix weight="bold" aria-hidden="true" /> Settings
          </Link>
        ) : null}
        {/* Luma helpers only: the review queue is not a setting, so it lives here. */}
        {variant === "menu" && profile?.is_admin ? (
          <Link className="ghost-button wide account-action" to="/admin/reports" onClick={done}>
            <Flag weight="bold" aria-hidden="true" /> Review reports
          </Link>
        ) : null}
        <button
          type="button"
          className="ghost-button wide account-action"
          disabled={!canAddAccount}
          aria-describedby={canAddAccount ? undefined : "account-limit-hint"}
          onClick={() => {
            done()
            void addAccount()
          }}
        >
          <Plus weight="bold" aria-hidden="true" /> Add another account
        </button>
        {canAddAccount ? null : (
          <p id="account-limit-hint" className="field-hint account-limit-hint">
            Up to {MAX_ACCOUNTS} accounts
          </p>
        )}
        {variant === "menu" && activeAccount ? (
          <button
            type="button"
            className="ghost-button wide account-action"
            onClick={() => {
              done()
              void signOut(activeAccount.id)
            }}
          >
            <SignOut weight="bold" aria-hidden="true" /> Sign out of {activeAccount.username}
          </button>
        ) : null}
        {accounts.length >= 2 ? (
          <SignOutAllButton
            count={accounts.length}
            busy={busy}
            onConfirm={() => {
              done()
              signOutAll()
            }}
          />
        ) : null}
      </div>
    </div>
  )
}

/** Desktop and tablet: a small window next to the account button. Open while `position` is set. */
export function AccountMenuPopover({
  anchorRef,
  position,
  onClose,
}: {
  anchorRef: RefObject<HTMLButtonElement | null>
  position: CSSProperties | null
  onClose: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const open = position !== null

  useEffect(() => {
    if (!open) {
      return
    }
    const anchor = anchorRef.current
    menuRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose()
        anchor?.focus()
      }
    }
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !anchor?.contains(target)) {
        onClose()
      }
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener("resize", onClose)
    document.addEventListener("pointerdown", onPointer)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("resize", onClose)
      document.removeEventListener("pointerdown", onPointer)
    }
  }, [anchorRef, onClose, open])

  if (!open) {
    return null
  }

  return createPortal(
    <div
      ref={menuRef}
      className="account-menu"
      role="dialog"
      aria-label="Accounts"
      tabIndex={-1}
      style={position ?? undefined}
    >
      <p className="account-menu-title">Accounts on this device</p>
      <AccountList variant="menu" onDone={onClose} />
    </div>,
    document.body,
  )
}

/** Phone: a sheet from the bottom, opened from the avatar in the top bar. */
export function AccountSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose, open])

  return (
    <AnimatePresence>
      {open ? (
        <>
          <motion.div
            key="account-backdrop"
            className="sheet-backdrop account-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.section
            key="account-sheet"
            className="create-sheet account-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Accounts"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", stiffness: 340, damping: 32 }}
          >
            <div className="sheet-head">
              <span className="sheet-grip" aria-hidden="true" />
              <h2>Accounts</h2>
              <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
                <X weight="bold" aria-hidden="true" />
              </button>
            </div>
            <AccountList variant="menu" onDone={onClose} showSettingsLink />
          </motion.section>
        </>
      ) : null}
    </AnimatePresence>
  )
}

/** Shown in a tab whose account was signed out in another tab. */
export function SignedOutElsewhere() {
  const { signedOutElsewhere, accounts, switchAccount, dismissSignedOutElsewhere } = useAuth()
  const navigate = useNavigate()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const others = accounts.filter((account) => account.status === "signed_in")

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <main className="auth-screen">
      <section className="auth-card" aria-labelledby="signed-out-title">
        <Link to="/" className="auth-brand" onClick={dismissSignedOutElsewhere}>
          <img src="/luma-star.png" alt="" width={40} height={40} />
          <span>Luma</span>
        </Link>
        <h1 id="signed-out-title" ref={headingRef} tabIndex={-1}>
          Signed out
        </h1>
        <p className="auth-intro">{signedOutElsewhere?.username ?? "This account"} was signed out in another tab.</p>
        <div className="account-choices">
          {others.map((account) => (
            <button
              key={account.id}
              type="button"
              className="secondary-button wide"
              onClick={() => {
                switchAccount(account.id)
                navigate("/dashboard", { replace: true })
              }}
            >
              Use {account.username}
            </button>
          ))}
          <button
            type="button"
            className="primary-button wide"
            onClick={() => {
              dismissSignedOutElsewhere()
              navigate("/login", { replace: true })
            }}
          >
            Log in
          </button>
        </div>
      </section>
    </main>
  )
}
