import { Link } from "react-router-dom";
import type { CSSProperties } from "react";
import type { StudyTool } from "../features/study/studyTools";
import LockIcon from "./LockIcon";
import { trackStudyToolUsage } from "../lib/analytics";

const studyToolPanelStyles = `
  @keyframes luma-study-panel-slide-in {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @keyframes luma-study-panel-item-in {
    from {
      opacity: 0;
      transform: translateX(10px);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }

  .luma-study-panel {
    display: grid;
    gap: 14px;
    padding: 16px;
    border-radius: 20px;
    background: var(--card);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
    animation: luma-study-panel-slide-in 220ms ease;
  }

  .luma-study-panel__header {
    display: grid;
    gap: 4px;
  }

  .luma-study-panel__title {
    margin: 0;
    color: var(--foreground);
    font-size: 0.98rem;
    font-weight: 800;
    letter-spacing: -0.02em;
  }

  .luma-study-panel__copy {
    margin: 0;
    color: var(--foreground-muted);
    font-size: 0.84rem;
    line-height: 1.55;
  }

  .luma-study-panel__list {
    display: grid;
    gap: 10px;
  }

  .luma-study-panel__itemWrap {
    position: relative;
    animation: luma-study-panel-item-in 220ms ease both;
  }

  .luma-study-panel__item {
    width: 100%;
    display: grid;
    gap: 10px;
    padding: 14px;
    border-radius: 16px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--foreground);
    text-decoration: none;
    text-align: left;
    cursor: pointer;
    box-shadow: var(--shadow);
    transition:
      transform 180ms ease,
      border-color 180ms ease,
      box-shadow 180ms ease,
      background 180ms ease;
  }

  .luma-study-panel__item:hover,
  .luma-study-panel__item:focus-visible {
    transform: translateY(-2px);
    border-color: var(--border-strong);
    box-shadow: var(--shadow-soft);
    outline: none;
  }

  .luma-study-panel__item.is-locked {
    background: var(--surface-tint-soft);
  }

  .luma-study-panel__itemTop {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .luma-study-panel__identity {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }

  .luma-study-panel__icon {
    width: 38px;
    height: 38px;
    display: grid;
    place-items: center;
    border-radius: 14px;
    background: var(--surface-tint-soft);
    color: var(--accent-strong);
    border: 1px solid var(--border);
    flex-shrink: 0;
  }

  .luma-study-panel__icon svg {
    width: 18px;
    height: 18px;
    stroke: currentColor;
  }

  .luma-study-panel__labelGroup {
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  .luma-study-panel__label {
    color: var(--foreground);
    font-size: 0.92rem;
    font-weight: 800;
    line-height: 1.25;
  }

  .luma-study-panel__meta {
    color: var(--foreground-muted);
    font-size: 0.76rem;
    line-height: 1.45;
  }

  .luma-study-panel__summary {
    margin: 0;
    color: var(--foreground-muted);
    font-size: 0.8rem;
    line-height: 1.55;
  }

  .luma-study-panel__premium {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--accent-strong);
    font-size: 0.72rem;
    font-weight: 800;
    white-space: nowrap;
  }

  .luma-study-panel__tooltip {
    position: absolute;
    left: 14px;
    right: 14px;
    bottom: calc(100% + 10px);
    padding: 10px 12px;
    border-radius: 14px;
    background: var(--surface-overlay);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
    color: var(--foreground);
    font-size: 0.78rem;
    line-height: 1.45;
    opacity: 0;
    transform: translateY(6px);
    pointer-events: none;
    transition: opacity 180ms ease, transform 180ms ease;
    z-index: 4;
  }

  .luma-study-panel__itemWrap:hover .luma-study-panel__tooltip,
  .luma-study-panel__itemWrap:focus-within .luma-study-panel__tooltip {
    opacity: 1;
    transform: translateY(0);
  }

  .luma-study-panel--compact {
    padding: 14px;
  }

  .luma-study-panel--compact .luma-study-panel__list {
    gap: 8px;
  }
`;

