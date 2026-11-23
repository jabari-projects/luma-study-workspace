// The save rules for one editor (safety design B.6, B.7), with a fake clock and a fake server.
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { RETRY_WAITS_MS, SLOW_AFTER_MS, SaveClient } from "./saveClient.ts"
import type { SaveEnv, SaveReply, SaveRequest, SaveSnapshot } from "./saveClient.ts"

type Row = { id?: string; version?: number; text?: string }

function fakeEnv() {
  let now = 0
  let nextId = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  let online = true
  let hidden = false
  const wakers = new Set<(reason: "online" | "visible") => void>()
  const env: SaveEnv = {
    setTimeout: (fn, ms) => {
      const id = nextId++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number)
    },
    now: () => now,
    isOnline: () => online,
    isHidden: () => hidden,
    onWake: (listener) => {
      wakers.add(listener)
      return () => wakers.delete(listener)
    },
  }
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve))
  }
  return {
    env,
    settle,
    /** Moves the clock forward, running every timer that comes due, in order. */
    async advance(ms: number) {
      const end = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
        await settle()
      }
      now = end
      await settle()
    },
    pendingTimers: () => timers.size,
    setOnline(value: boolean) {
      online = value
    },
    setHidden(value: boolean) {
      hidden = value
    },
    wake(reason: "online" | "visible") {
      wakers.forEach((listener) => listener(reason))
    },
  }
}

type Answer = SaveReply<Row> | (() => SaveReply<Row>)

/** A fake server: answers in order (the last one repeats). Optionally waits for `release()`. */
function fakeServer(answers: Answer[], { manual = false } = {}) {
  const requests: SaveRequest<string>[] = []
  const gates: Array<() => void> = []
  let index = 0
  const send = async (request: SaveRequest<string>): Promise<SaveReply<Row>> => {
    requests.push(request)
    if (manual) await new Promise<void>((resolve) => gates.push(resolve))
    const answer = answers[Math.min(index, answers.length - 1)]
    index += 1
    return typeof answer === "function" ? answer() : answer
  }
  return { send, requests, release: () => gates.shift()?.() }
}

const ok = (version: number, extra: Partial<Row> = {}): SaveReply<Row> => ({ kind: "ok", status: 200, row: { id: "n1", version, ...extra } })
const http = (status: number, data: unknown = {}): SaveReply<Row> => ({ kind: "http", status, data, retryAfterHeader: null })

function makeClient(
  answers: Answer[],
  options: Partial<{ itemId: string | null; version: number | null; createKey: string | null; debounceMs: number; manual: boolean; merge: (a: string, b: string) => string; rowHas: (row: Row, c: string) => boolean }> = {},
) {
  const clock = fakeEnv()
  const server = fakeServer(answers, { manual: options.manual })
  const states: SaveSnapshot<Row>[] = []
  const client = new SaveClient<string, Row>({
    send: server.send,
    env: clock.env,
    debounceMs: options.debounceMs ?? 1500,
    itemId: options.itemId === undefined ? "n1" : options.itemId,
    version: options.version === undefined ? 1 : options.version,
    createKey: options.createKey ?? null,
    autosave: true,
    merge: options.merge,
    rowHas: options.rowHas,
    onChange: (snapshot) => states.push(snapshot),
  })
  const last = () => client.getSnapshot()
  return { client, clock, server, states, last }
}

describe("SaveClient: Saved means the server confirmed it", () => {
  it("shows saved only after a 2xx whose body has a version", async () => {
    const { client, clock, server, last } = makeClient([ok(2)])
    client.change("hello")
    assert.equal(last().state, "dirty")
    await clock.advance(1499)
    assert.equal(server.requests.length, 0)
    await clock.advance(1)
    assert.equal(server.requests.length, 1)
    assert.equal(last().state, "saved")
    assert.equal(last().version, 2)
    assert.equal(last().hasPending, false)
    assert.equal(typeof last().savedAt, "number")
  })

  it("a 2xx without a version is NOT saved", async () => {
    const { client, clock, last } = makeClient([{ kind: "ok", status: 200, row: { id: "n1" } }])
    client.change("hello")
    await clock.advance(1500)
    assert.equal(last().state, "failed")
    assert.equal(last().hasPending, true)
  })

  it("sends expected_version and only the newest words after many quick changes", async () => {
    const { client, clock, server } = makeClient([ok(2)])
    client.change("a")
    await clock.advance(500)
    client.change("ab")
    await clock.advance(500)
    client.change("abc")
    await clock.advance(1500)
    assert.equal(server.requests.length, 1)
    assert.deepEqual(server.requests[0], { content: "abc", mode: "update", itemId: "n1", expectedVersion: 1, createKey: null })
  })
})

