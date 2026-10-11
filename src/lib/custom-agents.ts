import * as legacyBackendApi from "@/lib/api"
import type { BackendApi } from "@/lib/backend/types"
/**
 * Display metadata for **custom (user-registered) ACP agents**.
 *
 * Built-in agents have compile-time labels and colors (`AGENT_LABELS` /
 * `AGENT_COLORS` in `types.ts`). Custom agents are only known at runtime, so
 * those records can no longer be indexed directly — every call site goes
 * through {@link getAgentLabel} / {@link getAgentColor} instead.
 *
 * Each fixed API client owns a display map:
 * React readers bind through useAgentDisplay; standalone helpers keep a
 * compatibility map. Display metadata is
 * populated once from the agent list the settings/connection layer already
 * fetches, and until then {@link getAgentLabel} falls back to a humanized form
 * of the registry id — which for most registry entries (`goose`, `qwen-code`,
 * `amp-acp`) is already the right answer, so there is no flash of a broken
 * label.
 */

import {
  AGENT_COLORS,
  AGENT_LABELS,
  customAgentId,
  isCustomAgentType,
  type AgentType,
  type BuiltinAgentType,
} from "@/lib/types"

interface DisplayCache {
  customAgentNames: Map<string, string>
  customAgentIcons: Map<string, string>
  displayVersion: number
  displayListeners: Set<() => void>
}
const caches = new WeakMap<BackendApi, DisplayCache>()
function getDisplayCache(api: BackendApi): DisplayCache {
  let cache = caches.get(api)
  if (!cache) {
    cache = {
      customAgentNames: new Map(),
      customAgentIcons: new Map(),
      displayVersion: 0,
      displayListeners: new Set(),
    }
    caches.set(api, cache)
  }
  return cache
}

/** Subscribe to changes published by {@link setCustomAgentDisplay}. */
export function subscribeCustomAgentDisplay(
  listener: () => void,
  api: BackendApi = legacyBackendApi
): () => void {
  const { displayListeners } = getDisplayCache(api)
  displayListeners.add(listener)
  return () => {
    displayListeners.delete(listener)
  }
}

/** Monotonic snapshot for `useSyncExternalStore`. */
export function getCustomAgentDisplayVersion(
  api: BackendApi = legacyBackendApi
): number {
  return getDisplayCache(api).displayVersion
}

/**
 * Publish display metadata for the registered custom agents. Safe to call
 * repeatedly; later calls replace the whole set so a deleted agent stops
 * resolving.
 */
export function setCustomAgentDisplay(
  entries: { agentType: AgentType; name: string; iconUrl?: string | null }[],
  api: BackendApi = legacyBackendApi
): void {
  const cache = getDisplayCache(api)
  const { customAgentNames, customAgentIcons, displayListeners } = cache
  const names = new Map<string, string>()
  const icons = new Map<string, string>()
  for (const entry of entries) {
    const id = customAgentId(entry.agentType)
    if (!id) continue
    if (entry.name.trim()) {
      names.set(id, entry.name.trim())
    }
    const icon = entry.iconUrl?.trim()
    if (icon) {
      icons.set(id, icon)
    }
  }

  // The agent list is refetched on a number of unrelated events; only wake
  // subscribers when what they render actually moved.
  const changed =
    !sameEntries(customAgentNames, names) ||
    !sameEntries(customAgentIcons, icons)
  customAgentNames.clear()
  customAgentIcons.clear()
  for (const [id, name] of names) customAgentNames.set(id, name)
  for (const [id, icon] of icons) customAgentIcons.set(id, icon)
  if (!changed) return
  cache.displayVersion += 1
  for (const listener of displayListeners) listener()
}

function sameEntries(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false
  }
  return true
}

/**
 * The agent's own mark, when it has one: a `data:` URL inlined at add time, or
 * a plain URL for a definition stored before inlining existed. `null` means
 * "fall back to the initial glyph" — the registry does not require an icon, and
 * a manually added agent need not supply one.
 */
export function getAgentIconUrl(
  agentType: AgentType,
  api: BackendApi = legacyBackendApi
): string | null {
  const { customAgentIcons } = getDisplayCache(api)
  const id = customAgentId(agentType)
  if (!id) return null
  return customAgentIcons.get(id) ?? null
}