function StudyToolIcon({ toolId }: { toolId: string }) {
  if (toolId === "flashcards") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="6" y="5" width="12" height="8" rx="2" strokeWidth="1.8" />
        <rect x="4" y="11" width="12" height="8" rx="2" strokeWidth="1.8" />
      </svg>
    );
  }

  if (toolId === "image-to-notes") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="4" y="5" width="16" height="14" rx="2.5" strokeWidth="1.8" />
        <circle cx="9" cy="10" r="1.6" strokeWidth="1.8" />
        <path d="M7 16l3.5-3.5L13 15l2-2 2 3" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  if (toolId === "voice-input") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="9" y="4" width="6" height="10" rx="3" strokeWidth="1.8" />
        <path d="M6.5 11.5a5.5 5.5 0 0011 0M12 17v3M9 20h6" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }

  if (toolId === "study-session") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="13" r="7" strokeWidth="1.8" />
        <path d="M12 13V9.5M12 13l2.8 1.8M9 4h6" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 6h14M5 12h14M5 18h9" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function getTooltipText(
  tool: StudyTool,
  isLocked: boolean,
  contextual: boolean,
) {
  if (isLocked) {
    return `${tool.label} is available for Premium members. Locked clicks open your upgrade path.`;
  }

  if (contextual) {
    return `Add a ${tool.label.toLowerCase()} shortcut to your current chat prompt.`;
  }

  return `Open ${tool.label} in your study workspace.`;
}

type StudyToolPanelProps = {
  title: string;
  description: string;
  tools: StudyTool[];
  isPremium: boolean;
  surface?: string;
  onLockedClick: (tool: StudyTool) => void;
  onToolSelect?: (tool: StudyTool) => void;
  onToolNavigate?: (tool: StudyTool) => void;
  compact?: boolean;
};

export default function StudyToolPanel({
  title,
  description,
  tools,
  isPremium,
  surface = "study_panel",
  onLockedClick,
  onToolSelect,
  onToolNavigate,
  compact = false,
}: StudyToolPanelProps) {
  return (
    <>
      <style>{studyToolPanelStyles}</style>

      <section
        className={`luma-study-panel${compact ? " luma-study-panel--compact" : ""}`}
        aria-label={title}
      >
        <div className="luma-study-panel__header">
          <p className="luma-study-panel__title">{title}</p>
          <p className="luma-study-panel__copy">{description}</p>
        </div>

        <div className="luma-study-panel__list">
          {tools.map((tool, index) => {
            const isLocked = tool.premium && !isPremium;
            const tooltip = getTooltipText(tool, isLocked, Boolean(onToolSelect));
            const itemStyle = {
              animationDelay: `${index * 35}ms`,
            } satisfies CSSProperties;
            const content = (
              <>
                <span className="luma-study-panel__itemTop">
                  <span className="luma-study-panel__identity">
                    <span className="luma-study-panel__icon" aria-hidden="true">
                      <StudyToolIcon toolId={tool.id} />
                    </span>
                    <span className="luma-study-panel__labelGroup">
                      <span className="luma-study-panel__label">{tool.label}</span>
                      <span className="luma-study-panel__meta">
                        {onToolSelect ? "Shortcut" : "Workspace tool"}
                      </span>
                    </span>
                  </span>

                  {isLocked ? (
                    <span className="luma-study-panel__premium">
                      <LockIcon size={14} />
                      <span>Premium</span>
                    </span>
                  ) : null}
                </span>

                <p className="luma-study-panel__summary">{tool.summary}</p>
              </>
            );

            return (
              <div
                key={tool.id}
                className="luma-study-panel__itemWrap"
                style={itemStyle}
              >
                {isLocked ? (
                  <button
                    type="button"
                    className="luma-study-panel__item is-locked"
                    onClick={() => {
                      trackStudyToolUsage(tool.id, "locked_click", {
                        surface,
                        subscriptionStatus: "free",
                      });
                      onLockedClick(tool);
                    }}
                  >
                    {content}
                  </button>
                ) : onToolSelect ? (
                  <button
                    type="button"
                    className="luma-study-panel__item"
                    onClick={() => {
                      trackStudyToolUsage(tool.id, "shortcut_insert", {
                        surface,
                        subscriptionStatus: isPremium ? "premium" : "free",
                      });
                      onToolSelect(tool);
                    }}
                  >
                    {content}
                  </button>
                ) : (
                  <Link
                    className="luma-study-panel__item"
                    to={tool.to}
                    onClick={() => {
                      trackStudyToolUsage(tool.id, "open", {
                        surface,
                        subscriptionStatus: isPremium ? "premium" : "free",
                      });
                      onToolNavigate?.(tool);
                    }}
                  >
                    {content}
                  </Link>
                )}

                <span className="luma-study-panel__tooltip" role="tooltip">
                  {tooltip}
                </span>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
