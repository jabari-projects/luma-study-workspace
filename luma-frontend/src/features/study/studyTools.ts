export type StudyTool = {
  id: string;
  label: string;
  to: string;
  premium: boolean;
  summary: string;
  prompt: string;
};

export const STUDY_TOOLS: StudyTool[] = [
  {
    id: "search",
    label: "Search Workspace",
    to: "/search",
    premium: false,
    summary: "Find notes, flashcards, sessions, summaries, and transcripts.",
    prompt: "Help me search my study workspace for the material I need.",
  },
  {
    id: "flashcards",
    label: "Flashcards",
    to: "/flashcards",
    premium: true,
    summary: "Build and review memory prompts for faster recall.",
    prompt: "Help me turn this lesson into clear flashcards I can review.",
  },
  {
    id: "image-to-notes",
    label: "Image to Notes",
    to: "/image-to-notes",
    premium: true,
    summary: "Turn diagrams, pages, and screenshots into study notes.",
    prompt: "Help me turn an image into clean study notes with key takeaways.",
  },
  {
    id: "voice-input",
    label: "Voice Input",
    to: "/voice-input",
    premium: true,
    summary: "Capture spoken ideas and organize them into written notes.",
    prompt: "Help me organize a spoken explanation into concise study notes.",
  },
  {
    id: "study-session",
    label: "Study Session",
    to: "/study-session",
    premium: true,
    summary: "Plan focused sessions and keep your learning momentum moving.",
    prompt: "Help me plan a focused study session with a clear goal and steps.",
  },
];

export const CONTEXTUAL_CHAT_STUDY_TOOLS = STUDY_TOOLS.filter(
  (tool) => tool.premium,
);
