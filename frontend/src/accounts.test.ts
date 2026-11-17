import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  AccountLimitError,
  MAX_ACCOUNTS,
  canAdd,
  chatbotAccountId,
  classifyUnauthorized,
  emptyBook,
  findByEmail,
  markExpired,
  orderedAccounts,
  parseBook,
  pickActive,
  remove,
  resolveRequestAuth,
  updateUser,
  upsertSignedIn,
} from "./accounts.ts"
import type { AccountBook } from "./accounts.ts"

const userA = { id: "a", email: "a@luma.test", username: "ana" }
const userB = { id: "b", email: "b@luma.test", username: "ben" }
const userC = { id: "c", email: "c@luma.test", username: "cal" }
const userD = { id: "d", email: "d@luma.test", username: "dee" }

function threeAccounts(): AccountBook {
  let book = emptyBook()
  book = upsertSignedIn(book, { accessToken: "ta", user: userA }, 100)
  book = upsertSignedIn(book, { accessToken: "tb", user: userB }, 200)
  book = upsertSignedIn(book, { accessToken: "tc", user: userC }, 300)
  return book
}

describe("parseBook", () => {
  it("gives an empty book for null", () => {
    const result = parseBook(null)
    assert.deepEqual(result.book, emptyBook())
    assert.equal(result.corrupt, false)
    assert.equal(result.migratedFromV1, null)
  })

  it("flags broken JSON as corrupt", () => {
    const result = parseBook("{not json")
    assert.equal(result.corrupt, true)
    assert.deepEqual(result.book, emptyBook())
  })

  it("upgrades a version 1 session and makes it first in line", () => {
    const result = parseBook(JSON.stringify({ accessToken: "old", user: userA }))
    assert.equal(result.migratedFromV1, "a")
    assert.equal(result.book.v, 2)
    assert.equal(result.book.lastActiveId, "a")
    assert.deepEqual(result.book.accounts.a, { accessToken: "old", user: userA, signedInAt: 0, status: "signed_in" })
    assert.equal(chatbotAccountId(result.book), "a")
  })

  it("drops invalid version 2 entries", () => {
    const raw = JSON.stringify({
      v: 2,
      accounts: {
        a: { accessToken: "ta", user: userA, signedInAt: 1, status: "signed_in" },
        b: { accessToken: "tb", user: { email: "x" }, signedInAt: 2, status: "signed_in" },
        c: { accessToken: "", user: userC, signedInAt: 3, status: "signed_in" },
      },
      lastActiveId: "b",
    })
    const { book, corrupt } = parseBook(raw)
    assert.equal(corrupt, false)
    assert.deepEqual(Object.keys(book.accounts), ["a"])
    assert.equal(book.lastActiveId, null)
  })

  it("drops an expired entry that still has a token", () => {
    const raw = JSON.stringify({
      v: 2,
      accounts: {
        a: { accessToken: "ta", user: userA, signedInAt: 1, status: "expired" },
        b: { accessToken: null, user: userB, signedInAt: 2, status: "expired" },
      },
      lastActiveId: "b",
    })
    const { book } = parseBook(raw)
    assert.deepEqual(Object.keys(book.accounts), ["b"])
    assert.equal(book.lastActiveId, "b")
  })

  it("keeps only the 3 oldest accounts", () => {
    const users = [userD, userC, userB, userA]
    const accounts = Object.fromEntries(
      users.map((user, index) => [user.id, { accessToken: `t${user.id}`, user, signedInAt: index + 1, status: "signed_in" }]),
    )
    const { book } = parseBook(JSON.stringify({ v: 2, accounts, lastActiveId: "a" }))
    assert.equal(Object.keys(book.accounts).length, MAX_ACCOUNTS)
    assert.deepEqual(orderedAccounts(book).map((account) => account.id), ["d", "c", "b"])
    assert.equal(book.lastActiveId, null)
  })
})

