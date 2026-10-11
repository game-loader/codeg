"use client"

import { useCallback, useEffect, useSyncExternalStore } from "react"
import {
  useBackendApi,
  useBackendPlatform,
} from "@/contexts/backend-client-context"
import type { BackendApi, BackendPlatform } from "@/lib/backend/types"
import * as legacyBackendApi from "@/lib/api"
import { FEEDBACK_SETTINGS_CHANGED_EVENT } from "@/lib/types"
import type { FeedbackSettings } from "@/lib/api"

function createFeedbackCache(api: BackendApi) {
  let cached: boolean | null = null
  let inflight: Promise<void> | null = null
  let generation = 0
  let refs = 0
  const listeners = new Set<() => void>()
  let stop: (() => void) | null = null
  const apply = (enabled: boolean) => {
    generation += 1
    cached = enabled
    for (const notify of listeners) notify()
  }
  const load = () => {
    if (inflight) return inflight
    const epoch = generation
    const request = api
      .getFeedbackSettings()
      .then((settings) => {
        if (epoch === generation) apply(settings.enabled)
      })
      .catch(() => {
        if (epoch === generation && cached === null) apply(false)
      })
      .finally(() => {
        if (inflight === request) inflight = null
      })
    inflight = request
    return request
  }
  const acquire = (platform: BackendPlatform) => {
    refs += 1
    if (refs === 1) {
      let disposed = false
      let unlisten: (() => void) | undefined
      void platform
        .subscribe<FeedbackSettings>(
          FEEDBACK_SETTINGS_CHANGED_EVENT,
          (settings) => {
            if (!disposed) apply(settings.enabled)
          }
        )
        .then((dispose) => {
          if (disposed) dispose()
          else unlisten = dispose
        })
        .catch(() => {})
      const offReconnect = platform.onTransportReconnect(() => {
        if (disposed) return
        generation += 1
        inflight = null
        void load()
      })
      stop = () => {
        disposed = true
        unlisten?.()
        offReconnect?.()
      }
    }
    if (cached === null) void load()
    let released = false
    return () => {
      if (released) return
      released = true
      refs -= 1
      if (refs === 0) {
        stop?.()
        stop = null
        generation += 1
        inflight = null
        cached = null
      }
    }
  }
  return { apply, acquire, listeners, getSnapshot: () => cached ?? false }
}
const caches = new WeakMap<BackendApi, ReturnType<typeof createFeedbackCache>>()
function getCache(api: BackendApi) {
  let cache = caches.get(api)
  if (!cache) {
    cache = createFeedbackCache(api)
    caches.set(api, cache)
  }
  return cache
}

/** A save only primes the fixed client's mounted consumers. */
export function primeFeedbackEnabled(
  enabled: boolean,
  api: BackendApi = legacyBackendApi
): void {
  getCache(api).apply(enabled)
}
export function useFeedbackEnabled(): boolean {
  const api = useBackendApi()
  const platform = useBackendPlatform()
  const cache = getCache(api)
  const snapshot = useSyncExternalStore(
    useCallback(
      (notify: () => void) => {
        cache.listeners.add(notify)
        return () => {
          cache.listeners.delete(notify)
        }
      },
      [cache]
    ),
    cache.getSnapshot,
    () => false
  )
  useEffect(() => cache.acquire(platform), [cache, platform])
  return snapshot
}
