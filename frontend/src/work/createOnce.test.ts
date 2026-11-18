// Explicit Save buttons that make a new item: a replayed create is checked (design B.6, B.7).
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { CHANGED_SINCE_MESSAGE, NOT_CHECKED_MESSAGE, createOnce, sameCards } from "./createOnce.ts"
import type { CreateTransport } from "./createOnce.ts"

type Row = { id?: string; version?: number; content?: string }

class HttpError extends Error {
  status: number
  constructor(status: number) {
    super("http")
    this.status = status
  }
}

function fake(answers: { post: () => { status: number; data: Row }; put?: (body: Record<string, unknown>) => { status: number; data: Row } }) {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = []
  const transport: CreateTransport<Row> = {
    post: async (path, body) => {
      calls.push({ method: "POST", path, body })
      return answers.post()
    },
    put: async (path, body) => {
      calls.push({ method: "PUT", path, body })
      if (!answers.put) throw new Error("no PUT expected")
      return answers.put(body)
    },
    statusOf: (error) => (error instanceof HttpError ? error.status : null),
  }
  return { transport, calls }
}

const sameContent = (sent: string) => (row: Row) => row.content === sent

describe("createOnce", () => {
  it("a new item (201) with a version is saved, with no extra update", async () => {
    const { transport, calls } = fake({ post: () => ({ status: 201, data: { id: "n1", version: 1, content: "SYNTH a" } }) })
    const row = await createOnce(transport, "/notes", { content: "SYNTH a" }, sameContent("SYNTH a"))
    assert.equal(row.id, "n1")
    assert.deepEqual(calls.map((c) => c.method), ["POST"])
  })

  it("a 2xx without a version is NOT saved", async () => {
    const { transport } = fake({ post: () => ({ status: 201, data: { id: "n1" } }) })
    await assert.rejects(createOnce(transport, "/notes", { content: "SYNTH a" }, sameContent("SYNTH a")), { message: NOT_CHECKED_MESSAGE })
  })

  it("a replay (200) with the same words is saved, with no extra update", async () => {
    const { transport, calls } = fake({ post: () => ({ status: 200, data: { id: "n1", version: 1, content: "SYNTH a" } }) })
    await createOnce(transport, "/notes", { content: "SYNTH a" }, sameContent("SYNTH a"))
    assert.equal(calls.length, 1)
  })

  it("a replay with older words sends the new words, checked against version 1", async () => {
    const { transport, calls } = fake({
      post: () => ({ status: 200, data: { id: "n1", version: 1, content: "SYNTH first try" } }),
      put: (body) => ({ status: 200, data: { id: "n1", version: 2, content: String(body.content) } }),
    })
    const row = await createOnce(transport, "/notes", { content: "SYNTH edited" }, sameContent("SYNTH edited"))
    assert.equal(row.version, 2)
    assert.equal(row.content, "SYNTH edited")
    assert.deepEqual(calls[1], { method: "PUT", path: "/notes/n1", body: { content: "SYNTH edited", expected_version: 1 } })
  })

  it("a replay of an item changed since (409) overwrites nothing and says so plainly", async () => {
    const { transport, calls } = fake({
      post: () => ({ status: 200, data: { id: "n1", version: 3, content: "SYNTH other tab" } }),
      put: () => {
        throw new HttpError(409)
      },
    })
    await assert.rejects(createOnce(transport, "/notes", { content: "SYNTH mine" }, sameContent("SYNTH mine")), { message: CHANGED_SINCE_MESSAGE })
    assert.equal(calls[1].body.expected_version, 1) // never the replayed row's current version
  })

  it("other errors from the update are passed on as they are", async () => {
    const boom = new HttpError(500)
    const { transport } = fake({
      post: () => ({ status: 200, data: { id: "n1", version: 1, content: "SYNTH old" } }),
      put: () => {
        throw boom
      },
    })
    await assert.rejects(createOnce(transport, "/notes", { content: "SYNTH new" }, sameContent("SYNTH new")), (error) => error === boom)
  })

  it("compares cards by their words, not their ids", () => {
    assert.ok(sameCards([{ id: "a", front: "Q", back: "A" }], [{ id: "b", front: "Q ", back: "A" }]))
    assert.ok(!sameCards([{ id: "a", front: "Q", back: "A" }], [{ id: "a", front: "Q2", back: "A" }]))
    assert.ok(!sameCards([{ front: "Q", back: "A" }], []))
  })
})
