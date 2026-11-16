import type { Deck, DeckCard, Mastery } from "./deck"
import { deckStats, glowLevels, masteryOf } from "./deck"

const order: Mastery[] = ["solid", "shaky", "learning", "new"]

/** A bar that shows how bright (well-learned) a deck is. */
export function GlowBar({ deck }: { deck: Deck }) {
  const stats = deckStats(deck)
  if (stats.total === 0) {
    return <div className="glow-bar empty" aria-hidden="true" />
  }
  return (
    <div
      className="glow-bar"
      role="img"
      aria-label={order.map((level) => `${stats.counts[level]} ${glowLevels[level].name}`).join(", ")}
    >
      {order.map((level) =>
        stats.counts[level] > 0 ? (
          <span
            key={level}
            className={`glow-seg ${level}`}
            style={{ flexGrow: stats.counts[level] }}
          />
        ) : null,
      )}
    </div>
  )
}

export function GlowChip({ card }: { card: DeckCard }) {
  const level = masteryOf(card)
  return (
    <span className={`glow-chip ${level}`} title={glowLevels[level].hint}>
      <span className="glow-dot" aria-hidden="true" />
      {glowLevels[level].name}
    </span>
  )
}

export function GlowLegend() {
  return (
    <ul className="glow-legend" aria-label="Glow levels">
      {(["new", "learning", "shaky", "solid"] as Mastery[]).map((level) => (
        <li key={level}>
          <span className={`glow-dot ${level}`} aria-hidden="true" />
          <strong>{glowLevels[level].name}</strong>
          <small>{glowLevels[level].hint}</small>
        </li>
      ))}
    </ul>
  )
}
