/**
 * Pure file/blob helpers shared by every composer that can take attachments.
 *
 * Extracted verbatim from `message-input.tsx` so the conversation composer and
 * the to-do task composers classify, name and encode a dropped/pasted/picked
 * file exactly the same way — one MIME table, one base64 reader, one "is this
 * text-like" rule. Nothing here touches React or the editor except
 * {@link editorHasFileReference}, which only reads a Tiptap document.
 */

import type { Editor } from "@tiptap/core"

import { randomUUID } from "@/lib/utils"

const MIME_BY_EXT: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  csv: "text/csv",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/typescript",
  tsx: "text/tsx",
  jsx: "text/jsx",
  py: "text/x-python",
  rs: "text/rust",
  go: "text/x-go",
  java: "text/x-java-source",
  xml: "application/xml",
  toml: "application/toml",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
}

/** Ceiling on the bytes a dropped local image may inline for its thumbnail. */
export const DRAG_DROP_IMAGE_MAX_BYTES = 20_000_000

export function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

export function mimeTypeFromPath(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  return MIME_BY_EXT[ext] ?? null
}

/**
 * Whether a drag is carrying files, judged from anything a target can read.
 *
 * `dataTransfer.types` is the only reliable target-side signal (Safari fills
 * `items` only on drop), but "Files" is not the only way a source spells it:
 * WebKit publishes `text/uri-list` for Finder drags, and `files` itself is
 * populated by the time `drop` runs. Accept all of them so a WebKit-handled
 * drop is not mistaken for a text drag.
 */
export function dragCarriesFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  if ((dataTransfer.files?.length ?? 0) > 0) return true
  const types = Array.from(dataTransfer.types ?? []).map((type) =>
    type.toLowerCase()
  )
  if (types.includes("files")) return true
  const items = dataTransfer.items ? Array.from(dataTransfer.items) : []
  if (items.some((item) => item.kind === "file")) return true
  // Link and rich-text drags carry a uri list too (that is how a dragged <a>
  // or a selected image is pasted), but they also publish markup. Only a drag
  // without html is taken as file URLs.
  if (types.includes("text/html")) return false
  return types.includes("text/uri-list") || types.includes("public.file-url")
}

/**
 * Whether a hovered drag *may* carry files, for the drop affordance only.
 *
 * Strictly broader than {@link dragCarriesFiles}: a drag whose pasteboard
 * exposes no type at all is treated as a candidate. WebKit can enter protected
 * mode for an external drag and report an empty `types` list while hovering
 * (the data becomes readable on drop), and with no other signal the composer
 * would show no "drop files" hint at all. Internal drags always publish a type
 * (our tree payload or `text/plain`), so they are unaffected.
 */
export function dragMayCarryFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  if (dragCarriesFiles(dataTransfer)) return true
  return Array.from(dataTransfer.types ?? []).length === 0
}

/**
 * Local file paths a DOM drop carries, recovered from the drag's URI list.
 *
 * A Tauri-native drop hands us OS paths directly; a WebKit-handled drop only
 * exposes `File` objects, which have no path. macOS drag sources also put the
 * file URL on the pasteboard (`text/uri-list`, mirrored in `text/plain`), the
 * one way back to a path the agent can read — so a drop that lands here can
 * still attach a `file://` reference instead of inline bytes.
 */
export function filePathsFromDataTransfer(
  dataTransfer: DataTransfer | null
): string[] {
  if (!dataTransfer) return []
  const paths: string[] = []
  for (const type of ["text/uri-list", "text/plain"]) {
    let raw = ""
    try {
      raw = dataTransfer.getData(type)
    } catch {
      // Protected mode / unsupported type: nothing to read.
      continue
    }
    for (const line of raw.split(/\r?\n/)) {
      const uri = line.trim()
      if (!uri || uri.startsWith("#")) continue
      const path = pathFromFileUri(uri)
      if (path && !paths.includes(path)) paths.push(path)
    }
  }
  return paths
}

function pathFromFileUri(uri: string): string | null {
  if (!/^file:\/\//i.test(uri)) return null
  try {
    const url = new URL(uri)
    let path = decodeURIComponent(url.pathname)
    // file:///C:/Users/… → C:/Users/… (Windows drive letters)
    if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1)
    // file://server/share/… → //server/share/…
    if (url.host) path = `//${url.host}${path}`
    return path || null
  } catch {
    return null
  }
}

