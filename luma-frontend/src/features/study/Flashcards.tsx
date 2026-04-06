import { useEffect, useState, type FormEvent } from "react";
import { getSupabaseConfigError, supabase } from "../../api/supabase";
import LockedFeature from "../../components/LockedFeature";
import { useAuth } from "../../context/AuthContext";
import { trackFeatureUsage } from "../../lib/analytics";

type Flashcard = {
  id: string;
  front: string;
  back: string;
  created_at?: string | null;
};

const FREE_FLASHCARD_LIMIT = 10;

const flashcardStyles = `
  .luma-flashcards {
    min-height: 100vh;
    padding: 16px;
  }

  .luma-flashcards__wrap {
    max-width: 1100px;
    margin: 0 auto;
    display: grid;
    gap: 12px;
  }

  .luma-flashcards__panel {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 20px;
    box-shadow: var(--shadow);
  }

  .luma-flashcards__hero {
    display: grid;
    gap: 12px;
  }

  .luma-flashcards__eyebrow {
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

  .luma-flashcards__title {
    margin: 0;
    color: var(--foreground);
    font-size: clamp(2rem, 4vw, 3rem);
    line-height: 1.05;
  }

  .luma-flashcards__copy {
    margin: 0;
    color: var(--foreground-muted);
    line-height: 1.6;
    max-width: 760px;
  }

  .luma-flashcards__meta {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  .luma-flashcards__badge {
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

  .luma-flashcards__grid {
    display: grid;
    grid-template-columns: minmax(300px, 360px) minmax(0, 1fr);
    gap: 12px;
  }

  .luma-flashcards__section {
    display: grid;
    gap: 12px;
  }

  .luma-flashcards__sectionTitle {
    margin: 0;
    color: var(--foreground);
    font-size: 22px;
  }

  .luma-flashcards__sectionCopy {
    margin: 0;
    color: var(--foreground-muted);
    line-height: 1.6;
  }

  .luma-flashcards__form {
    display: grid;
    gap: 12px;
  }

  .luma-flashcards__field {
    display: grid;
    gap: 8px;
  }

  .luma-flashcards__label {
    color: var(--foreground);
    font-size: 14px;
    font-weight: 700;
  }

  .luma-flashcards__textarea {
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

  .luma-flashcards__error {
    margin: 0;
    border-radius: 16px;
    border: 1px solid rgba(226, 120, 145, 0.28);
    background: rgba(226, 120, 145, 0.12);
    color: #b63d61;
    padding: 16px;
    line-height: 1.5;
  }

  .luma-flashcards__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  .luma-flashcards__button,
  .luma-flashcards__buttonSecondary {
    min-height: 48px;
    padding: 0 18px;
    border-radius: 16px;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
  }

  .luma-flashcards__button {
    border: none;
    background: linear-gradient(135deg, var(--accent-strong), var(--accent));
    color: #ffffff;
    box-shadow: var(--shadow);
  }

  .luma-flashcards__buttonSecondary {
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--foreground);
    box-shadow: var(--shadow);
  }

  .luma-flashcards__button:disabled,
  .luma-flashcards__buttonSecondary:disabled {
    cursor: not-allowed;
    opacity: 0.65;
  }

  .luma-flashcards__viewer {
    display: grid;
    gap: 12px;
  }

  .luma-flashcards__viewerTop {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }

  .luma-flashcards__viewerHint {
    margin: 0;
    color: var(--foreground-muted);
    font-size: 14px;
  }

  .luma-flashcards__perspective {
    perspective: 1400px;
  }

  .luma-flashcards__cardButton {
    width: 100%;
    border: none;
    padding: 0;
    background: transparent;
    cursor: pointer;
  }

  .luma-flashcards__cardInner {
    position: relative;
    min-height: 320px;
    transform-style: preserve-3d;
    transition: transform 320ms ease;
  }

  .luma-flashcards__cardInner.is-flipped {
    transform: rotateY(180deg);
  }

  .luma-flashcards__face {
    position: absolute;
    inset: 0;
    display: grid;
    gap: 12px;
    align-content: space-between;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 20px;
    box-shadow: var(--shadow);
    backface-visibility: hidden;
  }

  .luma-flashcards__faceBack {
    transform: rotateY(180deg);
  }

  .luma-flashcards__faceLabel {
    margin: 0;
    color: var(--accent-strong);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .luma-flashcards__faceText {
    margin: 0;
    color: var(--foreground);
    font-size: clamp(1.4rem, 2vw, 1.9rem);
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .luma-flashcards__faceFooter {
    margin: 0;
    color: var(--foreground-muted);
    font-size: 14px;
    line-height: 1.5;
  }

  .luma-flashcards__nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  .luma-flashcards__index {
    margin: 0;
    color: var(--foreground-muted);
    font-size: 14px;
    font-weight: 700;
  }

  .luma-flashcards__list {
    display: grid;
    gap: 12px;
  }

  .luma-flashcards__listItem {
    width: 100%;
    text-align: left;
    border-radius: 16px;
    border: 1px solid var(--border);
    background: var(--card);
    padding: 16px;
    box-shadow: var(--shadow);
    cursor: pointer;
    display: grid;
    gap: 8px;
  }

  .luma-flashcards__listItem.is-active {
    border-color: rgba(140, 111, 255, 0.36);
    background: rgba(181, 155, 255, 0.08);
  }

  .luma-flashcards__listLabel {
    margin: 0;
    color: var(--foreground);
    font-size: 13px;
    font-weight: 800;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .luma-flashcards__listFront,
  .luma-flashcards__listBack {
    margin: 0;
    color: var(--foreground-muted);
    line-height: 1.5;
  }

  .luma-flashcards__empty {
    background: var(--card);
    border: 1px dashed var(--border);
    border-radius: 16px;
    padding: 20px;
    color: var(--foreground-muted);
    line-height: 1.6;
  }

  @media (max-width: 880px) {
    .luma-flashcards__grid {
      grid-template-columns: 1fr;
    }
  }
`;

