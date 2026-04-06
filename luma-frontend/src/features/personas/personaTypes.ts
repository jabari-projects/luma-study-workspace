export type PersonaDefinition = {
  id: string;
  name: string;
  avatar_url: string | null;
  system_prompt: string;
  voice_id: string;
  created_at?: string | null;
};

export function normalizePersonaDefinition(
  value: unknown,
): PersonaDefinition | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;

  if (
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.system_prompt !== "string" ||
    typeof candidate.voice_id !== "string"
  ) {
    return null;
  }

  if (
    candidate.avatar_url !== undefined &&
    candidate.avatar_url !== null &&
    typeof candidate.avatar_url !== "string"
  ) {
    return null;
  }

  if (
    candidate.created_at !== undefined &&
    candidate.created_at !== null &&
    typeof candidate.created_at !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    name: candidate.name,
    avatar_url:
      typeof candidate.avatar_url === "string" && candidate.avatar_url.trim()
        ? candidate.avatar_url
        : null,
    system_prompt: candidate.system_prompt,
    voice_id: candidate.voice_id,
    created_at:
      typeof candidate.created_at === "string" ? candidate.created_at : null,
  };
}
