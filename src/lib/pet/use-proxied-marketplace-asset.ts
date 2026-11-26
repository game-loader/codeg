import { useBackendPlatform } from "@/contexts/backend-client-context"
import type { BackendPlatform } from "@/lib/backend/types"
import { defaultBackendPlatform as legacyBackendPlatform } from "@/lib/backend/defaults"
import { useEffect, useState } from "react"
import { fetchMarketplaceAsset } from "./api"
import {
  createPetSpriteObjectUrl,
  revokePetSpriteObjectUrl,
} from "./sprite-url"
import type { PetSpriteAsset } from "./types"

// Keep up to two pages of recent posters, subject to a payload budget so a
// few large previews cannot stay resident with every previously viewed page.
const MAX_CACHED_ASSETS = 64
const MAX_CACHED_BYTES = 16 * 1024 * 1024
function newCache() {
  return {
    assetCache: new Map<string, { asset: PetSpriteAsset; bytes: number }>(),
    pendingAssets: new Map<string, Promise<PetSpriteAsset>>(),
    bytes: 0,
  }
}
let caches = new WeakMap<BackendPlatform, ReturnType<typeof newCache>>()

function rememberAsset(
  cache: ReturnType<typeof newCache>,
  url: string,
  asset: PetSpriteAsset
): void {
  const { assetCache } = cache
  // Charge strings at two bytes per code unit regardless of engine encoding.
  const bytes = 2 * (url.length + asset.mime.length + asset.dataBase64.length)
  if (bytes > MAX_CACHED_BYTES) return

  assetCache.set(url, { asset, bytes })
  cache.bytes += bytes
  for (const [oldUrl, entry] of assetCache) {
    if (
      assetCache.size <= MAX_CACHED_ASSETS &&
      cache.bytes <= MAX_CACHED_BYTES
    ) {
      break
    }
    assetCache.delete(oldUrl)
    cache.bytes -= entry.bytes
  }
}

function loadAsset(
  url: string,
  backendPlatform: BackendPlatform = legacyBackendPlatform
): Promise<PetSpriteAsset> {
  const cache = caches.get(backendPlatform) ?? newCache()
  caches.set(backendPlatform, cache)
  const { assetCache, pendingAssets } = cache
  const cached = assetCache.get(url)
  if (cached) {
    assetCache.delete(url)
    assetCache.set(url, cached)
    return Promise.resolve(cached.asset)
  }
  const pending = pendingAssets.get(url)
  if (pending) return pending

  // Deduplicate active fetches independently of cache eviction. Failures are
  // retryable, and even an oversized asset is returned to current consumers.
  const request: Promise<PetSpriteAsset> = fetchMarketplaceAsset(
    url,
    backendPlatform
  )
    .then((asset) => {
      if (pendingAssets.get(url) === request) rememberAsset(cache, url, asset)
      return asset
    })
    .finally(() => {
      if (pendingAssets.get(url) === request) pendingAssets.delete(url)
    })
  pendingAssets.set(url, request)
  return request
}

export interface ProxiedAsset {
  /** Blob URL for the proxied image, or `null` while loading / on failure. */
  src: string | null
  loading: boolean
  failed: boolean
}

interface Outcome {
  src: string | null
  failed: boolean
}

/**
 * Resolve a codex-pets.net image URL to a locally-served blob URL by proxying
 * the bytes through the backend (`pet_marketplace_asset`). The desktop webview
 * can't reach the CDN directly on some networks; the backend can, so this keeps
 * marketplace posters / previews rendering wherever the listing loads.
 *
 * Keyed by URL: a render where `url` just changed reports `loading` until the new
 * asset resolves rather than briefly showing the previous pet's image (mirrors
 * `useImageNaturalSize`). State is only ever written from the async callbacks,
 * never synchronously in the effect body. The blob URL is minted per consumer
 * and revoked in cleanup, so it is owned exclusively by this hook instance.
 */
export function useProxiedMarketplaceAsset(
  url: string | null | undefined
): ProxiedAsset {
  const backendPlatform = useBackendPlatform()

  const [state, setState] = useState<{
    backendPlatform?: BackendPlatform
    url: string | null
    outcome: Outcome
  }>(() => ({ url: null, outcome: { src: null, failed: false } }))

  useEffect(() => {
    if (!url) return

    let cancelled = false
    let objectUrl: string | null = null
    loadAsset(url, backendPlatform)
      .then((asset) => {
        if (cancelled) return
        objectUrl = createPetSpriteObjectUrl(asset)
        setState({
          backendPlatform,
          url,
          outcome: { src: objectUrl, failed: false },
        })
      })
      .catch(() => {
        if (cancelled) return
        setState({ backendPlatform, url, outcome: { src: null, failed: true } })
      })

    return () => {
      cancelled = true
      // This consumer minted `objectUrl` for itself; revoking it here can never
      // blank another mounted consumer (each minted its own from the shared
      // asset). If cleanup runs before the fetch settles, `cancelled` short-
      // circuits the `.then` so no orphan blob is ever created.
      if (objectUrl) revokePetSpriteObjectUrl(objectUrl)
    }
  }, [url, backendPlatform])

  if (!url) return { src: null, loading: false, failed: false }
  if (state.url === url && state.backendPlatform === backendPlatform) {
    return {
      src: state.outcome.src,
      loading: false,
      failed: state.outcome.failed,
    }
  }
  // `url` changed and the effect hasn't resolved the new one yet.
  return { src: null, loading: true, failed: false }
}

/** Test-only: drop cached asset data so module state doesn't leak across tests. */
export function __resetMarketplaceAssetCacheForTests(): void {
  caches = new WeakMap()
}