describe("SaveClient: one request at a time", () => {
  it("edits made while saving wait, then only the newest goes with the new version", async () => {
    const { client, clock, server, last } = makeClient([ok(2), ok(3)], { manual: true })
    client.change("one")
    await clock.advance(1500)
    assert.equal(server.requests.length, 1)
    client.change("two")
    client.change("three")
    await clock.advance(5000)
    assert.equal(server.requests.length, 1, "no second request while one is in flight")
    server.release()
    await clock.settle()
    assert.equal(server.requests.length, 2)
    assert.equal(server.requests[1].content, "three")
    assert.equal(server.requests[1].expectedVersion, 2)
    server.release()
    await clock.settle()
    assert.equal(last().state, "saved")
    assert.equal(last().version, 3)
  })

  it("says Still saving after 5 seconds, then Saved", async () => {
    const { client, clock, server, last } = makeClient([ok(2)], { manual: true })
    client.change("slow")
    await clock.advance(1500)
    assert.equal(last().state, "saving")
    assert.equal(last().slow, false)
    await clock.advance(SLOW_AFTER_MS)
    assert.equal(last().slow, true)
    server.release()
    await clock.settle()
    assert.equal(last().state, "saved")
    assert.equal(last().slow, false)
    assert.equal(server.requests.length, 1, "a slow save is never sent twice")
  })
})

