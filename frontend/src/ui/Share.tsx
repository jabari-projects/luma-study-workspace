import { useState } from "react"
import { LockSimple, ShareNetwork } from "@phosphor-icons/react"

import { getErrorCode, getErrorMessage } from "../api"
import { AxiosError } from "axios"
import { ConflictPanel } from "../work/ConflictPanel"
import { ConfirmDialog } from "./ConfirmDialog"
import type { Notice, StudyType } from "./common"
import { hasTitle, setSharing, shareCopy, useShareName } from "./sharing"
import type { ShareableItem } from "./sharing"

/**
 * Sharing a note, summary or deck with other students.
 * An item's options live on the item: the Share button sits in the item's own header
 * (and in its row menu on the Notes hub), never floating over the page.
 * Owner rules: shared items are seen only by students signed in to Luma, with the
 * username and nothing else about the person.
 */

/** "Share this note?" Asks first, because others will be able to see it. */
export function ShareDialog({
  noun,
  username,
  busy,
  onConfirm,
  onCancel,
  returnFocus,
}: {
  noun: string
  username: string | null
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
  returnFocus?: () => HTMLElement | null | undefined
}) {
  const copy = shareCopy(noun, username)
  return (
    <ConfirmDialog
      tone="primary"
      title={copy.title}
      body={copy.body}
      confirmLabel="Share"
      busyLabel="Sharing..."
      cancelLabel="Not now"
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
      returnFocus={returnFocus}
    />
  )
}

/**
 * The Share / Stop sharing button for an item's page header.
 * Only mount this on the owner's view of a saved item, never on a creation form.
 */
export function ShareControl<T extends ShareableItem>({
  endpoint,
  studyType,
  noun,
  item,
  onUpdated,
  setNotice,
}: {
  endpoint: string
  studyType: StudyType
  noun: string
  item: T
  onUpdated: (item: T) => void
  setNotice: (notice: Notice | null) => void
}) {
  const username = useShareName()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  // A newer version from another tab or device (409): the student picks, nothing is overwritten.
  const [conflict, setConflict] = useState<{ share: boolean; current: T } | null>(null)
  const copy = shareCopy(noun, username)
  const shared = Boolean(item.is_public)

  const change = async (share: boolean, base: T = item) => {
    if (share && !hasTitle(base)) {
      setAsking(false)
      setNotice({ type: "error", text: copy.needsTitle })
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      onUpdated(await setSharing<T>(endpoint, base, share, studyType, username))
      setAsking(false)
      setConflict(null)
      setNotice({ type: "success", text: share ? copy.shared : copy.stopped })
    } catch (error: unknown) {
      setAsking(false)
      const current = error instanceof AxiosError ? (error.response?.data as { current?: T } | undefined)?.current : undefined
      if (getErrorCode(error) === "edit_conflict" && current) {
        setConflict({ share, current })
        return
      }
      setNotice({
        type: "error",
        text: getErrorMessage(error, share ? `We couldn't share this ${noun}. Try again.` : `We couldn't stop sharing this ${noun}. Try again.`),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className="secondary-button share-button"
        disabled={busy}
        onClick={() => (shared ? void change(false) : setAsking(true))}
      >
        {shared ? <LockSimple weight="bold" aria-hidden="true" /> : <ShareNetwork weight="bold" aria-hidden="true" />}
        {shared ? "Stop sharing" : "Share"}
      </button>
      {conflict ? (
        <div className="modal-backdrop" role="presentation">
          <div className="modal-panel">
            <ConflictPanel
              noun={noun}
              gone={false}
              busy={busy}
              onSeeNewer={() => {
                onUpdated(conflict.current)
                setConflict(null)
              }}
              onKeepMine={() => void change(conflict.share, { ...item, version: conflict.current.version })}
            />
          </div>
        </div>
      ) : null}
      {asking ? (
        <ShareDialog
          noun={noun}
          username={username}
          busy={busy}
          onConfirm={() => void change(true)}
          onCancel={() => setAsking(false)}
        />
      ) : null}
    </>
  )
}
