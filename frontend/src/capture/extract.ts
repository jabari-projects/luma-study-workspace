/**
 * Read text out of files right here in the browser, so the file itself never leaves the student's device.
 * PDF and Word readers are loaded only when a student picks one of those files.
 */

export const MAX_TEXT_CHARS = 60000
export const MAX_FILE_BYTES = 15 * 1024 * 1024
const MAX_PDF_PAGES = 60

export class ExtractError extends Error {
  readonly code: "too_big" | "type" | "scanned" | "locked" | "empty" | "broken"
  constructor(code: ExtractError["code"], message: string) {
    super(message)
    this.code = code
  }
}

export type Extracted = {
  text: string
  label: string
  pagesRead?: number
  pagesTotal?: number
}

type Progress = (message: string) => void

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ""
}

export const ACCEPTED_FILES = ".pdf,.docx,.txt,.md,.markdown,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"

export async function extractFromFile(file: File, onProgress: Progress = () => {}): Promise<Extracted> {
  if (file.size > MAX_FILE_BYTES) {
    throw new ExtractError("too_big", "That file is too big. Try one under 15 MB.")
  }
  const ext = extensionOf(file.name)

  let text: string
  let extra: Partial<Extracted> = {}
  if (ext === "pdf" || file.type === "application/pdf") {
    const result = await readPdf(file, onProgress)
    text = result.text
    extra = { pagesRead: result.pagesRead, pagesTotal: result.pagesTotal }
  } else if (ext === "docx") {
    onProgress("Opening your Word file...")
    text = await readDocx(file)
  } else if (ext === "doc") {
    throw new ExtractError("type", "Please save it as .docx or PDF first.")
  } else if (["txt", "md", "markdown"].includes(ext) || file.type.startsWith("text/")) {
    onProgress("Reading your file...")
    text = await readPlainText(file)
  } else {
    throw new ExtractError("type", "We can't open that kind of file yet. Try PDF, Word, or a text file.")
  }

  const cleaned = tidyText(text)
  if (cleaned.length < 20) {
    throw new ExtractError("empty", "We couldn't find any words in that file.")
  }
  return { text: cleaned, label: file.name, ...extra }
}

async function readPlainText(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  let text = new TextDecoder("utf-8").decode(buffer)
  // Lots of replacement characters usually means an older Windows encoding.
  // (TextDecoder already drops a leading byte-order mark.)
  const broken = text.split(String.fromCharCode(0xfffd)).length - 1
  if (broken > 5 && broken / Math.max(1, text.length) > 0.001) {
    text = new TextDecoder("windows-1252").decode(buffer)
  }
  return text
}

type MammothApi = { extractRawText: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }> }

async function readDocx(file: File): Promise<string> {
  try {
    const loaded = (await import("mammoth/mammoth.browser.min.js")) as unknown as { default?: MammothApi } & MammothApi
    const mammoth = loaded.default ?? loaded
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })
    return result.value
  } catch {
    throw new ExtractError("broken", "We couldn't open that Word file. Try saving it again or use PDF.")
  }
}

async function readPdf(file: File, onProgress: Progress) {
  onProgress("Opening your PDF...")
  const pdfjs = await import("pdfjs-dist")
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  let doc
  try {
    doc = await loadingTask.promise
  } catch (error: unknown) {
    const name = error && typeof error === "object" && "name" in error ? String(error.name) : ""
    await loadingTask.destroy().catch(() => undefined)
    if (name === "PasswordException") {
      throw new ExtractError("locked", "This PDF is locked with a password.")
    }
    throw new ExtractError("broken", "We couldn't open that PDF.")
  }

  const pagesTotal = doc.numPages
  const pagesRead = Math.min(pagesTotal, MAX_PDF_PAGES)
  const parts: string[] = []
  let length = 0
  let lastPage = 0
  try {
    for (let pageNumber = 1; pageNumber <= pagesRead; pageNumber += 1) {
      onProgress(`Reading page ${pageNumber} of ${pagesRead}...`)
      const page = await doc.getPage(pageNumber)
      const content = await page.getTextContent()
      const pageText = content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
        .join("")
      parts.push(pageText)
      length += pageText.length
      lastPage = pageNumber
      page.cleanup()
      if (length > MAX_TEXT_CHARS) break
    }
  } catch {
    throw new ExtractError("broken", "We couldn't read all of that PDF.")
  } finally {
    // Always shut down the PDF worker, even when a page fails.
    await loadingTask.destroy().catch(() => undefined)
  }

  const text = parts.join("\n\n")
  const letters = text.replace(/\s/g, "").length
  if (letters / Math.max(1, lastPage) < 20) {
    throw new ExtractError(
      "scanned",
      "This PDF looks like a picture, so we can't read the words. Take a photo of the page and use Image to Notes.",
    )
  }
  return { text, pagesRead: lastPage, pagesTotal }
}

export function tidyText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

/** YouTube's "Show transcript" copies include timestamps; take them out. */
export function cleanTranscript(text: string): string {
  return tidyText(
    text
      .split(/\r?\n/)
      .filter((line) => !/^\s*\d{1,2}:\d{2}(:\d{2})?\s*$/.test(line))
      .map((line) => line.replace(/^\s*\d{1,2}:\d{2}(:\d{2})?\s+/, ""))
      .filter((line) => !/^\s*(\d+\s+(seconds?|minutes?|hours?)(,\s*)?)+\s*$/i.test(line))
      .join("\n"),
  ).replace(/\n+/g, " ")
}

export function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

export function isYouTubeUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    // Only real web links count (never javascript:, data:, etc.), since this value becomes a link.
    if (url.protocol !== "https:" && url.protocol !== "http:") return false
    return /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(url.hostname)
  } catch {
    return false
  }
}
