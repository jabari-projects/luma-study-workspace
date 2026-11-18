// Every signed-in page and every public page, for the checks that visit them all
// (axe in each theme, no sideways scrolling on a phone). Seeded fake data only:
// d1 is demo's "Solar System" deck and the summary is demo's "The water cycle in short".
export const APP_PAGES = [
  { path: "/dashboard", label: "dashboard" },
  { path: "/notes", label: "notes-hub" },
  { path: "/notes/new", label: "new-note" },
  { path: "/notes/import", label: "import" },
  { path: "/notes/voice", label: "voice-to-notes" },
  { path: "/notes/image", label: "image-to-notes" },
  { path: "/summaries/5a1e0000-0000-4000-8000-000000000001", label: "note-view" },
  { path: "/flashcards", label: "study-hub" },
  { path: "/flashcards/d1", label: "deck" },
  { path: "/flashcards/new", label: "deck-editor" },
  { path: "/quizzes", label: "quiz-setup" },
  { path: "/study-sessions", label: "study-plans" },
  { path: "/search", label: "search" },
  { path: "/settings", label: "settings" },
  { path: "/admin/reports", label: "admin-reports" },
  { path: "/feedback", label: "feedback-poll" },
  { path: "/feedback/results", label: "feedback-results" },
  { path: "/admin/feedback", label: "admin-feedback" },
] as const

export const PUBLIC_PAGES = [
  { path: "/", label: "start" },
  { path: "/login", label: "login" },
  { path: "/signup", label: "signup" },
  { path: "/forgot-password", label: "forgot-password" },
  { path: "/reset-password?token=made-up-test-token", label: "reset-password" },
] as const