describe("upsertSignedIn", () => {
  it("gives a new account the current time", () => {
    const book = upsertSignedIn(emptyBook(), { accessToken: "ta", user: userA }, 500)
    assert.equal(book.accounts.a.signedInAt, 500)
    assert.equal(book.accounts.a.status, "signed_in")
  })

  it("keeps signedInAt when an expired account signs in again", () => {
    let book = threeAccounts()
    book = markExpired(book, "a", "ta")
    assert.equal(book.accounts.a.status, "expired")
    book = upsertSignedIn(book, { accessToken: "ta2", user: userA }, 9999)
    assert.equal(book.accounts.a.signedInAt, 100)
    assert.equal(book.accounts.a.status, "signed_in")
    assert.equal(book.accounts.a.accessToken, "ta2")
  })

  it("refuses a 4th account and leaves the book alone", () => {
    const book = threeAccounts()
    const before = JSON.stringify(book)
    assert.throws(() => upsertSignedIn(book, { accessToken: "td", user: userD }, 400), AccountLimitError)
    assert.equal(JSON.stringify(book), before)
  })

  it("keeps sign-in order strict when the clock repeats", () => {
    let book = upsertSignedIn(emptyBook(), { accessToken: "tb", user: userB }, 100)
    book = upsertSignedIn(book, { accessToken: "ta", user: userA }, 100)
    assert.deepEqual(orderedAccounts(book).map((account) => account.id), ["b", "a"])
  })
})

describe("chatbotAccountId", () => {
  it("follows the owner's rules", () => {
    let book = threeAccounts()
    assert.equal(chatbotAccountId(book), "a")

    book = remove(book, "b")
    assert.equal(chatbotAccountId(book), "a")

    book = markExpired(book, "a", "ta")
    assert.equal(chatbotAccountId(book), "a")

    book = remove(book, "a")
    assert.equal(chatbotAccountId(book), "c")
  })

  it("moves to the next-oldest account after sign-out, and a returning account goes last", () => {
    let book = threeAccounts()
    book = remove(book, "a")
    assert.equal(chatbotAccountId(book), "b")
    book = upsertSignedIn(book, { accessToken: "ta2", user: userA }, 50)
    assert.equal(chatbotAccountId(book), "b")
    assert.equal(orderedAccounts(book).at(-1)?.id, "a")
  })

  it("is null with no accounts", () => {
    assert.equal(chatbotAccountId(emptyBook()), null)
  })
})

describe("markExpired", () => {
  it("ignores a different token", () => {
    const book = threeAccounts()
    assert.equal(markExpired(book, "a", "old-token"), book)
  })

  it("expires the account when the token matches", () => {
    const book = markExpired(threeAccounts(), "b", "tb")
    assert.equal(book.accounts.b.status, "expired")
    assert.equal(book.accounts.b.accessToken, null)
    assert.equal(book.accounts.a.status, "signed_in")
  })
})

describe("updateUser", () => {
  it("does nothing for a missing id, a wrong id or a changed token", () => {
    const book = threeAccounts()
    assert.equal(updateUser(book, "z", { ...userA, id: "z" }), book)
    assert.equal(updateUser(book, "a", { ...userB }), book)
    assert.equal(updateUser(book, "a", { ...userA, username: "new" }, "stale"), book)
  })

  it("saves the new details", () => {
    const book = updateUser(threeAccounts(), "a", { ...userA, username: "new" }, "ta")
    assert.equal(book.accounts.a.user.username, "new")
    assert.equal(book.accounts.a.accessToken, "ta")
  })
})

describe("remove", () => {
  it("moves lastActiveId to the oldest left, or null", () => {
    let book: AccountBook = { ...threeAccounts(), lastActiveId: "b" }
    book = remove(book, "b")
    assert.equal(book.lastActiveId, "a")
    book = remove(remove(book, "a"), "c")
    assert.equal(book.lastActiveId, null)
    assert.deepEqual(book.accounts, {})
  })
})

