import { useEffect, useMemo, useState } from "react";
import {
  emptySearchResults,
  searchAll,
  type SearchFlashcard,
  type SearchNote,
  type SearchResults,
  type SearchSession,
  type SearchSummary,
  type SearchTranscript,
} from "../api/search";
import { semanticSearch } from "../api/semanticSearch";
import { useAuth } from "../context/AuthContext";
import SearchGroup from "./SearchGroup";

type SearchBarProps = {
  placeholder?: string;
  semanticEnabled?: boolean;
};

function truncateText(value: string | null | undefined, limit = 160) {
  const normalized = (value ?? "").trim().replace(/\s+/g, " ");

  if (!normalized) {
    return "No preview available yet.";
  }

  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit).trimEnd()}...`;
}

function formatDateLabel(value: string | null) {
  if (!value) {
    return "Saved recently";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Saved recently";
  }

  return date.toLocaleDateString();
}

function formatDuration(seconds: number | null) {
  const safeSeconds = Number(seconds ?? 0);
  if (safeSeconds <= 0) {
    return "No duration logged";
  }

  const minutes = Math.floor(safeSeconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours <= 0) {
    return `${minutes} min`;
  }

  return `${hours}h ${remainingMinutes}m`;
}

function renderTagRow(tags: string[] | null | undefined) {
  if (!tags || tags.length === 0) {
    return null;
  }

  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        flexWrap: "wrap",
      }}
    >
      {tags.slice(0, 4).map((tag) => (
        <span
          key={tag}
          style={{
            display: "inline-flex",
            alignItems: "center",
            minHeight: 28,
            padding: "0 10px",
            borderRadius: 999,
            background: "var(--surface-tint-soft)",
            color: "var(--accent-strong)",
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          {tag}
        </span>
      ))}
    </div>
  );
}

function SearchResultCard({
  title,
  meta,
  excerpt,
  tags,
}: {
  title: string;
  meta: string;
  excerpt: string;
  tags?: string[] | null;
}) {
  return (
    <article
      style={{
        display: "grid",
        gap: 10,
        padding: 16,
        background: "var(--surface-tint-soft)",
        border: "1px solid var(--border)",
        borderRadius: 16,
      }}
    >
      <div style={{ display: "grid", gap: 6 }}>
        <h3
          style={{
            margin: 0,
            color: "var(--foreground)",
            fontSize: 17,
          }}
        >
          {title}
        </h3>
        <p
          style={{
            margin: 0,
            color: "var(--foreground-muted)",
            fontSize: 13,
            fontWeight: 700,
          }}
        >
          {meta}
        </p>
      </div>

      <p
        style={{
          margin: 0,
          color: "var(--foreground-muted)",
          lineHeight: 1.65,
          fontSize: 14,
        }}
      >
        {excerpt}
      </p>

      {renderTagRow(tags)}
    </article>
  );
}

export default function SearchBar({
  placeholder = "Search notes, flashcards, summaries, or transcripts",
  semanticEnabled = false,
}: SearchBarProps) {
  const { user } = useAuth();
  const activeUserId = user?.id ?? "";
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [results, setResults] = useState<SearchResults>(emptySearchResults);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 300);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [query]);

  useEffect(() => {
    let cancelled = false;

    if (!activeUserId) {
      setResults(emptySearchResults());
      setError("Sign in to search your private study materials.");
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    if (!debouncedQuery) {
      setResults(emptySearchResults());
      setError("");
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    async function runSearch() {
      setLoading(true);
      setError("");

      try {
        const nextResults = semanticEnabled
          ? await semanticSearch(debouncedQuery, activeUserId)
          : await searchAll(debouncedQuery, activeUserId);

        if (!cancelled) {
          setResults(nextResults);
        }
      } catch (searchError) {
        if (!cancelled) {
          setResults(emptySearchResults());
          setError(
            searchError instanceof Error
              ? searchError.message
              : "Unable to search your study materials right now.",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void runSearch();

    return () => {
      cancelled = true;
    };
  }, [activeUserId, debouncedQuery, semanticEnabled]);

  const totalResults = useMemo(
    () =>
      results.notes.length +
      results.flashcards.length +
      results.sessions.length +
      results.summaries.length +
      results.transcripts.length,
    [results],
  );

  return (
    <div
      style={{
        display: "grid",
        gap: 16,
      }}
    >
      <section
        style={{
          display: "grid",
          gap: 12,
          padding: 16,
          background: "var(--card)",
          border: "1px solid var(--border)",
          borderRadius: 16,
          boxShadow: "var(--shadow)",
        }}
      >
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setError("");
          }}
          placeholder={placeholder}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: 16,
            borderRadius: 16,
            border: "1px solid var(--border)",
            background: "var(--card)",
            color: "var(--foreground)",
            fontSize: 16,
            outline: "none",
            boxShadow: "var(--shadow)",
          }}
        />

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <p
            style={{
              margin: 0,
              color: error ? "var(--danger)" : "var(--foreground-muted)",
              fontSize: 14,
              lineHeight: 1.6,
            }}
          >
            {!debouncedQuery
              ? "Search across your own notes, flashcards, study sessions, summaries, and transcripts."
              : loading
                ? `Searching ${semanticEnabled ? "semantically" : "your workspace"} for "${debouncedQuery}"...`
                : error
                  ? error
                  : `${totalResults} match${totalResults === 1 ? "" : "es"} found across your private study materials.`}
          </p>

          {semanticEnabled ? (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                minHeight: 28,
                padding: "0 10px",
                borderRadius: 999,
                background: "var(--surface-tint-soft)",
                color: "var(--accent-strong)",
                fontSize: 12,
                fontWeight: 800,
              }}
            >
              Semantic Search On
            </span>
          ) : null}
        </div>
      </section>

      {loading ? (
        <section
          style={{
            display: "grid",
            gap: 12,
            padding: 16,
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            boxShadow: "var(--shadow)",
          }}
        >
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              key={index}
              aria-hidden="true"
              style={{
                display: "grid",
                gap: 10,
                padding: 16,
                borderRadius: 16,
                background: "var(--surface-tint-soft)",
                border: "1px solid var(--border)",
              }}
            >
              <div
                style={{
                  width: "42%",
                  height: 16,
                  borderRadius: 999,
                  background: "var(--surface-tint-strong)",
                }}
              />
              <div
                style={{
                  width: "100%",
                  height: 12,
                  borderRadius: 999,
                  background: "var(--surface-tint-soft)",
                }}
              />
              <div
                style={{
                  width: "76%",
                  height: 12,
                  borderRadius: 999,
                  background: "var(--surface-tint-soft)",
                }}
              />
            </div>
          ))}
        </section>
      ) : null}

      {!loading && debouncedQuery ? (
        <div
          style={{
            display: "grid",
            gap: 16,
          }}
        >
          <SearchGroup
            title="Notes"
            items={results.notes}
            renderItem={(item: SearchNote) => (
              <SearchResultCard
                title={item.title?.trim() || "Untitled note"}
                meta={formatDateLabel(item.created_at)}
                excerpt={truncateText(item.content)}
                tags={item.tags}
              />
            )}
          />
          <SearchGroup
            title="Flashcards"
            items={results.flashcards}
            renderItem={(item: SearchFlashcard) => (
              <SearchResultCard
                title={item.front?.trim() || "Untitled flashcard"}
                meta={formatDateLabel(item.created_at)}
                excerpt={truncateText(item.back)}
                tags={item.tags}
              />
            )}
          />
          <SearchGroup
            title="Study Sessions"
            items={results.sessions}
            renderItem={(item: SearchSession) => (
              <SearchResultCard
                title={item.name?.trim() || item.subject?.trim() || "Study session"}
                meta={`${formatDateLabel(item.created_at)} • ${formatDuration(item.duration_seconds)}`}
                excerpt={truncateText(item.notes || item.subject)}
              />
            )}
          />
          <SearchGroup
            title="Summaries"
            items={results.summaries}
            renderItem={(item: SearchSummary) => (
              <SearchResultCard
                title="Saved summary"
                meta={formatDateLabel(item.created_at)}
                excerpt={truncateText(item.content)}
              />
            )}
          />
          <SearchGroup
            title="Transcripts"
            items={results.transcripts}
            renderItem={(item: SearchTranscript) => (
              <SearchResultCard
                title="Transcript"
                meta={formatDateLabel(item.created_at)}
                excerpt={truncateText(item.content)}
              />
            )}
          />
        </div>
      ) : null}

      {!loading && !debouncedQuery ? (
        <section
          style={{
            padding: 16,
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            boxShadow: "var(--shadow)",
            color: "var(--foreground-muted)",
            lineHeight: 1.6,
          }}
        >
          Start with a keyword, subject, concept, or phrase to search only your
          own study materials.
        </section>
      ) : null}
    </div>
  );
}
