/** A flashcard written inside a note: "Question :: Answer" (an optional bullet in front is fine). */
export const CARD_LINE = /^\s*(?:[-*•]\s+)?(.{2,300}?)\s+::\s+(.{1,600})$/
