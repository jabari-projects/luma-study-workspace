export function getUsernameAvatarLetter(username: string | null | undefined) {
  const normalized = (username ?? "").trim();
  return normalized.charAt(0).toUpperCase() || "L";
}
