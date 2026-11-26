"use client"

import { useEffect, useState } from "react"

import {
  createPetSpriteObjectUrl,
  revokePetSpriteObjectUrl,
} from "@/lib/pet/sprite-url"
import { useHarnessBackend } from "@/hooks/use-harness-backend"
import type { HarnessBackend } from "./backend"
import { isSrnAssetPath } from "./api"
import type { SrnAsset } from "./types"

/**
 * Image types the proxy's bytes may be shown as. Raster formats only: a blob
 * URL lives in the app's own origin, and an SVG opened from one ("open image
 * in new tab") is a document that can run script there. Whatever else the
 * backend hands back is treated as no image.
 */
const IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
])

/** How many images' bytes are kept. A long scroll through the catalog passes
 *  hundreds of publishers; the oldest are let go and fetched again if needed. */
const CACHE_LIMIT = 256

// The fetched BYTES per path, not the blob URL — the approach, and the
// reasoning, of `use-proxied-marketplace-asset.ts`: the paths are content-
// addressed, so the same publisher on thirty cards costs one request, and
// each consumer mints (and revokes) a blob URL of its own, which no other
// consumer's unmount can pull out from under it.
let caches = new WeakMap<HarnessBackend, Map<string, Promise<SrnAsset>>>()

function loadAsset(path: string, backend: HarnessBackend): Promise<SrnAsset> {
  const assetCache = caches.get(backend) ?? new Map<string, Promise<SrnAsset>>()
  caches.set(backend, assetCache)
  const cached = assetCache.get(path)
  if (cached) return cached

  const promise = backend.catalog.srnAsset(path).then((asset) => {
    const mime = asset.mime.split(";")[0].trim().toLowerCase()
    if (!IMAGE_TYPES.has(mime)) {
      throw new Error(`Not an image type the app shows: ${asset.mime}`)
    }
    return { mime, dataBase64: asset.dataBase64 }
  })
  assetCache.set(path, promise)
  if (assetCache.size > CACHE_LIMIT) {
    // A Map iterates in insertion order: the first key is the oldest.
    const oldest = assetCache.keys().next().value
    if (oldest !== undefined) assetCache.delete(oldest)
  }
  // A failure is not kept: the next card to ask gets a fresh try. Guarded on
  // identity so a late failure cannot evict a newer entry.
  promise.catch(() => {
    if (assetCache.get(path) === promise) assetCache.delete(path)
  })
  return promise
}

export interface SrnAssetState {
  /** A blob URL for the image, or `null` while loading and on failure. */
  src: string | null
  failed: boolean
}

const NONE: SrnAssetState = { src: null, failed: false }

/**
 * An image kept on spacering.net, as something an `<img>` can show.
 *
 * The page never loads it from there: the backend fetches the bytes
 * (`srn_asset`) and they are shown from a blob URL. `path` is the
 * site-relative address the catalog gave — a publisher's `avatar`, a prompt's
 * `cover`; anything else, and `null`, yields no image and no request.
 */
export function useSrnAsset(path: string | null | undefined): SrnAssetState {
  const backend = useHarnessBackend()
  const [state, setState] = useState<{
    backend: HarnessBackend
    path: string
    outcome: SrnAssetState
  }>()
  const usable = isSrnAssetPath(path) ? path : null

  useEffect(() => {
    if (!usable) return

    let cancelled = false
    let objectUrl: string | null = null
    loadAsset(usable, backend)
      .then((asset) => {
        if (cancelled) return
        objectUrl = createPetSpriteObjectUrl(asset)
        setState({
          backend,
          path: usable,
          outcome: { src: objectUrl, failed: false },
        })
      })
      .catch(() => {
        if (cancelled) return
        setState({
          backend,
          path: usable,
          outcome: { src: null, failed: true },
        })
      })

    return () => {
      cancelled = true
      if (objectUrl) revokePetSpriteObjectUrl(objectUrl)
    }
  }, [usable, backend])

  if (!usable) return path ? { src: null, failed: true } : NONE
  // Keyed by path: a row that now shows another publisher reports nothing
  // until that one's image arrives, rather than the previous one's.
  return state?.path === usable && state.backend === backend
    ? state.outcome
    : NONE
}

/** Test-only: drop the cached bytes so tests do not share them. */
export function __resetSrnAssetCacheForTests(): void {
  caches = new WeakMap()
}
