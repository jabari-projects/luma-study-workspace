import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  createPersonaBot,
  sendMessage,
  type ChatBot,
  type ChatMessage,
} from "./ChatEngine";
import StandardLumaBot from "./StandardLumaBot";
import { speak } from "./VoiceEngine";
import { useAuth } from "../../context/AuthContext";
import LumaStar from "../../assets/luma-star.png";
import StudyToolPanel from "../../components/StudyToolPanel";
import UpgradeModal from "../../components/UpgradeModal";
import { CONTEXTUAL_CHAT_STUDY_TOOLS } from "../study/studyTools";
import { trackFeatureUsage } from "../../lib/analytics";

const chatUiStyles = `
  .luma-chat {
    min-height: 100vh;
    padding: 16px;
  }

  .luma-chat__wrap {
    max-width: 1040px;
    margin: 0 auto;
    display: grid;
    gap: 12px;
  }

  .luma-chat__panel {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 20px;
    box-shadow: var(--shadow);
  }

  .luma-chat__hero {
    display: grid;
    gap: 12px;
  }

  .luma-chat__eyebrow {
    display: inline-flex;
    align-items: center;
    width: fit-content;
    padding: 8px 14px;
    border-radius: 999px;
    background: rgba(181, 155, 255, 0.14);
    color: var(--accent-strong);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .luma-chat__title {
    margin: 0;
    color: var(--foreground);
    font-size: clamp(2rem, 4vw, 3rem);
    line-height: 1.05;
  }

  .luma-chat__copy {
    margin: 0;
    color: var(--foreground-muted);
    line-height: 1.6;
    max-width: 760px;
  }

  .luma-chat__shell {
    display: grid;
    gap: 12px;
  }

  .luma-chat__layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(280px, 320px);
    gap: 12px;
    align-items: start;
  }

  .luma-chat__sidebar {
    display: grid;
    gap: 12px;
    align-content: start;
    position: sticky;
    top: 96px;
  }

  .luma-chat__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  .luma-chat__bot {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }

  .luma-chat__avatar {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    overflow: hidden;
    display: grid;
    place-items: center;
    background: rgba(181, 155, 255, 0.14);
    border: 1px solid var(--border);
    color: #ffffff;
    font-size: 18px;
    font-weight: 800;
    flex-shrink: 0;
  }

  .avatar {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    object-fit: cover;
    display: block;
  }

  .luma-chat__botMeta {
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  .luma-chat__botName {
    margin: 0;
    color: var(--foreground);
    font-size: 22px;
    line-height: 1.2;
  }

  .luma-chat__botPrompt {
    margin: 0;
    color: var(--foreground-muted);
    line-height: 1.5;
  }

  .luma-chat__voice {
    display: inline-flex;
    align-items: center;
    min-height: 36px;
    padding: 0 14px;
    border-radius: 999px;
    background: rgba(181, 155, 255, 0.12);
    border: 1px solid var(--border);
    color: var(--foreground);
    font-size: 13px;
    font-weight: 700;
  }

  .luma-chat__messages {
    min-height: 360px;
    max-height: 560px;
    overflow: auto;
    display: grid;
    gap: 12px;
    padding: 4px;
  }

  .luma-chat__message {
    display: grid;
    gap: 8px;
  }

  .luma-chat__message.is-user {
    justify-items: end;
  }

  .luma-chat__messageRow {
    display: flex;
    gap: 10px;
    max-width: min(720px, 100%);
    align-items: flex-start;
  }

  .luma-chat__message.is-user .luma-chat__messageRow {
    flex-direction: row-reverse;
  }

  .luma-chat__bubbleAvatar {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    overflow: hidden;
    display: grid;
    place-items: center;
    background: rgba(181, 155, 255, 0.14);
    border: 1px solid var(--border);
    color: var(--accent-strong);
    font-weight: 800;
    flex-shrink: 0;
  }

  .luma-chat__bubble {
    display: grid;
    gap: 8px;
    border-radius: 16px;
    padding: 16px;
    background: var(--card);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
  }

  .luma-chat__message.is-user .luma-chat__bubble {
    background: color-mix(in srgb, var(--card) 90%, rgba(181, 155, 255, 0.12));
  }

  .luma-chat__bubbleMeta {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .luma-chat__bubbleMetaSpacer {
    flex: 1 1 auto;
  }

  .luma-chat__bubbleAuthor {
    color: var(--foreground);
    font-size: 13px;
    font-weight: 800;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }

  .luma-chat__bubbleTime {
    color: var(--foreground-muted);
    font-size: 12px;
  }

  .luma-chat__playButton {
    min-height: 32px;
    padding: 0 12px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--foreground);
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    box-shadow: var(--shadow);
  }

  .luma-chat__bubbleText {
    margin: 0;
    color: var(--foreground);
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .luma-chat__composer {
    display: grid;
    gap: 12px;
  }

  .luma-chat__sidebarEyebrow {
    display: inline-flex;
    align-items: center;
    width: fit-content;
    padding: 8px 14px;
    border-radius: 999px;
    background: rgba(181, 155, 255, 0.14);
    color: var(--accent-strong);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .luma-chat__input {
    width: 100%;
    box-sizing: border-box;
    min-height: 120px;
    resize: vertical;
    border-radius: 16px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--foreground);
    padding: 16px;
    font: inherit;
    outline: none;
  }

  .luma-chat__footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  .luma-chat__hint {
    margin: 0;
    color: var(--foreground-muted);
    line-height: 1.5;
  }

  .luma-chat__button {
    min-height: 48px;
    padding: 0 18px;
    border-radius: 16px;
    border: none;
    background: linear-gradient(135deg, var(--accent-strong), var(--accent));
    color: #ffffff;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
    box-shadow: var(--shadow);
  }

  .luma-chat__button:disabled {
    cursor: not-allowed;
    opacity: 0.68;
  }

  .luma-chat__error {
    margin: 0;
    border-radius: 16px;
    border: 1px solid rgba(226, 120, 145, 0.28);
    background: rgba(226, 120, 145, 0.12);
    color: #b63d61;
    padding: 16px;
    line-height: 1.5;
  }

  @media (max-width: 720px) {
    .luma-chat__layout {
      grid-template-columns: 1fr;
    }

    .luma-chat__sidebar {
      position: static;
    }

    .luma-chat__header {
      align-items: flex-start;
    }

    .luma-chat__footer {
      align-items: stretch;
    }

    .luma-chat__button {
      width: 100%;
    }
  }
`;

