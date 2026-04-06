import api from "./api";
import {
  emptySearchResults,
  searchAll,
  type SearchFlashcard,
  type SearchNote,
  type SearchResults,
  type SearchSession,
  type SearchSummary,
  type SearchTranscript,
} from "./search";
import { getSupabaseConfigError, supabase } from "./supabase";

const SEARCH_LIMIT = 8;

type SemanticSearchPayload = {
  keywords: string[];
  embedding: number[] | null;
};

type SimilarityRow = {
  similarity?: number;
};

function normalizeSearchQuery(query: string) {
  return query.trim().replace(/\s+/g, " ");
}

function isRecoverableSemanticError(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("does not exist") ||
    normalized.includes("relation") ||
    normalized.includes("function") ||
    normalized.includes("schema cache") ||
    normalized.includes("embedding")
  );
}

function formatVector(values: number[]) {
  return `[${values.map((value) => Number(value).toString()).join(",")}]`;
}

function stripSimilarity<T extends SimilarityRow>(rows: T[]) {
  return rows.map(({ similarity: _similarity, ...item }) => item) as Array<
    Omit<T, "similarity">
  >;
}

async function runVectorSearch<T extends SimilarityRow>(
  rpcName: string,
  userId: string,
  embedding: number[],
) {
  if (!supabase) {
    throw new Error(
      getSupabaseConfigError().replace(
        "flashcard sync",
        "private study search",
      ),
    );
  }

  const response = await supabase.rpc(rpcName, {
    query_embedding: formatVector(embedding),
    match_user_id: userId,
    match_count: SEARCH_LIMIT,
  });

  if (response.error) {
    if (isRecoverableSemanticError(response.error.message)) {
      return [] as Array<Omit<T, "similarity">>;
    }

    throw new Error(response.error.message);
  }

  return stripSimilarity((response.data ?? []) as T[]);
}

export async function semanticSearch(query: string, userId: string): Promise<SearchResults> {
  const normalizedQuery = normalizeSearchQuery(query);

  if (!normalizedQuery) {
    return emptySearchResults();
  }

  let semanticPayload: SemanticSearchPayload | null = null;

  try {
    const response = await api.post<SemanticSearchPayload>(
      "/api/semantic-search",
      { query: normalizedQuery },
    );
    semanticPayload = response.data;
  } catch {
    return searchAll(normalizedQuery, userId);
  }

  const expandedQuery = Array.from(
    new Set(
      [normalizedQuery, ...(semanticPayload.keywords ?? [])]
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ).join(" ");

  const fallbackResultsPromise = searchAll(expandedQuery || normalizedQuery, userId);

  if (!semanticPayload.embedding || semanticPayload.embedding.length === 0) {
    return fallbackResultsPromise;
  }

  try {
    const [
      notes,
      flashcards,
      sessions,
      summaries,
      transcripts,
      fallbackResults,
    ] = await Promise.all([
      runVectorSearch<SearchNote & SimilarityRow>(
        "match_notes",
        userId,
        semanticPayload.embedding,
      ),
      runVectorSearch<SearchFlashcard & SimilarityRow>(
        "match_flashcards",
        userId,
        semanticPayload.embedding,
      ),
      runVectorSearch<SearchSession & SimilarityRow>(
        "match_study_sessions",
        userId,
        semanticPayload.embedding,
      ),
      runVectorSearch<SearchSummary & SimilarityRow>(
        "match_summaries",
        userId,
        semanticPayload.embedding,
      ),
      runVectorSearch<SearchTranscript & SimilarityRow>(
        "match_transcripts",
        userId,
        semanticPayload.embedding,
      ),
      fallbackResultsPromise,
    ]);

    return {
      notes: notes.length > 0 ? notes : fallbackResults.notes,
      flashcards: flashcards.length > 0 ? flashcards : fallbackResults.flashcards,
      sessions: sessions.length > 0 ? sessions : fallbackResults.sessions,
      summaries: summaries.length > 0 ? summaries : fallbackResults.summaries,
      transcripts:
        transcripts.length > 0 ? transcripts : fallbackResults.transcripts,
    };
  } catch {
    return fallbackResultsPromise;
  }
}