describe("SaveClient: bounded retries", () => {
  it("retries network trouble after 2, 5, 15, 30 and 60 seconds, then stops at failed", async () => {
    const { client, clock, server, last } = makeClient([{ kind: "network" }])
    client.change("words")
    await clock.advance(1500)
    assert.equal(server.requests.length, 1)
    for (const [index, wait] of RETRY_WAITS_MS.entries()) {
      await clock.advance(wait - 1)
      assert.equal(server.requests.length, index + 1)
      await clock.advance(1)
      assert.equal(server.requests.length, index + 2)
    }
    assert.equal(last().state, "failed")
    assert.equal(clock.pendingTimers(), 0, "nothing keeps polling")
    await clock.advance(10 * 60_000)
    assert.equal(server.requests.length, 6)
    assert.equal(client.latest(), "words", "the words are still here")
  })

  it("502, 503, 504 and 429 are retried; a retry_after replaces the next wait", async () => {
    const { client, clock, server, last } = makeClient([http(503, { retry_after: 120 }), http(429), http(502), http(504), ok(2)])
    client.change("w")
    await clock.advance(1500)
    await clock.advance(119_000)
    assert.equal(server.requests.length, 1)
    await clock.advance(1000)
    assert.equal(server.requests.length, 2)
    await clock.advance(5000 + 15_000 + 30_000)
    assert.equal(server.requests.length, 5)
    assert.equal(last().state, "saved")
  })

  it("a retry_after is capped at 5 minutes", async () => {
    const { client, clock, server } = makeClient([http(503, { retry_after: 9999 }), ok(2)])
    client.change("w")
    await clock.advance(1500)
    await clock.advance(300_000)
    assert.equal(server.requests.length, 2)
  })

  it("a maintenance 503 shows the break message and keeps the words", async () => {
    const { client, clock, last } = makeClient([http(503, { error_code: "maintenance_active", retry_after: 900 })])
    client.change("w")
    await clock.advance(1500)
    assert.equal(last().state, "maintenance")
    assert.equal(client.latest(), "w")
  })

  it("after a long break runs out of retries, Luma reopening saves once; Try again works too", async () => {
    const down = http(503, { error_code: "maintenance_active", retry_after: 900 })
    const { client, clock, server, last } = makeClient([down, down, down, down, down, down, ok(2), down, ok(3)])
    client.change("w")
    await clock.advance(1500)
    // Five waits of at most 5 minutes each, then it stops (no endless retrying).
    await clock.advance(6 * 5 * 60_000)
    assert.equal(server.requests.length, 6)
    assert.equal(last().state, "maintenance")
    assert.equal(clock.pendingTimers(), 0)
    await clock.advance(60 * 60_000)
    assert.equal(server.requests.length, 6) // nothing by itself during the break

    // Luma reopens (maintenance/observe.ts calls this once): one save, and it lands.
    client.retryAfterBreak()
    await clock.settle()
    assert.equal(server.requests.length, 7)
    assert.equal(last().state, "saved")
    assert.equal(client.latest(), null)

    // Not waiting on a break: retryAfterBreak does nothing.
    client.retryAfterBreak()
    await clock.settle()
    assert.equal(server.requests.length, 7)

    // Try again (the button shows in the break state too) sends once.
    client.change("wx")
    await clock.advance(1500)
    assert.equal(last().state, "maintenance")
    client.retry()
    await clock.settle()
    assert.equal(server.requests.length, 9)
    assert.equal(last().state, "saved")
  })

  it("500, 422, 401, 403, 404 and 409 are never retried by themselves", async () => {
    for (const [status, state] of [
      [500, "failed"],
      [422, "failed"],
      [403, "failed"],
      [401, "signed_out"],
      [404, "gone"],
      [409, "conflict"],
    ] as const) {
      const { client, clock, server, last } = makeClient([http(status, status === 409 ? { error_code: "edit_conflict", current: { id: "n1", version: 5 } } : {})])
      client.change("w")
      await clock.advance(1500)
      await clock.advance(10 * 60_000)
      assert.equal(server.requests.length, 1, `status ${status}`)
      assert.equal(last().state, state, `status ${status}`)
      assert.equal(client.latest(), "w")
    }
  })

  it("Try again sends again after failed", async () => {
    const { client, clock, server, last } = makeClient([http(500), ok(2)])
    client.change("w")
    await clock.advance(1500)
    assert.equal(last().state, "failed")
    client.retry()
    await clock.settle()
    assert.equal(server.requests.length, 2)
    assert.equal(last().state, "saved")
  })

  it("retrying pauses while the tab is hidden and goes on when it is visible", async () => {
    const { client, clock, server, last } = makeClient([{ kind: "network" }, ok(2)])
    clock.setHidden(true)
    client.change("w")
    await clock.advance(1500)
    await clock.advance(10 * 60_000)
    assert.equal(server.requests.length, 1, "nothing is sent while hidden")
    clock.setHidden(false)
    clock.wake("visible")
    await clock.settle()
    assert.equal(server.requests.length, 2)
    assert.equal(last().state, "saved")
  })

  it("offline waits for the online event, then saves right away", async () => {
    const { client, clock, server, last } = makeClient([{ kind: "network" }, ok(2)])
    clock.setOnline(false)
    client.change("w")
    await clock.advance(1500)
    assert.equal(last().state, "offline")
    client.change("w2")
    await clock.advance(10 * 60_000)
    assert.equal(server.requests.length, 1)
    clock.setOnline(true)
    clock.wake("online")
    await clock.settle()
    assert.equal(server.requests.length, 2)
    assert.equal(server.requests[1].content, "w2")
    assert.equal(last().state, "saved")
  })
})

describe("SaveClient: conflicts never overwrite quietly", () => {
  const conflict = http(409, { error_code: "edit_conflict", current: { id: "n1", version: 4, text: "theirs" } })

  it("after a 409 nothing saves until the student picks; Keep mine sends with the current version", async () => {
    const { client, clock, server, last } = makeClient([conflict, ok(5)])
    client.change("mine")
    await clock.advance(1500)
    assert.equal(last().state, "conflict")
    assert.deepEqual(last().current, { id: "n1", version: 4, text: "theirs" })
    client.change("mine, more")
    await clock.advance(60_000)
    assert.equal(server.requests.length, 1)
    client.keepMine(4)
    await clock.settle()
    assert.equal(server.requests.length, 2)
    assert.equal(server.requests[1].expectedVersion, 4)
    assert.equal(server.requests[1].content, "mine, more")
    assert.equal(last().state, "saved")
  })

  it("See the newer one drops my words here and takes their version", async () => {
    const { client, clock, server, last } = makeClient([conflict, ok(5)])
    client.change("mine")
    await clock.advance(1500)
    client.takeTheirs({ id: "n1", version: 4 })
    assert.equal(last().state, "clean")
    assert.equal(last().version, 4)
    client.change("next edit")
    await clock.advance(1500)
    assert.equal(server.requests[1].expectedVersion, 4)
  })
})

