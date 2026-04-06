import type { ReactNode } from "react";

type SearchGroupProps<T> = {
  title: string;
  items: T[];
  renderItem: (item: T) => ReactNode;
};

export default function SearchGroup<T>({
  title,
  items,
  renderItem,
}: SearchGroupProps<T>) {
  return (
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
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <h2
          style={{
            margin: 0,
            color: "var(--foreground)",
            fontSize: 20,
          }}
        >
          {title}
        </h2>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: 28,
            padding: "0 10px",
            borderRadius: 999,
            background: "var(--surface-tint-soft)",
            color: "var(--accent-strong)",
            fontSize: 12,
            fontWeight: 800,
          }}
        >
          {items.length}
        </span>
      </div>

      {items.length > 0 ? (
        <div style={{ display: "grid", gap: 12 }}>
          {items.map((item, index) => (
            <div key={index}>{renderItem(item)}</div>
          ))}
        </div>
      ) : (
        <p
          style={{
            margin: 0,
            color: "var(--foreground-muted)",
            lineHeight: 1.6,
          }}
        >
          No {title.toLowerCase()} found for this search yet.
        </p>
      )}
    </section>
  );
}
