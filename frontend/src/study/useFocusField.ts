import { useCallback, useEffect, useState } from "react"

/**
 * Moves focus to a box by its id after the next render (so a card that just opened or was just
 * added is there), and puts it in the middle of the screen, clear of the sticky save bar.
 */
export function useFocusField(): (id: string) => void {
  const [target, setTarget] = useState<{ id: string } | null>(null)
  useEffect(() => {
    if (!target) return
    const box = document.getElementById(target.id)
    if (!box) return
    box.focus({ preventScroll: true })
    box.scrollIntoView({ block: "center" })
  }, [target])
  return useCallback((id: string) => setTarget({ id }), [])
}