describe("SaveClient: new items and retries without copies", () => {
  it("leaving can't create a new item; the Save button can", async () => {
    const { client, clock, server, last } = makeClient([ok(1)], { itemId: null, version: null, createKey: "k-1" })
    client.change("draft")
    await clock.advance(60_000)
    assert.equal(server.requests.length, 0, "a new item never saves by itself")
    assert.equal(await client.flush(), false)
    assert.equal(server.requests.length, 0)
    const saved = client.flush({ allowCreate: true })
    await clock.settle()
    assert.equal(await saved, true)
    assert.deepEqual(server.requests[0], { content: "draft", mode: "create", itemId: null, expectedVersion: null, createKey: "k-1" })
    assert.equal(last().itemId, "n1")
  })

  it("a lost answer: every retry of a create sends the same key", async () => {
    const { client, clock, server } = makeClient([{ kind: "network" }, { kind: "network" }, ok(1)], { itemId: null, version: null, createKey: "k-2" })
    client.change("draft")
    void client.flush({ allowCreate: true })
    await clock.settle()
    await clock.advance(2000 + 5000)
    assert.equal(server.requests.length, 3)
    assert.ok(server.requests.every((request) => request.mode === "create" && request.createKey === "k-2"))
  })

  it("the Save button waits through the retries; leaving only waits for one try", async () => {
    const { client, clock, server } = makeClient([{ kind: "network" }, { kind: "ok", status: 200, row: { id: "n1", version: 1 } }], {
      itemId: null,
      version: null,
      createKey: "k-5",
    })
    client.change("draft")
    let buttonResult: boolean | null = null
    void client.flush({ allowCreate: true }).then((saved) => (buttonResult = saved))
    await clock.settle()
    assert.equal(buttonResult, null, "still waiting after the first lost answer")
    assert.equal(await client.flush(), false, "leaving doesn't wait for the retry")
    await clock.advance(2000)
    assert.equal(server.requests.length, 2)
    assert.equal(buttonResult, true)
  })

  it("a replay (200) with older words is followed by an update checked against version 1", async () => {
    const { client, clock, server, last } = makeClient([ok(1, { text: "old" }), ok(2)], {
      itemId: null,
      version: null,
      createKey: "k-3",
      rowHas: (row, content) => row.text === content,
    })
    client.change("new words")
    void client.flush({ allowCreate: true })
    await clock.settle()
    assert.equal(server.requests.length, 2)
    assert.deepEqual(server.requests[1], { content: "new words", mode: "update", itemId: "n1", expectedVersion: 1, createKey: null })
    assert.equal(last().state, "saved")
  })

  it("two tabs with the same create key: a replay of an item edited since gets a conflict, not an overwrite", async () => {
    // Tab 1 (same key, copied by "Duplicate tab") saved first and kept editing: the item is at v3.
    // This tab's create is a replay that returns v3 with tab 1's words.
    const conflict = http(409, { error_code: "edit_conflict", current: { id: "n1", version: 3, text: "tab 1 words" } })
    const { client, clock, server, last } = makeClient([ok(3, { text: "tab 1 words" }), conflict], {
      itemId: null,
      version: null,
      createKey: "k-dup",
      rowHas: (row, content) => row.text === content,
    })
    client.change("tab 2 words")
    void client.flush({ allowCreate: true })
    await clock.settle()
    assert.equal(server.requests.length, 2)
    assert.equal(server.requests[1].mode, "update")
    assert.equal(server.requests[1].expectedVersion, 1) // never 3: that would overwrite tab 1's v2 and v3
    assert.equal(last().state, "conflict")
    assert.equal(client.latest(), "tab 2 words") // kept for the conflict panel
  })

  it("after a create, later edits save by themselves as updates", async () => {
    const { client, clock, server } = makeClient([{ kind: "ok", status: 201, row: { id: "n9", version: 1 } }, ok(2)], { itemId: null, version: null, createKey: "k-4" })
    client.change("a")
    await client.flush({ allowCreate: true })
    client.change("ab")
    await clock.advance(1500)
    assert.equal(server.requests[1].mode, "update")
    assert.equal(server.requests[1].itemId, "n9")
  })
})

