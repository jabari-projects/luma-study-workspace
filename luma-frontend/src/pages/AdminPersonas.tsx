import { useEffect, useMemo, useState, type FormEvent } from "react";
import { getSupabaseConfigError, supabase } from "../api/supabase";
import { useAuth } from "../context/AuthContext";
import { personaVoiceOptions } from "../features/chatbot/VoiceEngine";

type PersonaRecord = {
  id: string;
  name: string;
  avatar_url: string;
  system_prompt: string;
  voice_id: string;
  created_at: string;
};

function formatCreatedAt(value: string) {
  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    return "Recently added";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestamp));
}

export default function AdminPersonasPage() {
  const { user } = useAuth();
  const [personas, setPersonas] = useState<PersonaRecord[]>([]);
  const [name, setName] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [voiceId, setVoiceId] = useState("neutral");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const previewUrl = useMemo(() => {
    if (!avatarFile) {
      return "";
    }

    return URL.createObjectURL(avatarFile);
  }, [avatarFile]);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  async function fetchPersonas() {
    if (!supabase) {
      setPersonas([]);
      setLoading(false);
      setError(getSupabaseConfigError());
      return;
    }

    setLoading(true);

    try {
      const { data, error: selectError } = await supabase
        .from("personas")
        .select("id, name, avatar_url, system_prompt, voice_id, created_at")
        .order("created_at", { ascending: false });

      if (selectError) {
        throw selectError;
      }

      setPersonas((data ?? []) as PersonaRecord[]);
      setError(null);
    } catch (fetchError) {
      const message =
        fetchError instanceof Error
          ? fetchError.message
          : "Unable to load personas right now.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchPersonas();
  }, []);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!supabase) {
      setError(getSupabaseConfigError());
      return;
    }

    if (!user) {
      setError("You must be signed in to manage personas.");
      return;
    }

    if (!avatarFile) {
      setError("Upload an avatar image before saving.");
      return;
    }

    const trimmedName = name.trim();
    const trimmedPrompt = systemPrompt.trim();
    const trimmedVoiceId = voiceId.trim();

    if (!trimmedName || !trimmedPrompt || !trimmedVoiceId) {
      setError("Complete the persona name, system prompt, and voice ID.");
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(null);

    const safeName = avatarFile.name.replace(/[^a-zA-Z0-9._-]+/g, "-");
    const uploadPath = `${user.id}/${Date.now()}-${safeName}`;

    try {
      const { error: uploadError } = await supabase.storage
        .from("personas")
        .upload(uploadPath, avatarFile, {
          cacheControl: "3600",
          upsert: false,
        });

      if (uploadError) {
        throw uploadError;
      }

      const { data: publicUrlData } = supabase.storage
        .from("personas")
        .getPublicUrl(uploadPath);

      const avatarUrl = publicUrlData.publicUrl;

      const { error: insertError } = await supabase.from("personas").insert([
        {
          name: trimmedName,
          avatar_url: avatarUrl,
          system_prompt: trimmedPrompt,
          voice_id: trimmedVoiceId,
        },
      ]);

      if (insertError) {
        await supabase.storage.from("personas").remove([uploadPath]);
        throw insertError;
      }

      setName("");
      setSystemPrompt("");
      setVoiceId("neutral");
      setAvatarFile(null);
      setSuccess("Persona saved successfully.");
      await fetchPersonas();
    } catch (saveError) {
      const message =
        saveError instanceof Error
          ? saveError.message
          : "Unable to save the persona right now.";
      setError(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main
      style={{
        minHeight: "calc(100vh - 96px)",
        padding: "32px 20px 56px",
      }}
    >
      <div
        style={{
          maxWidth: 1120,
          margin: "0 auto",
          display: "grid",
          gap: 24,
        }}
      >
        <section
          style={{
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            boxShadow: "var(--shadow)",
            padding: 20,
            display: "grid",
            gap: 12,
          }}
        >
          <span
            style={{
              display: "inline-flex",
              width: "fit-content",
              padding: "6px 12px",
              borderRadius: 999,
              background: "rgba(181, 155, 255, 0.16)",
              color: "var(--accent)",
              fontSize: 12,
              fontWeight: 800,
              letterSpacing: "0.03em",
              textTransform: "uppercase",
            }}
          >
            Admin Personas
          </span>

          <div style={{ display: "grid", gap: 8 }}>
            <h1
              style={{
                margin: 0,
                fontSize: "clamp(2rem, 4vw, 3rem)",
                letterSpacing: "-0.04em",
                color: "var(--foreground)",
              }}
            >
              Create and publish chatbot personas.
            </h1>
            <p
              style={{
                margin: 0,
                maxWidth: 720,
                color: "var(--foreground-muted)",
                lineHeight: 1.7,
              }}
            >
              Upload an avatar, define the prompt, and save a new persona to
              Supabase so the premium chatbot system can use it.
            </p>
          </div>
        </section>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: 24,
          }}
        >
          <section
            style={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: 16,
              boxShadow: "var(--shadow)",
              padding: 20,
              display: "grid",
              gap: 16,
            }}
          >
            <div style={{ display: "grid", gap: 8 }}>
              <h2
                style={{
                  margin: 0,
                  color: "var(--foreground)",
                  fontSize: 22,
                }}
              >
                New persona
              </h2>
              <p
                style={{
                  margin: 0,
                  color: "var(--foreground-muted)",
                  lineHeight: 1.6,
                }}
              >
                Save a new chatbot persona with a hosted avatar and a reusable
                system prompt.
              </p>
            </div>

            <form
              onSubmit={(event) => {
                void handleSave(event);
              }}
              style={{ display: "grid", gap: 16 }}
            >
              <label style={{ display: "grid", gap: 8 }}>
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: "var(--foreground)",
                  }}
                >
                  Persona avatar
                </span>
                <div
                  style={{
                    borderRadius: 16,
                    border: "1px dashed var(--border)",
                    background: "rgba(181, 155, 255, 0.08)",
                    padding: 16,
                    display: "grid",
                    gap: 12,
                    justifyItems: "start",
                  }}
                >
                  {previewUrl ? (
                    <img
                      src={previewUrl}
                      alt="Persona avatar preview"
                      loading="lazy"
                      decoding="async"
                      style={{
                        width: 72,
                        height: 72,
                        borderRadius: "50%",
                        objectFit: "cover",
                        border: "1px solid var(--border)",
                        background: "var(--background)",
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        width: 72,
                        height: 72,
                        borderRadius: "50%",
                        border: "1px solid var(--border)",
                        display: "grid",
                        placeItems: "center",
                        color: "var(--foreground-muted)",
                        background: "var(--background)",
                        fontSize: 13,
                        textAlign: "center",
                        padding: 12,
                      }}
                    >
                      Avatar preview
                    </div>
                  )}

                  <input
                    type="file"
                    accept="image/*"
                    onChange={(event) => {
                      setAvatarFile(event.target.files?.[0] ?? null);
                    }}
                    style={{ color: "var(--foreground)" }}
                  />
                </div>
              </label>

              <label style={{ display: "grid", gap: 8 }}>
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: "var(--foreground)",
                  }}
                >
                  Persona name
                </span>
                <input
                  type="text"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                  placeholder="LeBron James"
                  style={{
                    minHeight: 48,
                    padding: "0 16px",
                    borderRadius: 16,
                    border: "1px solid var(--border)",
                    background: "var(--background)",
                    color: "var(--foreground)",
                  }}
                />
              </label>

              <label style={{ display: "grid", gap: 8 }}>
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: "var(--foreground)",
                  }}
                >
                  System prompt
                </span>
                <textarea
                  value={systemPrompt}
                  onChange={(event) => {
                    setSystemPrompt(event.target.value);
                  }}
                  rows={8}
                  placeholder="You are..."
                  style={{
                    width: "100%",
                    resize: "vertical",
                    padding: 16,
                    borderRadius: 16,
                    border: "1px solid var(--border)",
                    background: "var(--background)",
                    color: "var(--foreground)",
                    lineHeight: 1.6,
                    fontFamily: "inherit",
                  }}
                />
              </label>

              <label style={{ display: "grid", gap: 8 }}>
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: "var(--foreground)",
                  }}
                >
                  Voice ID
                </span>
                <select
                  value={voiceId}
                  onChange={(event) => {
                    setVoiceId(event.target.value);
                  }}
                  style={{
                    minHeight: 48,
                    padding: "0 16px",
                    borderRadius: 16,
                    border: "1px solid var(--border)",
                    background: "var(--background)",
                    color: "var(--foreground)",
                  }}
                >
                  {personaVoiceOptions.map((voiceOption) => (
                    <option key={voiceOption.id} value={voiceOption.id}>
                      {voiceOption.label}
                    </option>
                  ))}
                </select>
              </label>

              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 12,
                  alignItems: "center",
                }}
              >
                <button
                  type="submit"
                  disabled={saving}
                  style={{
                    minHeight: 48,
                    padding: "0 18px",
                    borderRadius: 16,
                    border: "1px solid transparent",
                    background:
                      "linear-gradient(135deg, var(--accent-strong), var(--accent))",
                    color: "#ffffff",
                    fontWeight: 800,
                    cursor: saving ? "default" : "pointer",
                    opacity: saving ? 0.72 : 1,
                    boxShadow: "var(--shadow)",
                  }}
                >
                  {saving ? "Saving persona..." : "Save persona"}
                </button>

                {success ? (
                  <span
                    style={{
                      color: "var(--accent-strong)",
                      fontWeight: 700,
                    }}
                  >
                    {success}
                  </span>
                ) : null}
              </div>

              {error ? (
                <p
                  style={{
                    margin: 0,
                    borderRadius: 16,
                    border: "1px solid rgba(220, 82, 120, 0.24)",
                    background: "rgba(220, 82, 120, 0.1)",
                    color: "var(--foreground)",
                    padding: 16,
                    lineHeight: 1.6,
                  }}
                >
                  {error}
                </p>
              ) : null}
            </form>
          </section>

          <section
            style={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: 16,
              boxShadow: "var(--shadow)",
              padding: 20,
              display: "grid",
              gap: 16,
              alignContent: "start",
            }}
          >
            <div style={{ display: "grid", gap: 8 }}>
              <h2
                style={{
                  margin: 0,
                  color: "var(--foreground)",
                  fontSize: 22,
                }}
              >
                Existing personas
              </h2>
              <p
                style={{
                  margin: 0,
                  color: "var(--foreground-muted)",
                  lineHeight: 1.6,
                }}
              >
                Review the personas currently available in the database.
              </p>
            </div>

            {loading ? (
              <div
                style={{
                  borderRadius: 16,
                  border: "1px solid var(--border)",
                  background: "var(--background)",
                  padding: 16,
                  color: "var(--foreground-muted)",
                }}
              >
                Loading personas...
              </div>
            ) : personas.length === 0 ? (
              <div
                style={{
                  borderRadius: 16,
                  border: "1px solid var(--border)",
                  background: "var(--background)",
                  padding: 16,
                  color: "var(--foreground-muted)",
                  lineHeight: 1.6,
                }}
              >
                No personas have been saved yet.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 12 }}>
                {personas.map((persona) => (
                  <article
                    key={persona.id}
                    style={{
                      borderRadius: 16,
                      border: "1px solid var(--border)",
                      background: "var(--background)",
                      padding: 16,
                      display: "grid",
                      gap: 12,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        gap: 12,
                        alignItems: "center",
                      }}
                    >
                      <img
                        src={persona.avatar_url}
                        alt={persona.name}
                        loading="lazy"
                        decoding="async"
                        style={{
                          width: 52,
                          height: 52,
                          borderRadius: "50%",
                          objectFit: "cover",
                          border: "1px solid var(--border)",
                          background: "var(--card)",
                        }}
                      />
                      <div style={{ display: "grid", gap: 4 }}>
                        <strong
                          style={{
                            color: "var(--foreground)",
                            fontSize: 15,
                          }}
                        >
                          {persona.name}
                        </strong>
                        <span
                          style={{
                            color: "var(--foreground-muted)",
                            fontSize: 13,
                          }}
                        >
                          Voice: {persona.voice_id}
                        </span>
                      </div>
                    </div>

                    <p
                      style={{
                        margin: 0,
                        color: "var(--foreground-muted)",
                        lineHeight: 1.7,
                        fontSize: 14,
                      }}
                    >
                      {persona.system_prompt}
                    </p>

                    <span
                      style={{
                        color: "var(--foreground-muted)",
                        fontSize: 12,
                      }}
                    >
                      Added {formatCreatedAt(persona.created_at)}
                    </span>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