/**
 * Whether `element` is on screen and can receive a drop right now.
 *
 * Inactive conversation tabs stay mounted at `absolute inset-0` with
 * `visibility: hidden`, so their bounding rect overlaps the active tab's — a
 * drag must not fan out across every open conversation. A composer behind a
 * modal is excluded too: Radix's scroll lock turns `pointer-events` off on the
 * page beneath the dialog.
 */
export function elementAcceptsDrop(element: HTMLElement): boolean {
  const doc = element.ownerDocument
  const style = doc?.defaultView?.getComputedStyle(element)
  if (style) {
    if (
      style.visibility === "hidden" ||
      style.display === "none" ||
      style.pointerEvents === "none"
    ) {
      return false
    }
  }
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

/**
 * Whether an OS drag position (Tauri reports window coordinates, sometimes in
 * physical pixels) lands on `element` **and** `element` is what the user would
 * actually hit there.
 *
 * Two guards, both needed because a Tauri drag-drop event is delivered to every
 * listener in the window:
 *
 * - Hidden/detached hosts are rejected outright (see {@link elementAcceptsDrop}).
 * - The topmost element at the point must be inside the host. A composer sitting
 *   behind a modal (the to-do task editor dialog, the detail drawer) still has
 *   its full rect at the same coordinates; `elementFromPoint` is what tells the
 *   two apart, so the drop lands only in the composer the user can see.
 */
export function pointWithinElement(
  position: { x: number; y: number },
  element: HTMLElement
): boolean {
  if (!elementAcceptsDrop(element)) return false
  const doc = element.ownerDocument
  const rect = element.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const candidates = [
    { x: position.x, y: position.y },
    { x: position.x / dpr, y: position.y / dpr },
  ]
  return candidates.some((point) => {
    if (
      point.x < rect.left ||
      point.x > rect.right ||
      point.y < rect.top ||
      point.y > rect.bottom
    ) {
      return false
    }
    // `elementFromPoint` is unavailable in some test DOMs — fall back to the
    // rect result there rather than dropping the event on the floor.
    if (typeof doc?.elementFromPoint !== "function") return true
    const top = doc.elementFromPoint(point.x, point.y)
    return top !== null && element.contains(top)
  })
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => {
      reject(reader.error ?? new Error("Failed to read blob"))
    }
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Unexpected non-string blob reader result"))
        return
      }
      const markerIndex = reader.result.indexOf(",")
      resolve(
        markerIndex >= 0 ? reader.result.slice(markerIndex + 1) : reader.result
      )
    }
    reader.readAsDataURL(blob)
  })
}

export function getFilePath(file: File): string | null {
  const withPath = file as File & { path?: string; webkitRelativePath?: string }
  if (typeof withPath.path === "string" && withPath.path.trim().length > 0) {
    return withPath.path
  }
  if (
    typeof withPath.webkitRelativePath === "string" &&
    withPath.webkitRelativePath.trim().length > 0
  ) {
    return withPath.webkitRelativePath
  }
  return null
}

const TEXT_LIKE_MIME_PREFIXES = [
  "text/",
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/javascript",
  "application/typescript",
]

export function isTextLikeFile(file: File): boolean {
  const mime = file.type.toLowerCase()
  if (mime) {
    if (TEXT_LIKE_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) {
      return true
    }
  }
  const ext = file.name.split(".").pop()?.toLowerCase()
  if (!ext) return false
  return Boolean(
    MIME_BY_EXT[ext]?.startsWith("text/") ||
    ["json", "yaml", "yml", "xml", "toml", "md", "csv"].includes(ext)
  )
}

export function buildClipboardResourceUri(name: string): string {
  const normalizedName = name.trim() || "clipboard-resource"
  return `clipboard://${encodeURIComponent(normalizedName)}-${randomUUID()}`
}

export function buildDataUri(
  base64Data: string,
  mimeType: string | null
): string {
  const safeMime =
    mimeType && mimeType.trim() ? mimeType : "application/octet-stream"
  return `data:${safeMime};base64,${base64Data}`
}

/** Whether the document already holds a `refType` reference badge for `uri`. */
export function editorHasReference(
  editor: Editor,
  refType: string,
  uri: string
): boolean {
  let found = false
  editor.state.doc.descendants((node) => {
    if (found) return false
    if (
      node.type.name === "reference" &&
      node.attrs?.refType === refType &&
      node.attrs?.uri === uri
    ) {
      found = true
      return false
    }
    return true
  })
  return found
}

/** Whether the document already holds a file reference badge for `uri` (used to
 *  dedupe repeated drops/picks of the same path, mirroring the old seen-set). */
export function editorHasFileReference(editor: Editor, uri: string): boolean {
  return editorHasReference(editor, "file", uri)
}