describe("SaveClient: signed out and progress merging", () => {
  it("signed out waits for sign-in, then resume sends once", async () => {
    const { client, clock, server, last } = makeClient([{ kind: "signed_out" }, ok(2)])
    client.change("w")
    await clock.advance(1500)
    assert.equal(last().state, "signed_out")
    await clock.advance(10 * 60_000)
    assert.equal(server.requests.length, 1)
    client.resume()
    await clock.settle()
    assert.equal(server.requests.length, 2)
    assert.equal(last().state, "saved")
  })

  it("merge keeps every change that wasn't sent (study progress)", async () => {
    const merge = (older: string, newer: string) => [...new Set([...older.split(","), ...newer.split(",")])].join(",")
    const { client, clock, server } = makeClient([{ kind: "network" }, ok(1)], { debounceMs: 0, merge })
    client.change("c1")
    await clock.advance(0)
    client.change("c2")
    await clock.advance(2000)
    assert.equal(server.requests[1].content, "c1,c2")
  })
})

// Why the deploy order is a hard rule (docs/deployment-checklist.md): the release-1 backend
// (production 7b602b9) answers a create with 201 and no version, and ignores Idempotency-Key.
// The new website then can't confirm the save, so every Try again would make another copy.
describe("SaveClient against the OLD backend (no version field): never run the new site on it", () => {
  it("a create the old backend stored still reads as not saved, and Try again posts again", async () => {
    let made = 0
    const oldBackend = (): SaveReply<Row> => {
      made += 1
      return { kind: "ok", status: 201, row: { id: `old-${made}` } }
    }
    const { client, clock, server, last } = makeClient([oldBackend], { itemId: null, version: null, createKey: "k-old" })
    client.change("draft")
    assert.equal(await client.flush({ allowCreate: true }), false)
    assert.equal(last().state, "failed")
    assert.equal(last().itemId, null, "the stored item's id is never kept")
    client.retry()
    await clock.advance(2000)
    assert.ok(server.requests.length >= 2 && server.requests.every((request) => request.mode === "create"))
    assert.ok(made >= 2, "on a backend that ignores Idempotency-Key, each try makes another copy")
  })
})

describe("SaveClient: words that can't be saved yet wait instead of failing", () => {
  function holdingClient(answers: Answer[]) {
    const clock = fakeEnv()
    const server = fakeServer(answers)
    const client = new SaveClient<string, Row>({
      send: server.send,
      env: clock.env,
      debounceMs: 1500,
      itemId: "n1",
      version: 1,
      createKey: null,
      autosave: true,
      hold: (content) => (content.includes("?") ? "Not saved yet. Finish card 2." : null),
    })
    return { client, clock, server, last: () => client.getSnapshot() }
  }

  it("sends nothing, says why, and saves once the words are ready", async () => {
    const { client, clock, server, last } = holdingClient([ok(2)])
    client.change("half?")
    await clock.advance(1500)
    assert.equal(server.requests.length, 0)
    assert.equal(last().state, "dirty")
    assert.equal(last().held, "Not saved yet. Finish card 2.")
    assert.equal(last().hasPending, true)
    // Waiting is not an error, and no retry timer runs.
    assert.equal(clock.pendingTimers(), 0)
    client.change("whole")
    await clock.advance(1500)
    assert.equal(server.requests.length, 1)
    assert.equal(server.requests[0].content, "whole")
    assert.equal(last().state, "saved")
    assert.equal(last().held, null)
  })

  it("drops the held reason as soon as the card is fixed, before the next try", async () => {
    const { client, clock, server, last } = holdingClient([ok(2)])
    client.change("half?")
    await clock.advance(1500)
    assert.equal(last().held, "Not saved yet. Finish card 2.")
    client.change("whole")
    assert.equal(last().state, "dirty")
    assert.equal(last().held, null)
    assert.equal(server.requests.length, 0)
    // Typing a new unfinished card doesn't nag until the next try.
    client.change("again?")
    assert.equal(last().held, null)
    await clock.advance(1500)
    assert.equal(last().held, "Not saved yet. Finish card 2.")
    assert.equal(server.requests.length, 0)
  })

  it("answers a flush right away with not saved (leaving keeps the words in this tab)", async () => {
    const { client, server, last } = holdingClient([ok(2)])
    client.change("half?")
    assert.equal(await client.flush(), false)
    assert.equal(server.requests.length, 0)
    assert.equal(last().held, "Not saved yet. Finish card 2.")
  })
})
