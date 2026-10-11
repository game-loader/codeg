import type { BackendKey } from "./types"

export type WindowResourceRef =
  | {
      backendKey: BackendKey
      kind: "conversation"
      id: string
      folderId: number
    }
  | { backendKey: BackendKey; kind: "file"; id: string; path: string }

export interface MultiHostWindowLayout {
  version: 1
  primary: BackendKey
  secondary: BackendKey | null
  split: "none" | "horizontal" | "vertical"
  selected: WindowResourceRef | null
  files: Array<Extract<WindowResourceRef, { kind: "file" }>>
  collapsedHosts: BackendKey[]
  destinations: Partial<Record<BackendKey, string>>
}

export const MULTI_HOST_LAYOUT_STORAGE_KEY = "codeg:multi-host-window:v1"

export function isBackendKey(value: unknown): value is BackendKey {
  if (value === "local") return true
  if (typeof value !== "string" || !/^remote:[1-9]\d*$/.test(value)) {
    return false
  }
  return Number.isSafeInteger(Number(value.slice("remote:".length)))
}

export function windowResourceKey(ref: WindowResourceRef): string {
  return JSON.stringify([ref.backendKey, ref.kind, ref.id])
}

export function emptyWindowLayout(
  primary: BackendKey = "local"
): MultiHostWindowLayout {
  return {
    version: 1,
    primary,
    secondary: null,
    split: "none",
    selected: null,
    files: [],
    collapsedHosts: [],
    destinations: {},
  }
}

function resource(value: unknown): WindowResourceRef | null {
  if (typeof value !== "object" || value === null) return null
  const ref = value as Record<string, unknown>
  if (
    !isBackendKey(ref.backendKey) ||
    typeof ref.id !== "string" ||
    ref.id.length === 0 ||
    ref.id.length > 8_192
  ) {
    return null
  }
  if (
    ref.kind === "conversation" &&
    Number.isSafeInteger(ref.folderId) &&
    Number(ref.folderId) > 0
  ) {
    return {
      backendKey: ref.backendKey,
      kind: "conversation",
      id: ref.id,
      folderId: Number(ref.folderId),
    }
  }
  if (
    ref.kind === "file" &&
    typeof ref.path === "string" &&
    ref.path.length > 0
  ) {
    return {
      backendKey: ref.backendKey,
      kind: "file",
      id: ref.id,
      path: ref.path,
    }
  }
  return null
}

/** Whitelist the persisted fields so credentials and runtime state never leak. */
export function sanitizeWindowLayout(value: unknown): MultiHostWindowLayout {
  if (typeof value !== "object" || value === null) return emptyWindowLayout()
  const raw = value as Record<string, unknown>
  if (raw.version !== 1) return emptyWindowLayout()
  const result = emptyWindowLayout(
    isBackendKey(raw.primary) ? raw.primary : "local"
  )
  result.secondary =
    isBackendKey(raw.secondary) && raw.secondary !== result.primary
      ? raw.secondary
      : null
  result.split =
    result.secondary && (raw.split === "horizontal" || raw.split === "vertical")
      ? raw.split
      : "none"
  result.selected = resource(raw.selected)
  if (Array.isArray(raw.files)) {
    result.files = raw.files.slice(0, 200).flatMap((value) => {
      const ref = resource(value)
      return ref?.kind === "file" ? [ref] : []
    })
  }
  if (Array.isArray(raw.collapsedHosts)) {
    result.collapsedHosts = [
      ...new Set(raw.collapsedHosts.filter(isBackendKey)),
    ]
  }
  if (typeof raw.destinations === "object" && raw.destinations !== null) {
    for (const [key, url] of Object.entries(raw.destinations)) {
      if (isBackendKey(key) && typeof url === "string")
        result.destinations[key] = url
    }
  }
  return result
}

export function readWindowLayout(
  storageKey = MULTI_HOST_LAYOUT_STORAGE_KEY
): MultiHostWindowLayout {
  try {
    return sanitizeWindowLayout(
      JSON.parse(localStorage.getItem(storageKey) ?? "null")
    )
  } catch {
    return emptyWindowLayout()
  }
}

export function saveWindowLayout(
  layout: MultiHostWindowLayout,
  storageKey = MULTI_HOST_LAYOUT_STORAGE_KEY
): void {
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify(sanitizeWindowLayout(layout))
    )
  } catch {
    // A denied/full local store does not affect work on the backend.
  }
}

/** IDs restored for an old endpoint must never be replayed on its replacement. */
export function retireWindowResources(
  layout: MultiHostWindowLayout,
  backendKey: BackendKey
): MultiHostWindowLayout {
  return {
    ...layout,
    files: layout.files.filter((file) => file.backendKey !== backendKey),
    selected:
      layout.selected?.backendKey === backendKey ? null : layout.selected,
  }
}

export function reconcileWindowDestination(
  layout: MultiHostWindowLayout,
  backendKey: BackendKey,
  baseUrl: string
): MultiHostWindowLayout {
  const before = layout.destinations[backendKey]
  const moved = before !== undefined && before !== baseUrl
  return {
    ...(moved ? retireWindowResources(layout, backendKey) : layout),
    destinations: { ...layout.destinations, [backendKey]: baseUrl },
  }
}
