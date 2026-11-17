import { api, getTabAccountId } from "../api"
import { useAuth, useProfile } from "../auth"
import type { StudyType } from "./common"

// Sharing helpers (no components here, so fast refresh keeps working in Share.tsx).
// Owner rules: shared items are seen only by students signed in to Luma, with the
// username and nothing else about the person. "Shared" is the word, never "Public".

export type ShareableItem = {
  id: string
  is_public?: boolean | null
  title?: unknown
}

/**
 * The words for the share box, so a deck says "deck" and a note says "note".
 * `username` is null until the profile loads: then the box says "your username" and
 * adds the name once it is known, so it never shows a made-up one.
 */
export function shareCopy(noun: string, username: string | null) {
  const who = username ? `your username, @${username}` : "your username"
  return {
    title: `Share this ${noun}?`,
    body: `Students signed in to Luma will be able to find it. They see the ${noun} and ${who}. Nothing else about you. You can stop sharing anytime.`,
    shared: `Shared. Students signed in to Luma can find this ${noun} now.`,
    stopped: `You stopped sharing. Only you can see this ${noun} now.`,
    needsTitle: `Give this ${noun} a title before you share it.`,
  }
}

/** The username shown on shared items (the server sets it again), or null while it is not known yet. */
export function useShareName(): string | null {
  const profile = useProfile()
  const { user } = useAuth()
  return profile?.username || user?.username || null
}

/** "Shared by @name" on the owner's own page, the same @username other students see. */
export function sharedLine(username: string | null): string {
  return username ? `Shared by @${username}` : "Shared"
}

export function hasTitle(item: ShareableItem): boolean {
  return typeof item.title === "string" && item.title.trim().length > 0
}

/** Turn sharing on or off. The server sets who shared it and when; these fields are only hints. */
export async function setSharing<T>(
  endpoint: string,
  item: ShareableItem,
  share: boolean,
  studyType: StudyType,
  username: string | null,
): Promise<T> {
  // published_by is only a hint: the server always writes the owner's real username.
  const body = share
    ? { is_public: true, published_at: new Date().toISOString(), ...(username ? { published_by: username } : {}), study_type: studyType }
    : { is_public: false, published_at: null, published_by: null }
  // Change it in the account that showed this item, even if the tab switches meanwhile.
  const response = await api.put<T>(`${endpoint}/${item.id}`, body, { lumaAccountId: getTabAccountId() ?? undefined })
  return response.data
}
