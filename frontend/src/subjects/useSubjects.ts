import { useCallback, useEffect, useState } from "react"

import { api } from "../api"
import type { SubjectList } from "./subjects"

// One GET /subjects per page load, shared by every picker and label on the page. No polling:
// it loads the first time something needs it, and again only when the student taps "Try again".
let cached: SubjectList | null = null
let pending: Promise<SubjectList> | null = null

function isSubjectList(value: unknown): value is SubjectList {
  const v = value as Partial<SubjectList> | null
  return Boolean(v && Array.isArray(v.groups) && Array.isArray(v.subjects))
}

function load(): Promise<SubjectList> {
  if (cached) return Promise.resolve(cached)
  if (!pending) {
    pending = api
      .get<unknown>("/subjects")
      .then((response) => {
        if (!isSubjectList(response.data)) throw new Error("bad subject list")
        cached = response.data
        return cached
      })
      .catch((error: unknown) => {
        pending = null // the next "Try again" asks once more
        throw error
      })
  }
  return pending
}

export type SubjectsState = {
  list: SubjectList | null
  failed: boolean
  /** Ask once more after a failed load. */
  retry: () => void
}

/** The subject list, loaded once per page load. */
export function useSubjects(): SubjectsState {
  const [list, setList] = useState<SubjectList | null>(cached)
  const [failed, setFailed] = useState(false)
  const [round, setRound] = useState(0)

  useEffect(() => {
    if (cached) return
    let active = true
    load().then(
      (loaded) => active && setList(loaded),
      () => active && setFailed(true),
    )
    return () => {
      active = false
    }
  }, [round])

  const retry = useCallback(() => {
    setFailed(false)
    setRound((value) => value + 1)
  }, [])

  return { list, failed, retry }
}
