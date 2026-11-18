/**
 * When something breaks on the server (status 500 and up), its words can name the tools behind
 * Luma or how they are set up, like "Stripe is not configured". Students only see the plain
 * messages below, which the server writes for them; anything else gets the page's own message.
 * When the server gets a new message for students on a 5xx answer, add it here.
 */
const FRIENDLY_SERVER_PROBLEMS = new Set([
  // Signing in
  "Sign-in is unavailable right now. Try again later.",
  "Sign-in check is unavailable right now. Try again later.",
  "We couldn't send the email right now. Try again later.",
  // Making notes and summaries
  "Making notes is not working right now. Try again later.",
  "We couldn't make notes this time. Try again.",
  "Making a summary is not working right now. Try again later.",
  "We couldn't make a summary this time. Try again.",
  "Talk-to-text is not working right now. Try again later.",
  "We couldn't turn that into words. Try again.",
  "We couldn't open that link.",
  "File storage is temporarily unavailable.",
  // Deleting an account
  "We couldn't finish deleting your account. Some of your data may already be removed, and your account is still active so you can try again. If it keeps happening, contact support.",
  "We need to finish canceling your subscription by hand. Please contact support; your account is safe.",
])

/** The server's words if a student may see them, or undefined to use the page's own message. */
export function shownServerText(status: number, text: string | undefined): string | undefined {
  if (!text) {
    return undefined
  }
  if (status < 500 || FRIENDLY_SERVER_PROBLEMS.has(text)) {
    return text
  }
  return undefined
}
