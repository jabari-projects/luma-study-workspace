/**
 * What Luma does, in one small picture: a note about plants turns into a flashcard.
 * Used on the start page, and with the account forms whenever there is room for it.
 * It is only a picture, so screen readers skip it; the words around it say the same thing.
 */
export function NotePreview({ className = "" }: { className?: string }) {
  return (
    <div className={`note-preview ${className}`.trim()} aria-hidden="true">
      <div className="note-preview-note">
        <p className="note-preview-title">Plants</p>
        <p>Plants make food from light.</p>
        <p>They need water and air.</p>
        <p>Leaves catch the sun.</p>
      </div>
      <svg className="note-preview-arrow" viewBox="0 0 120 80" focusable="false">
        <path d="M8 12 C 48 4, 92 22, 104 62" />
        <path d="M92 56 L 104 64 L 110 50" />
      </svg>
      <p className="note-preview-label">Luma makes cards!</p>
      <div className="note-preview-deck">
        <div className="note-preview-card">
          <span className="note-preview-count">Card 1 of 4</span>
          <p>How do plants make food?</p>
        </div>
      </div>
    </div>
  )
}