type ChatUIProps = {
  bot?: ChatBot;
};

function getInitials(value: string) {
  return (
    value
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "LU"
  );
}

function formatTimestamp(value: string) {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  return parsed.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function buildInitialAssistantMessage(bot: ChatBot): ChatMessage {
  return {
    id: "chatbot-welcome",
    role: "assistant",
    content: `${bot.name} is ready. This chat architecture is live, and AI responses can plug in next.`,
    createdAt: new Date().toISOString(),
  };
}

export default function ChatUI({ bot }: ChatUIProps) {
  const { activePersona, user } = useAuth();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [headerAvatarFailed, setHeaderAvatarFailed] = useState(false);
  const [messageAvatarFailed, setMessageAvatarFailed] = useState(false);
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  const [upgradeFeatureName, setUpgradeFeatureName] = useState(
    "Premium study tools",
  );
  const resolvedBot =
    bot ?? (activePersona ? createPersonaBot(activePersona) : StandardLumaBot);
  const headerAvatarSrc = activePersona?.avatar_url || LumaStar;
  const headerDisplayName = activePersona?.name || "Luma";
  const botSignature = useMemo(
    () =>
      [
        resolvedBot.name,
        resolvedBot.systemPrompt,
        resolvedBot.voice,
        resolvedBot.avatar ?? "",
        activePersona?.avatar_url ?? "",
        activePersona?.name ?? "",
      ].join("|"),
    [
      activePersona?.avatar_url,
      activePersona?.name,
      resolvedBot.avatar,
      resolvedBot.name,
      resolvedBot.systemPrompt,
      resolvedBot.voice,
    ],
  );
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    buildInitialAssistantMessage(resolvedBot),
  ]);

  const botInitials = useMemo(
    () => getInitials(headerDisplayName),
    [headerDisplayName],
  );
  const isPremium = user?.subscription_status === "premium";

  useEffect(() => {
    setHeaderAvatarFailed(false);
    setMessageAvatarFailed(false);
  }, [headerAvatarSrc]);

  useEffect(() => {
    setMessages([buildInitialAssistantMessage(resolvedBot)]);
    setDraft("");
    setError("");
    setSending(false);
  }, [botSignature]);

  function handleToolOptionClick(tool: (typeof CONTEXTUAL_CHAT_STUDY_TOOLS)[number]) {
    setDraft((current) => {
      const trimmed = current.trim();
      return trimmed ? `${trimmed}\n\n${tool.prompt}` : tool.prompt;
    });
    setError("");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextMessage = draft.trim();
    if (!nextMessage) {
      setError("Enter a message before sending.");
      return;
    }

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: nextMessage,
      createdAt: new Date().toISOString(),
    };

    setMessages((current) => [...current, userMessage]);
    setDraft("");
    setError("");
    setSending(true);
    trackFeatureUsage("chat", {
      surface: "chat",
      subscriptionStatus: user?.subscription_status ?? null,
      metadata: {
        action: "message_sent",
      },
    });

    try {
      const reply = await sendMessage(resolvedBot, nextMessage);
      setMessages((current) => [...current, reply]);
    } catch (sendError) {
      setError(
        sendError instanceof Error && sendError.message
          ? sendError.message
          : "Unable to send your message right now.",
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <style>{chatUiStyles}</style>

      <main className="luma-chat">
        <div className="luma-chat__wrap">
          <section className="luma-chat__panel luma-chat__hero">
            <span className="luma-chat__eyebrow">Chatbot</span>
            <h1 className="luma-chat__title">Luma Chat</h1>
            <p className="luma-chat__copy">
              Use the shared chat UI with the standard Luma assistant or swap in
              a premium persona bot later without rebuilding the interface.
            </p>
          </section>

          <div className="luma-chat__layout">
            <section className="luma-chat__panel luma-chat__shell">
              <header className="luma-chat__header">
                <div className="luma-chat__bot">
                  <div className="luma-chat__avatar" aria-hidden="true">
                    {!headerAvatarFailed ? (
                      <img
                        className="avatar"
                        src={headerAvatarSrc}
                        alt=""
                        onError={() => {
                          setHeaderAvatarFailed(true);
                        }}
                      />
                    ) : (
                      botInitials
                    )}
                  </div>
                  <div className="luma-chat__botMeta">
                    <h2 className="luma-chat__botName">{headerDisplayName}</h2>
                    <p className="luma-chat__botPrompt">{resolvedBot.systemPrompt}</p>
                  </div>
                </div>

                <span className="luma-chat__voice">Voice: {resolvedBot.voice}</span>
              </header>

              <div className="luma-chat__messages" aria-live="polite">
                {messages.map((message) => {
                  const isUser = message.role === "user";
                  const authorLabel = isUser ? "You" : headerDisplayName;
                  const avatarLabel = isUser ? "You" : botInitials;

                  return (
                    <article
                      key={message.id}
                      className={`luma-chat__message${isUser ? " is-user" : ""}`}
                    >
                      <div className="luma-chat__messageRow">
                        <div className="luma-chat__bubbleAvatar" aria-hidden="true">
                          {!isUser && !messageAvatarFailed ? (
                            <img
                              className="avatar"
                              src={headerAvatarSrc}
                              alt=""
                              onError={() => {
                                setMessageAvatarFailed(true);
                              }}
                            />
                          ) : (
                            avatarLabel
                          )}
                        </div>

                        <div className="luma-chat__bubble">
                          <div className="luma-chat__bubbleMeta">
                            <span className="luma-chat__bubbleAuthor">
                              {authorLabel}
                            </span>
                            <span className="luma-chat__bubbleTime">
                              {formatTimestamp(message.createdAt)}
                            </span>
                            {!isUser ? (
                              <>
                                <span className="luma-chat__bubbleMetaSpacer" />
                                <button
                                  className="luma-chat__playButton"
                                  type="button"
                                  onClick={() => {
                                    void speak(message.content, resolvedBot.voice);
                                  }}
                                >
                                  Play
                                </button>
                              </>
                            ) : null}
                          </div>
                          <p className="luma-chat__bubbleText">{message.content}</p>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>

              <form className="luma-chat__composer" onSubmit={handleSubmit}>
                <textarea
                  className="luma-chat__input"
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setError("");
                  }}
                  placeholder={`Message ${resolvedBot.name}`}
                />

                {error ? (
                  <p className="luma-chat__error" role="alert">
                    {error}
                  </p>
                ) : null}

                <div className="luma-chat__footer">
                  <p className="luma-chat__hint">
                    Architecture only for now. AI delivery can plug into the engine next.
                  </p>
                  <button
                    className="luma-chat__button"
                    type="submit"
                    disabled={sending}
                  >
                    {sending ? "Sending..." : "Send"}
                  </button>
                </div>
              </form>
            </section>

            <aside className="luma-chat__panel luma-chat__sidebar">
              <span className="luma-chat__sidebarEyebrow">Study</span>
              <StudyToolPanel
                title="Study shortcuts"
                description="Keep focused tools beside the conversation. Unlocked shortcuts drop a prompt into the composer, and locked tools open the same upgrade path used across the app."
                tools={CONTEXTUAL_CHAT_STUDY_TOOLS}
                isPremium={isPremium}
                surface="chat-sidebar"
                onLockedClick={(tool) => {
                  setUpgradeFeatureName(tool.label);
                  setUpgradeModalOpen(true);
                }}
                onToolSelect={handleToolOptionClick}
              />
            </aside>
          </div>
        </div>
      </main>

      <UpgradeModal
        open={upgradeModalOpen}
        onClose={() => setUpgradeModalOpen(false)}
        featureName={upgradeFeatureName}
      />
    </>
  );
}