describe("pickActive", () => {
  it("keeps the tab's own account", () => {
    const book = { ...threeAccounts(), lastActiveId: "c" }
    assert.deepEqual(pickActive(book, "b", true), { id: "b", lostBinding: false })
  })

  it("reports a lost binding without picking someone else", () => {
    const book = remove(threeAccounts(), "b")
    assert.deepEqual(pickActive(book, "b", true), { id: null, lostBinding: true })
  })

  it("uses lastActiveId, then the oldest signed-in account, for a fresh tab", () => {
    const book = { ...threeAccounts(), lastActiveId: "c" }
    assert.deepEqual(pickActive(book, null, false), { id: "c", lostBinding: false })
    const noLast = markExpired({ ...threeAccounts(), lastActiveId: null }, "a", "ta")
    assert.deepEqual(pickActive(noLast, null, false), { id: "b", lostBinding: false })
    assert.deepEqual(pickActive(emptyBook(), null, false), { id: null, lostBinding: false })
  })
})

describe("resolveRequestAuth", () => {
  const book = markExpired(threeAccounts(), "c", "tc")

  it("sends no token when asked", () => {
    assert.deepEqual(resolveRequestAuth(book, "a", { lumaAuth: "none" }), { kind: "none" })
  })

  it("lets a pinned account beat the tab account", () => {
    assert.deepEqual(resolveRequestAuth(book, "a", { lumaAccountId: "b" }), { kind: "bearer", id: "b", token: "tb" })
  })

  it("sends no token when nobody is bound", () => {
    assert.deepEqual(resolveRequestAuth(book, null, {}), { kind: "none" })
  })

  it("blocks expired or missing accounts", () => {
    assert.deepEqual(resolveRequestAuth(book, "c", {}), { kind: "blocked", id: "c" })
    assert.deepEqual(resolveRequestAuth(book, "zzz", {}), { kind: "blocked", id: "zzz" })
  })

  it("uses the tab account's own token", () => {
    assert.deepEqual(resolveRequestAuth(book, "a", {}), { kind: "bearer", id: "a", token: "ta" })
  })
})

describe("canAdd and findByEmail", () => {
  it("allows a listed email when the device is full", () => {
    const book = threeAccounts()
    assert.equal(canAdd(book, "B@Luma.test"), true)
    assert.equal(canAdd(book, "d@luma.test"), false)
    assert.equal(canAdd(remove(book, "a"), "d@luma.test"), true)
    assert.equal(findByEmail(book, " C@LUMA.TEST "), "c")
    assert.equal(findByEmail(book, "nobody@luma.test"), null)
  })
})

describe("restored tab", () => {
  it("a reloaded tab whose account was removed while it slept reports it instead of switching", () => {
    // AuthContext passes hadBinding = true whenever sessionStorage still held a binding.
    const book = remove(threeAccounts(), "a")
    const saved: string | null = "a"
    assert.deepEqual(pickActive({ ...book, lastActiveId: "b" }, saved, saved !== null), { id: null, lostBinding: true })
  })
})

describe("signing in to another account while the AI chat account is expired", () => {
  it("keeps the AI chat role on the expired first account", () => {
    let book = threeAccounts()
    book = markExpired(book, "a", "ta")
    book = markExpired(book, "b", "tb")
    assert.equal(canAdd(book, "b@luma.test"), true)
    book = upsertSignedIn(book, { accessToken: "tb2", user: userB }, 999)
    assert.equal(chatbotAccountId(book), "a")
    assert.equal(book.accounts.a.status, "expired")
    assert.equal(book.accounts.b.status, "signed_in")
  })
})

describe("classifyUnauthorized", () => {
  it("treats the backend's clear token answers as expired", () => {
    for (const detail of [
      "Session expired. Please log in again.",
      "Token expired",
      "Invalid token",
      "Invalid or expired token",
      "Not authenticated",
    ]) {
      assert.equal(classifyUnauthorized({ detail }), "expired", detail)
    }
  })

  it("checks again before expiring on vague AI-route answers", () => {
    assert.equal(classifyUnauthorized({ error: "Unauthorized" }), "check")
    assert.equal(classifyUnauthorized({ error: "Please log in again." }), "check")
    assert.equal(classifyUnauthorized({ detail: "That email or password is wrong." }), "check")
    assert.equal(classifyUnauthorized(undefined), "check")
    assert.equal(classifyUnauthorized("oops"), "check")
  })
})
