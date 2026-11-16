import type { ReactNode } from "react"

import { CARD_LINE } from "./cardLine"

/**
 * A small, safe Markdown reader for notes. It builds React elements directly
 * (never raw HTML), so text from notes, imports or AI can't inject markup or scripts.
 * Supports: # headings, - bullets, 1. lists, > quotes, **bold**, *italic*, `code`,
 * and "Question :: Answer" card lines.
 */

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "card"; front: string; back: string }
  | { kind: "paragraph"; text: string }


function parseBlocks(source: string): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null

  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join(" ") })
    paragraph = []
    if (list) blocks.push({ kind: "list", ...list })
    list = null
  }

  for (const rawLine of source.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trimEnd()
    if (!line.trim()) {
      flush()
      continue
    }
    const card = line.match(CARD_LINE)
    if (card) {
      flush()
      blocks.push({ kind: "card", front: card[1].trim(), back: card[2].trim() })
      continue
    }
    const heading = line.match(/^\s*(#{1,4})\s+(.+)$/)
    if (heading) {
      flush()
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() })
      continue
    }
    const quote = line.match(/^\s*>\s?(.*)$/)
    if (quote) {
      flush()
      blocks.push({ kind: "quote", text: quote[1] })
      continue
    }
    const bullet = line.match(/^\s*[-*•]\s+(.+)$/)
    const numbered = line.match(/^\s*\d{1,3}[.)]\s+(.+)$/)
    if (bullet || numbered) {
      const ordered = Boolean(numbered && !bullet)
      if (paragraph.length) {
        blocks.push({ kind: "paragraph", text: paragraph.join(" ") })
        paragraph = []
      }
      if (!list || list.ordered !== ordered) {
        if (list) blocks.push({ kind: "list", ...list })
        list = { ordered, items: [] }
      }
      list.items.push((bullet ?? numbered)![1])
      continue
    }
    if (list) {
      blocks.push({ kind: "list", ...list })
      list = null
    }
    paragraph.push(line.trim())
  }
  flush()
  return blocks
}

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g

function renderInline(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  let last = 0
  let index = 0
  for (const match of text.matchAll(INLINE)) {
    const token = match[0]
    const start = match.index ?? 0
    if (start > last) parts.push(text.slice(last, start))
    const key = `i${index++}`
    if (token.startsWith("**") || token.startsWith("__")) parts.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    else if (token.startsWith("`")) parts.push(<code key={key}>{token.slice(1, -1)}</code>)
    else parts.push(<em key={key}>{token.slice(1, -1)}</em>)
    last = start + token.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

export function NoteMarkdown({ source }: { source: string }) {
  const blocks = parseBlocks(source)
  return (
    <div className="note-body">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading": {
            const Tag = (["h2", "h3", "h4", "h4"] as const)[block.level - 1]
            return <Tag key={index}>{renderInline(block.text)}</Tag>
          }
          case "list": {
            const items = block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)
            return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>
          }
          case "quote":
            return <blockquote key={index}>{renderInline(block.text)}</blockquote>
          case "card":
            return (
              <div key={index} className="note-card-line">
                <span className="note-card-q">{renderInline(block.front)}</span>
                <span className="note-card-a">{renderInline(block.back)}</span>
              </div>
            )
          default:
            return <p key={index}>{renderInline(block.text)}</p>
        }
      })}
    </div>
  )
}
