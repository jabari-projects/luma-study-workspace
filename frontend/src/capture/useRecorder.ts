import { useCallback, useEffect, useRef, useState } from "react"

export const MAX_RECORDING_SECONDS = 10 * 60

const MIME_CHOICES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]

export type RecorderState = "idle" | "asking" | "recording" | "paused" | "done" | "error"

export type Recording = { blob: Blob; url: string; filename: string; seconds: number }

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return ""
  return MIME_CHOICES.find((type) => MediaRecorder.isTypeSupported(type)) ?? ""
}

function extensionFor(mime: string): string {
  if (mime.includes("mp4")) return "m4a"
  if (mime.includes("ogg")) return "ogg"
  return "webm"
}

function friendlyMicError(error: unknown): string {
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : ""
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "We can't hear you yet. Let Luma use your mic in your browser settings."
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "We can't find a mic. You can upload a sound file instead."
  }
  if (name === "NotReadableError") {
    return "Another app is using your mic. Close it and try again."
  }
  return "Recording didn't start. You can upload a sound file instead."
}

export function canRecord(): boolean {
  return typeof window !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined"
}

/**
 * Records from the microphone. `levelsRef` gets a fresh 0..1 loudness value many times a second
 * so the meter can animate without re-rendering React.
 */
export function useRecorder(onLevel?: (level: number) => void) {
  const [state, setState] = useState<RecorderState>("idle")
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [recording, setRecording] = useState<Recording | null>(null)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const frameRef = useRef(0)
  const tickRef = useRef(0)
  const chunksRef = useRef<Blob[]>([])
  const secondsRef = useRef(0)
  const levelCallback = useRef(onLevel)
  const mountedRef = useRef(true)
  const startTokenRef = useRef(0)

  useEffect(() => {
    levelCallback.current = onLevel
  }, [onLevel])

  const cleanupStream = useCallback(() => {
    cancelAnimationFrame(frameRef.current)
    window.clearInterval(tickRef.current)
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    void audioContextRef.current?.close().catch(() => undefined)
    audioContextRef.current = null
    levelCallback.current?.(0)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      startTokenRef.current += 1
    }
  }, [])

  useEffect(
    () => () => {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.onstop = null
        recorderRef.current.stop()
      }
      cleanupStream()
    },
    [cleanupStream],
  )

  useEffect(() => {
    return () => {
      if (recording) URL.revokeObjectURL(recording.url)
    }
  }, [recording])

  const stop = useCallback(() => {
    const recorder = recorderRef.current
    if (recorder && recorder.state !== "inactive") recorder.stop()
  }, [])

  const start = useCallback(async () => {
    setError(null)
    if (!canRecord()) {
      setError("This browser can't record. You can upload a sound file instead.")
      setState("error")
      return
    }
    setState("asking")
    const token = (startTokenRef.current += 1)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      if (!mountedRef.current || token !== startTokenRef.current) {
        // The page closed (or a newer start began) while the mic question was open.
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream
      const mimeType = pickMimeType()
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 64000 } : undefined)
      recorderRef.current = recorder
      chunksRef.current = []
      secondsRef.current = 0
      setSeconds(0)
      setRecording(null)

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        if (!mountedRef.current) {
          cleanupStream()
          return
        }
        const type = recorder.mimeType || mimeType || "audio/webm"
        const blob = new Blob(chunksRef.current, { type })
        cleanupStream()
        if (blob.size === 0) {
          setError("We didn't hear anything. Try again a little closer.")
          setState("error")
          return
        }
        setRecording({
          blob,
          url: URL.createObjectURL(blob),
          filename: `recording.${extensionFor(type)}`,
          seconds: secondsRef.current,
        })
        setState("done")
      }

      // Live loudness meter.
      try {
        const context = new AudioContext()
        audioContextRef.current = context
        const analyser = context.createAnalyser()
        analyser.fftSize = 512
        context.createMediaStreamSource(stream).connect(analyser)
        const data = new Uint8Array(analyser.fftSize)
        const loop = () => {
          analyser.getByteTimeDomainData(data)
          let sum = 0
          for (const value of data) {
            const centered = (value - 128) / 128
            sum += centered * centered
          }
          levelCallback.current?.(Math.min(1, Math.sqrt(sum / data.length) * 3.2))
          frameRef.current = requestAnimationFrame(loop)
        }
        loop()
      } catch {
        // The meter is just for fun; recording still works without it.
      }

      tickRef.current = window.setInterval(() => {
        if (recorderRef.current?.state !== "recording") return
        secondsRef.current += 1
        setSeconds(secondsRef.current)
        if (secondsRef.current >= MAX_RECORDING_SECONDS) stop()
      }, 1000)

      recorder.start(1000)
      setState("recording")
    } catch (err: unknown) {
      cleanupStream()
      if (!mountedRef.current || token !== startTokenRef.current) return
      setError(friendlyMicError(err))
      setState("error")
    }
  }, [cleanupStream, stop])

  const pause = useCallback(() => {
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.pause()
      setState("paused")
    }
  }, [])

  const resume = useCallback(() => {
    if (recorderRef.current?.state === "paused") {
      recorderRef.current.resume()
      setState("recording")
    }
  }, [])

  const reset = useCallback(() => {
    // Also cancel a recording that is still waiting for the mic question.
    startTokenRef.current += 1
    cleanupStream()
    setRecording(null)
    setSeconds(0)
    setError(null)
    setState("idle")
  }, [cleanupStream])

  return { state, seconds, error, recording, start, stop, pause, resume, reset }
}

export function formatClock(total: number): string {
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, "0")}`
}
