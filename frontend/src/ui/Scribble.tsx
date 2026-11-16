import { useEffect, useRef } from "react"
import type { ReactNode } from "react"
import { annotate } from "rough-notation"

type ScribbleType = "underline" | "highlight" | "circle" | "box" | "bracket"

/** Hand-drawn mark that sketches itself around a word once it appears. */
export function Scribble({
  children,
  type = "underline",
  color = "var(--scribble)",
  delay = 250,
}: {
  children: ReactNode
  type?: ScribbleType
  color?: string
  delay?: number
}) {
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const resolved = color.startsWith("var(")
      ? getComputedStyle(element).getPropertyValue(color.slice(4, -1)).trim() || "#f5b82e"
      : color
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
      if (!cancelled) timer = window.setTimeout(() => (annotation = draw(true)), delay)
    })
    return () => {
      cancelled = true
      observer.disconnect()
      window.clearTimeout(timer)
      window.clearTimeout(redrawTimer)
      annotation?.remove()
    }
  }, [color, delay, type])

  return (
    <span ref={ref} className="scribble">
      {children}
    </span>
  )
}
