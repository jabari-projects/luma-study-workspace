import { useEffect, useState } from "react";
import LockedFeature from "../../components/LockedFeature";
import { useAuth } from "../../context/AuthContext";
import { getSupabaseConfigError, supabase } from "../../api/supabase";
import {
  normalizePersonaDefinition,
  type PersonaDefinition,
} from "./personaTypes";

const personaSelectorStyles = `
  .luma-personas {
    display: grid;
    gap: 12px;
  }

  .luma-personas__header {
    display: grid;
    gap: 8px;
  }

  .luma-personas__title {
    margin: 0;
    color: var(--foreground);
    font-size: 24px;
  }

  .luma-personas__copy {
    margin: 0;
    color: var(--foreground-muted);
    line-height: 1.6;
  }

  .luma-personas__error {
    margin: 0;
    border-radius: 16px;
    border: 1px solid rgba(226, 120, 145, 0.28);
    background: rgba(226, 120, 145, 0.12);
    color: #b63d61;
    padding: 16px;
    line-height: 1.5;
  }

  .luma-personas__grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 12px;
  }

  .luma-personas__card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 20px;
    box-shadow: var(--shadow);
    display: grid;
    gap: 12px;
  }

  .luma-personas__card.is-active {
    border-color: rgba(140, 111, 255, 0.36);
    background: rgba(181, 155, 255, 0.08);
  }

  .luma-personas__cardTop {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .luma-personas__avatar {
    width: 56px;
    height: 56px;
    border-radius: 16px;
    overflow: hidden;
    display: grid;
    place-items: center;
    background: rgba(181, 155, 255, 0.14);
    color: var(--accent-strong);
    font-size: 20px;
    font-weight: 800;
    border: 1px solid var(--border);
    flex-shrink: 0;
  }

  .luma-personas__avatarImage {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .luma-personas__meta {
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  .luma-personas__name {
    margin: 0;
    color: var(--foreground);
    font-size: 18px;
    line-height: 1.2;
  }

  .luma-personas__voice {
    margin: 0;
    color: var(--foreground-muted);
    font-size: 14px;
  }

  .luma-personas__prompt {
    margin: 0;
    color: var(--foreground-muted);
    line-height: 1.6;
  }

  .luma-personas__button {
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

  .luma-personas__button:disabled {
    cursor: not-allowed;
    opacity: 0.68;
  }
`;

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

function PersonaAvatar({ persona }: { persona: PersonaDefinition }) {
  const [imageFailed, setImageFailed] = useState(false);

  return (
    <div className="luma-personas__avatar" aria-hidden="true">
      {persona.avatar_url && !imageFailed ? (
        <img
          className="luma-personas__avatarImage"
          src={persona.avatar_url}
          alt=""
          onError={() => {
            setImageFailed(true);
          }}
        />
      ) : (
        getInitials(persona.name)
      )}
    </div>
  );
}

export default function PersonaSelector() {
  const { refreshUser, user } = useAuth();
  const currentUser = user;
  const [personas, setPersonas] = useState<PersonaDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingPersonaId, setSavingPersonaId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function loadPersonas() {
      if (!currentUser || currentUser.subscription_status !== "premium") {
        if (!cancelled) {
          setPersonas([]);
          setLoading(false);
        }
        return;
      }

      if (!supabase) {
        if (!cancelled) {
          setError(getSupabaseConfigError());
          setLoading(false);
        }
        return;
      }

      setLoading(true);
      setError("");

      const { data, error: fetchError } = await supabase
        .from("personas")
        .select("id, name, avatar_url, system_prompt, voice_id, created_at")
        .order("created_at", { ascending: false });

      if (cancelled) {
        return;
      }

      if (fetchError) {
        setError(fetchError.message || "Unable to load personas right now.");
        setPersonas([]);
        setLoading(false);
        return;
      }

      setPersonas(
        (data ?? [])
          .map((persona) => normalizePersonaDefinition(persona))
          .filter((persona): persona is PersonaDefinition => Boolean(persona)),
      );
      setLoading(false);
    }

    void loadPersonas();

    return () => {
      cancelled = true;
    };
  }, [currentUser?.id, currentUser?.subscription_status]);

  if (!currentUser) {
    return null;
  }

  if (currentUser.subscription_status !== "premium") {
    return (
      <LockedFeature
        featureName="Premium personas"
        title="Premium personas"
        description="Upgrade to Premium to unlock chatbot personas like LeBron and future custom voices."
      />
    );
  }

  async function handleSelectPersona(personaId: string) {
    if (!currentUser) {
      return;
    }

    if (!supabase) {
      setError(getSupabaseConfigError());
      return;
    }

    setSavingPersonaId(personaId);
    setError("");

    const { error: updateError } = await supabase
      .from("profiles")
      .update({ persona_id: personaId })
      .eq("user_id", currentUser.id);

    if (updateError) {
      setError(updateError.message || "Unable to save your persona right now.");
      setSavingPersonaId(null);
      return;
    }

    await refreshUser();
    setSavingPersonaId(null);
  }

  return (
    <>
      <style>{personaSelectorStyles}</style>

      <section className="luma-personas">
        <header className="luma-personas__header">
          <h2 className="luma-personas__title">Choose your chatbot persona</h2>
          <p className="luma-personas__copy">
            Premium members can swap the standard assistant for a guided persona
            voice. Your selection is saved to your Luma profile.
          </p>
        </header>

        {error ? (
          <p className="luma-personas__error" role="alert">
            {error}
          </p>
        ) : null}

        {loading ? (
          <div className="luma-personas__card">
            <p className="luma-personas__prompt">Loading personas...</p>
          </div>
        ) : personas.length === 0 ? (
          <div className="luma-personas__card">
            <p className="luma-personas__prompt">
              No personas are available yet. Add one from the admin persona
              manager.
            </p>
          </div>
        ) : (
          <div className="luma-personas__grid">
            {personas.map((persona) => {
              const isActive = currentUser.persona_id === persona.id;
              const isSaving = savingPersonaId === persona.id;

              return (
                <article
                  key={persona.id}
                  className={`luma-personas__card${isActive ? " is-active" : ""}`}
                >
                  <div className="luma-personas__cardTop">
                    <PersonaAvatar persona={persona} />
                    <div className="luma-personas__meta">
                      <h3 className="luma-personas__name">{persona.name}</h3>
                      <p className="luma-personas__voice">
                        Voice: {persona.voice_id}
                      </p>
                    </div>
                  </div>

                  <p className="luma-personas__prompt">{persona.system_prompt}</p>

                  <button
                    className="luma-personas__button"
                    type="button"
                    disabled={isActive || Boolean(savingPersonaId)}
                    onClick={() => {
                      void handleSelectPersona(persona.id);
                    }}
                  >
                    {isActive
                      ? "Selected"
                      : isSaving
                        ? "Saving..."
                        : "Choose persona"}
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
