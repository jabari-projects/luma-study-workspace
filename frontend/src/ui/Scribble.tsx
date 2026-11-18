import { useEffect, useRef } from "react"
import type { ReactNode } from "react"
import { annotate } from "rough-notation"

import { useDocumentColors } from "./theme"

type ScribbleType = "underline" | "highlight" | "circle" | "box" | "bracket"

/**
 * Hand-drawn mark that sketches itself around a word once it appears, in the student's color.
 * A highlight uses the soft wash of that color (--highlight), so the words on it stay readable.
 */
export function Scribble({
  children,
  type = "underline",
  color = type === "highlight" ? "var(--highlight)" : "var(--scribble)",
  delay = 250,
}: {
  children: ReactNode
  type?: ScribbleType
  color?: string
  delay?: number
}) {
  const ref = useRef<HTMLSpanElement>(null)
  // Redraw when the page switches between light and dark, or the student picks a new color.
  const colors = useDocumentColors()
  // After the first drawing, a redraw (new theme) shows at once instead of sketching again.
  const drawnRef = useRef(false)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    // The browser works out the color (tokens like --scribble are mixes of --accent), so the
    // drawing gets a plain color it can use.
    element.style.textDecorationColor = color
    const resolved = getComputedStyle(element).textDecorationColor
    element.style.textDecorationColor = ""
    const draw = (animate: boolean) => {
      const mark = annotate(element, {
        type,
        color: resolved,
        strokeWidth: type === "highlight" ? 1 : 2.5,
        padding: type === "circle" ? 8 : 2,
        iterations: 2,
        animate: animate && !reduced,
        animationDuration: 700,
        multiline: true,
      })
      mark.show()
      drawnRef.current = true
      return mark
    }

    let annotation: ReturnType<typeof annotate> | null = null
    let timer = 0
    let redrawTimer = 0
    let cancelled = false
    let lastSize = ""

    // When the words move (window resized, text wraps), draw the mark again in the new spot.
    const observer = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect()
      const size = `${Math.round(rect.width)}x${Math.round(rect.height)}:${Math.round(rect.left)}`
      if (!annotation || size === lastSize) {
        lastSize = size
        return
      }
      lastSize = size
      window.clearTimeout(redrawTimer)
      redrawTimer = window.setTimeout(() => {
        if (cancelled) return
        annotation?.remove()
        annotation = draw(false)
      }, 120)
    })
    observer.observe(element)
    if (element.parentElement) observer.observe(element.parentElement)

    // Wait for web fonts so the mark is drawn where the word ends up, not where it started.
    const fontsReady = document.fonts?.ready ?? Promise.resolve()
    void fontsReady.then(() => {
      if (cancelled) return
      if (drawnRef.current) {
        annotation = draw(false)
      } else {
        timer = window.setTimeout(() => (annotation = draw(true)), delay)
      }
    })
    return () => {
      cancelled = true
      observer.disconnect()
      window.clearTimeout(timer)
      window.clearTimeout(redrawTimer)
      annotation?.remove()
    }
  }, [color, delay, type, colors])

  return (
    <span ref={ref} className="scribble">
      {children}
    </span>
  )
}