/** Turn `github-copilot-cli` into `Github Copilot Cli`. */
function humanizeId(id: string): string {
  return id
    .split(/[-_.]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

/**
 * Human-readable name for any agent type. Built-ins use their pinned label;
 * custom agents use their registered name, falling back to a humanized id.
 */
export function getAgentLabel(
  agentType: AgentType,
  api: BackendApi | null = legacyBackendApi
): string {
  const customAgentNames = api ? getDisplayCache(api).customAgentNames : null
  const builtin = AGENT_LABELS[agentType as BuiltinAgentType]
  if (builtin) return builtin
  const id = customAgentId(agentType)
  if (!id) return agentType
  return customAgentNames?.get(id) ?? humanizeId(id)
}

/**
 * Palette for custom agents. They have no brand color, so pick deterministically
 * from the id — the same agent always gets the same swatch, and neighbouring
 * agents in a list are unlikely to collide.
 */
const CUSTOM_AGENT_COLORS = [
  "bg-sky-600",
  "bg-violet-600",
  "bg-teal-600",
  "bg-rose-600",
  "bg-amber-600",
  "bg-indigo-600",
  "bg-lime-600",
  "bg-fuchsia-600",
] as const

function hashId(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

/** Tailwind background class for an agent's dot/swatch. */
export function getAgentColor(agentType: AgentType): string {
  const builtin = AGENT_COLORS[agentType as BuiltinAgentType]
  if (builtin) return builtin
  const id = customAgentId(agentType)
  if (!id) return "bg-muted-foreground"
  return CUSTOM_AGENT_COLORS[hashId(id) % CUSTOM_AGENT_COLORS.length]
}

/**
 * Single uppercase letter used as a custom agent's icon glyph, for agents with
 * no icon of their own (see {@link getAgentIconUrl}).
 */
export function getAgentInitial(
  agentType: AgentType,
  api: BackendApi = legacyBackendApi
): string {
  return getAgentLabel(agentType, api).trim().charAt(0).toUpperCase() || "?"
}

/**
 * Whether an inlined icon is a monochrome SVG that should be rendered as a
 * CSS mask filled with `currentColor` instead of an `<img>`.
 *
 * Every mark in the ACP registry today is a `currentColor` SVG. Inside an
 * `<img>` such an SVG is its own document, where `currentColor` resolves to
 * black — invisible on a dark theme. Masking honours the author's declared
 * intent (inherit the text color), exactly like the compiled-in mono marks.
 *
 * Only `data:image/svg+xml;base64,` URLs are considered: both the backend
 * inliner and the upload form produce that shape, and it is the only one whose
 * source can be inspected synchronously. An SVG counts as monochrome when it
 * references `currentColor`, or when its only explicit paints are black XOR
 * white (a plain silhouette, which has the same one-theme problem). Anything
 * with real colors — including gradients, or a black-and-white mix where
 * masking would flatten a background plate into a solid block — stays an
 * `<img>` and keeps its own palette.
 */
export function isMonochromeSvgDataUrl(url: string | null): boolean {
  if (!url || !url.startsWith(SVG_BASE64_PREFIX)) return false
  const cached = monoSvgCache.get(url)
  if (cached !== undefined) return cached
  // Decoded once per distinct URL for the whole session; AgentIcon renders in
  // hot lists (sidebar rows, selectors), so the classification must never be
  // re-derived per render.
  const result = classifyMonoSvg(url.slice(SVG_BASE64_PREFIX.length))
  monoSvgCache.set(url, result)
  return result
}

const SVG_BASE64_PREFIX = "data:image/svg+xml;base64,"
const monoSvgCache = new Map<string, boolean>()

/** Explicit paints in attribute (`fill="#000"`) or CSS (`fill:#000`) form. */
const PAINT_RE =
  /(?:^|[\s"';{(<])(?:fill|stroke|stop-color|color)\s*[:=]\s*["']?\s*(#[0-9a-fA-F]{3,8}|rgba?\([^"')]*\)|hsla?\([^"')]*\)|[a-zA-Z]+)/gi

const BLACKS = new Set(["#000", "#000000", "#000000ff", "#000f", "black"])
const WHITES = new Set(["#fff", "#ffffff", "#ffffffff", "#ffff", "white"])
const NON_PAINTS = new Set(["none", "transparent", "inherit", "currentcolor"])

function classifyMonoSvg(base64: string): boolean {
  let source: string
  try {
    // `atob` reads the bytes as latin-1; multi-byte labels inside the SVG turn
    // to mojibake, but the ASCII tokens this looks for are unaffected.
    source = atob(base64)
  } catch {
    return false
  }
  if (!/<svg[\s>]/i.test(source)) return false
  if (/<(?:linear|radial)Gradient[\s>]/i.test(source)) return false

  const paints = new Set<string>()
  for (const match of source.matchAll(PAINT_RE)) {
    const value = match[1].toLowerCase()
    if (!NON_PAINTS.has(value)) paints.add(value)
  }
  if (/currentColor/i.test(source)) {
    // A mark that mixes `currentColor` with real paints would flatten under a
    // mask; only the pure form is safely maskable.
    return paints.size === 0
  }
  const allBlack = [...paints].every((p) => BLACKS.has(p))
  const allWhite = [...paints].every((p) => WHITES.has(p))
  // No explicit paint at all means the default black fill.
  return allBlack || allWhite
}

export { isCustomAgentType, customAgentId }
