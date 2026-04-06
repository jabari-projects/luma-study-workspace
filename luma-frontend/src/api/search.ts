import { getSupabaseConfigError, supabase } from "./supabase";

const SEARCH_LIMIT = 8;

export type SearchNote = {
  id: string;
  title: string | null;
  content: string | null;
  tags: string[] | null;
  created_at: string | null;
};

export type SearchFlashcard = {
  id: string;
  front: string | null;
  back: string | null;
  tags: string[] | null;
  created_at: string | null;
};

export type SearchSession = {
  id: string;
  name: string | null;
  subject: string | null;
  notes: string | null;
  duration_seconds: number | null;
  created_at: string | null;
};

export type SearchSummary = {
  id: string;
  content: string | null;
  created_at: string | null;
};

export type SearchTranscript = {
  id: string;
  content: string | null;
  created_at: string | null;
};

export type SearchResults = {
  notes: SearchNote[];
  flashcards: SearchFlashcard[];
  sessions: SearchSession[];
  summaries: SearchSummary[];
  transcripts: SearchTranscript[];
};

export function emptySearchResults(): SearchResults {
  return {
    notes: [],
    flashcards: [],
    sessions: [],
    summaries: [],
    transcripts: [],
  };
}

function normalizeSearchQuery(query: string) {
  return query.trim().replace(/\s+/g, " ");
}

function isRecoverableSearchError(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("does not exist") ||
    normalized.includes("relation") ||
    normalized.includes("column") ||
    normalized.includes("search_vector") ||
    normalized.includes("function") ||
    normalized.includes("schema cache")
  );
}

async function runTextSearch<T>(
  table: string,
  selectFields: string,
  query: string,
  userId: string,
) {
  if (!supabase) {
    throw new Error(
      getSupabaseConfigError().replace(
        "flashcard sync",
        "private study search",
      ),
    );
  }

  const response = await supabase
    .from(table)
    .select(selectFields)
    .eq("user_id", userId)
    .textSearch("search_vector", query, {
      config: "english",
      type: "websearch",
    })
    .order("created_at", { ascending: false })
    .limit(SEARCH_LIMIT);

  if (response.error) {
    if (isRecoverableSearchError(response.error.message)) {
      return [] as T[];
    }

    throw new Error(response.error.message);
  }

  return (response.data ?? []) as T[];
}

export async function searchAll(query: string, userId: string) {
  const normalizedQuery = normalizeSearchQuery(query);

  if (!normalizedQuery) {
    return emptySearchResults();
  }

  const [
    notes,
    flashcards,
    sessions,
    summaries,
    transcripts,
  ] = await Promise.all([
    runTextSearch<SearchNote>(
      "notes",
      "id, title, content, tags, created_at",
      normalizedQuery,
      userId,
    ),
    runTextSearch<SearchFlashcard>(
      "flashcards",
      "id, front, back, tags, created_at",
      normalizedQuery,
      userId,
    ),
    runTextSearch<SearchSession>(
      "study_sessions",
      "id, name, subject, notes, duration_seconds, created_at",
      normalizedQuery,
      userId,
    ),
    runTextSearch<SearchSummary>(
      "summaries",
      "id, content, created_at",
      normalizedQuery,
      userId,
    ),
    runTextSearch<SearchTranscript>(
      "transcripts",
      "id, content, created_at",
      normalizedQuery,
      userId,
    ),
  ]);

  return {
    notes,
    flashcards,
    sessions,
    summaries,
    transcripts,
  };
}