function buildPreview(value: string, maxLength = 96) {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength - 1)}...`;
}

function FlashcardsTool() {
  const { user } = useAuth();
  const [cards, setCards] = useState<Flashcard[]>([]);
  const [front, setFront] = useState("");
  const [back, setBack] = useState("");
  const [formError, setFormError] = useState("");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);
  const [loadingCards, setLoadingCards] = useState(true);
  const [savingCard, setSavingCard] = useState(false);
  const [deletingCardId, setDeletingCardId] = useState<string | null>(null);

  const currentCard = cards[currentIndex] ?? null;
  const isPremium = user?.subscription_status === "premium";
  const hasReachedFreeFlashcardLimit = !isPremium && cards.length >= FREE_FLASHCARD_LIMIT;

  useEffect(() => {
    if (!user) {
      return;
    }

    void fetchFlashcards();
  }, [user?.id]);

  useEffect(() => {
    if (cards.length === 0) {
      setCurrentIndex(0);
      setIsFlipped(false);
      return;
    }

    if (currentIndex > cards.length - 1) {
      setCurrentIndex(cards.length - 1);
      setIsFlipped(false);
    }
  }, [cards, currentIndex]);

  async function fetchFlashcards() {
    if (!user) {
      return;
    }

    if (!supabase) {
      setFormError(getSupabaseConfigError());
      setLoadingCards(false);
      return;
    }

    setLoadingCards(true);
    setFormError("");

    const { data, error } = await supabase
      .from("flashcards")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true });

    if (error) {
      setFormError(error.message || "Unable to load your flashcards right now.");
      setLoadingCards(false);
      return;
    }

    setCards(
      (data ?? []).map((row) => ({
        id: row.id as string,
        front: String(row.front ?? ""),
        back: String(row.back ?? ""),
        created_at:
          typeof row.created_at === "string" ? row.created_at : null,
      })),
    );
    setLoadingCards(false);
  }

  async function addFlashcard(nextFront: string, nextBack: string) {
    if (!user) {
      setFormError("Sign in to save flashcards.");
      return false;
    }

    if (!supabase) {
      setFormError(getSupabaseConfigError());
      return false;
    }

    setSavingCard(true);
    setFormError("");

    if (!isPremium) {
      const { data: existingCards, error: existingCardsError } = await supabase
        .from("flashcards")
        .select("id")
        .eq("user_id", user.id);

      if (existingCardsError) {
        setSavingCard(false);
        setFormError(
          existingCardsError.message ||
            "Unable to check your flashcard limit right now.",
        );
        return false;
      }

      if ((existingCards ?? []).length >= FREE_FLASHCARD_LIMIT) {
        await fetchFlashcards();
        setSavingCard(false);
        return false;
      }
    }

    const { error } = await supabase.from("flashcards").insert([
      {
        user_id: user.id,
        front: nextFront,
        back: nextBack,
      },
    ]);

    if (error) {
      setSavingCard(false);
      setFormError(error.message || "Unable to save your flashcard right now.");
      return false;
    }

    await fetchFlashcards();
    trackFeatureUsage("flashcards", {
      surface: "study_tool",
      subscriptionStatus: user?.subscription_status ?? null,
      metadata: {
        action: "create_card",
        result: "success",
      },
    });
    setSavingCard(false);
    return true;
  }

  async function deleteFlashcard(id: string) {
    if (!user) {
      setFormError("Sign in to manage flashcards.");
      return;
    }

    if (!supabase) {
      setFormError(getSupabaseConfigError());
      return;
    }

    setDeletingCardId(id);
    setFormError("");

    const { error } = await supabase
      .from("flashcards")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id);

    if (error) {
      setDeletingCardId(null);
      setFormError(
        error.message || "Unable to delete that flashcard right now.",
      );
      return;
    }

    await fetchFlashcards();
    trackFeatureUsage("flashcards", {
      surface: "study_tool",
      subscriptionStatus: user?.subscription_status ?? null,
      metadata: {
        action: "delete_card",
        result: "success",
      },
    });
    setDeletingCardId(null);
  }

  function handleAddCard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedFront = front.trim();
    const trimmedBack = back.trim();

    if (!trimmedFront || !trimmedBack) {
      setFormError("Add both a front prompt and a back answer before saving.");
      return;
    }

    void (async () => {
      const wasSaved = await addFlashcard(trimmedFront, trimmedBack);

      if (!wasSaved) {
        return;
      }

      setCurrentIndex(cards.length);
      setIsFlipped(false);
      setFront("");
      setBack("");
      setFormError("");
    })();
  }

  function selectCard(index: number) {
    setCurrentIndex(index);
    setIsFlipped(false);
  }

  function goToPreviousCard() {
    setCurrentIndex((current) => Math.max(0, current - 1));
    setIsFlipped(false);
  }

  function goToNextCard() {
    setCurrentIndex((current) => Math.min(cards.length - 1, current + 1));
    setIsFlipped(false);
  }

  return (
    <>
      <style>{flashcardStyles}</style>

      <main className="luma-flashcards">
        <div className="luma-flashcards__wrap">
          <section className="luma-flashcards__panel luma-flashcards__hero">
            <span className="luma-flashcards__eyebrow">Study Tools</span>
            <h1 className="luma-flashcards__title">Flashcards</h1>
            <p className="luma-flashcards__copy">
              Build a deck, flip through each prompt, and keep your flashcards
              synced with Supabase while the rest of the study suite takes shape.
            </p>
            <div className="luma-flashcards__meta">
              <span className="luma-flashcards__badge">
                {cards.length} {cards.length === 1 ? "card" : "cards"}
              </span>
              <span className="luma-flashcards__badge">Supabase synced</span>
            </div>
          </section>

          <div className="luma-flashcards__grid">
            <section className="luma-flashcards__panel luma-flashcards__section">
              <div>
                <h2 className="luma-flashcards__sectionTitle">Create card</h2>
                <p className="luma-flashcards__sectionCopy">
                  Add a new prompt and answer to your current deck.
                </p>
              </div>

              {hasReachedFreeFlashcardLimit ? (
                <LockedFeature
                  featureName="More flashcards"
                  title="Flashcard limit reached"
                  description="Free members can save up to 10 flashcards. Upgrade to Premium to keep building your deck."
                />
              ) : (
                <form className="luma-flashcards__form" onSubmit={handleAddCard}>
                  <label className="luma-flashcards__field">
                    <span className="luma-flashcards__label">Front</span>
                    <textarea
                      className="luma-flashcards__textarea"
                      value={front}
                      onChange={(event) => {
                        setFront(event.target.value);
                        setFormError("");
                      }}
                      placeholder="Write the prompt or question"
                    />
                  </label>

                  <label className="luma-flashcards__field">
                    <span className="luma-flashcards__label">Back</span>
                    <textarea
                      className="luma-flashcards__textarea"
                      value={back}
                      onChange={(event) => {
                        setBack(event.target.value);
                        setFormError("");
                      }}
                      placeholder="Write the answer or explanation"
                    />
                  </label>

                  {formError ? (
                    <p className="luma-flashcards__error" role="alert">
                      {formError}
                    </p>
                  ) : null}

                  <div className="luma-flashcards__actions">
                    <button
                      className="luma-flashcards__button"
                      type="submit"
                      disabled={savingCard || loadingCards}
                    >
                      {savingCard ? "Saving..." : "Add flashcard"}
                    </button>
                    <button
                      className="luma-flashcards__buttonSecondary"
                      type="button"
                      disabled={savingCard}
                      onClick={() => {
                        setFront("");
                        setBack("");
                        setFormError("");
                      }}
                    >
                      Clear form
                    </button>
                  </div>
                </form>
              )}
            </section>

            <section className="luma-flashcards__panel luma-flashcards__viewer">
              <div className="luma-flashcards__viewerTop">
                <div>
                  <h2 className="luma-flashcards__sectionTitle">Card viewer</h2>
                  <p className="luma-flashcards__sectionCopy">
                    Flip the card to reveal the answer, then move through your
                    deck at your own pace.
                  </p>
                </div>
                <p className="luma-flashcards__viewerHint">
                  Click the card to flip it
                </p>
              </div>

              {loadingCards ? (
                <div className="luma-flashcards__empty">
                  Loading your flashcards...
                </div>
              ) : currentCard ? (
                <>
                  <div className="luma-flashcards__perspective">
                    <button
                      className="luma-flashcards__cardButton"
                      type="button"
                      onClick={() => {
                        setIsFlipped((current) => !current);
                      }}
                    >
                      <div
                        className={`luma-flashcards__cardInner${
                          isFlipped ? " is-flipped" : ""
                        }`}
                      >
                        <article className="luma-flashcards__face">
                          <div style={{ display: "grid", gap: 12 }}>
                            <p className="luma-flashcards__faceLabel">Front</p>
                            <p className="luma-flashcards__faceText">
                              {currentCard.front}
                            </p>
                          </div>
                          <p className="luma-flashcards__faceFooter">
                            Tap to reveal the answer on the back.
                          </p>
                        </article>

                        <article className="luma-flashcards__face luma-flashcards__faceBack">
                          <div style={{ display: "grid", gap: 12 }}>
                            <p className="luma-flashcards__faceLabel">Back</p>
                            <p className="luma-flashcards__faceText">
                              {currentCard.back}
                            </p>
                          </div>
                          <p className="luma-flashcards__faceFooter">
                            Tap again to return to the prompt.
                          </p>
                        </article>
                      </div>
                    </button>
                  </div>

                  <div className="luma-flashcards__nav">
                    <button
                      className="luma-flashcards__buttonSecondary"
                      type="button"
                      onClick={goToPreviousCard}
                      disabled={currentIndex === 0}
                    >
                      Previous
                    </button>
                    <p className="luma-flashcards__index">
                      Card {currentIndex + 1} of {cards.length}
                    </p>
                    <button
                      className="luma-flashcards__buttonSecondary"
                      type="button"
                      onClick={goToNextCard}
                      disabled={currentIndex === cards.length - 1}
                    >
                      Next
                    </button>
                  </div>
                </>
              ) : (
                <div className="luma-flashcards__empty">
                  No flashcards saved yet. Add your first card to start studying.
                </div>
              )}
            </section>
          </div>

          <section className="luma-flashcards__panel luma-flashcards__section">
            <div>
              <h2 className="luma-flashcards__sectionTitle">Your deck</h2>
              <p className="luma-flashcards__sectionCopy">
                Jump to any card in the set and keep your review flow organized.
              </p>
            </div>

            <div className="luma-flashcards__list">
              {loadingCards ? (
                <div className="luma-flashcards__empty">Loading deck...</div>
              ) : cards.length === 0 ? (
                <div className="luma-flashcards__empty">
                  Your flashcard deck is empty. Saved cards will show up here
                  once you add them.
                </div>
              ) : (
                cards.map((card, index) => (
                  <div
                    key={card.id}
                    className={`luma-flashcards__listItem${
                      index === currentIndex ? " is-active" : ""
                    }`}
                  >
                    <button
                      type="button"
                      style={{
                        border: "none",
                        background: "transparent",
                        padding: 0,
                        textAlign: "left",
                        cursor: "pointer",
                        display: "grid",
                        gap: 8,
                      }}
                      onClick={() => {
                        selectCard(index);
                      }}
                    >
                      <p className="luma-flashcards__listLabel">
                        Card {index + 1}
                      </p>
                      <p className="luma-flashcards__listFront">
                        <strong style={{ color: "var(--foreground)" }}>Front:</strong>{" "}
                        {buildPreview(card.front)}
                      </p>
                      <p className="luma-flashcards__listBack">
                        <strong style={{ color: "var(--foreground)" }}>Back:</strong>{" "}
                        {buildPreview(card.back)}
                      </p>
                    </button>

                    <button
                      className="luma-flashcards__buttonSecondary"
                      type="button"
                      disabled={deletingCardId === card.id}
                      onClick={() => {
                        void deleteFlashcard(card.id);
                      }}
                    >
                      {deletingCardId === card.id ? "Deleting..." : "Delete"}
                    </button>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </main>
    </>
  );
}

export default function Flashcards() {
  return <FlashcardsTool />;
}
