// Which server words a student may see. On a 5xx answer only the plain messages written for
// students get through; setup details like "Stripe is not configured" never do.
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { shownServerText } from "./serverText.ts"

describe("shownServerText", () => {
  it("hides server setup details on a 500", () => {
    assert.equal(shownServerText(500, "Stripe is not configured"), undefined)
    assert.equal(shownServerText(500, "Failed to create note"), undefined)
    assert.equal(shownServerText(503, "The database service is unavailable because Supabase is not configured."), undefined)
  })

  it("shows the plain messages the server writes for students on a 5xx", () => {
    assert.equal(
      shownServerText(503, "Making notes is not working right now. Try again later."),
      "Making notes is not working right now. Try again later.",
    )
    assert.equal(
      shownServerText(500, "We couldn't make a summary this time. Try again."),
      "We couldn't make a summary this time. Try again.",
    )
  })

  it("shows the server's words on other answers, like a wrong password", () => {
    assert.equal(shownServerText(401, "That email or password is wrong."), "That email or password is wrong.")
    assert.equal(shownServerText(429, "Too many tries. Wait a few minutes and try again."), "Too many tries. Wait a few minutes and try again.")
  })

  it("gives nothing when there are no words", () => {
    assert.equal(shownServerText(400, undefined), undefined)
    assert.equal(shownServerText(500, ""), undefined)
  })
})
