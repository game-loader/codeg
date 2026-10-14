"use client"

import { useCallback, useEffect, useSyncExternalStore } from "react"
import {
  useBackendApi,
  useBackendPlatform,
} from "@/contexts/backend-client-context"
import { defaultBackendPlatform } from "@/lib/backend/defaults"
import type { BackendApi, BackendPlatform } from "@/lib/backend/types"
import * as legacyBackendApi from "@/lib/api"
import { FEEDBACK_SETTINGS_CHANGED_EVENT } from "@/lib/types"
import type { FeedbackSettings } from "@/lib/api"

function createFeedbackCache(api: BackendApi) {
  let cached: boolean | null = null
  let inflight: Promise<void> | null = null
  let epoch = 0
  let saveGeneration = 0
  let readsStarted = 0
  let newestReadCommitted = 0
  let refs = 0
  let platform: BackendPlatform | undefined
  const listeners = new Set<() => void>()
  let stop: (() => void) | null = null

  const notify = () => {
    for (const listener of listeners) listener()
  }
  // Saves and broadcasts supersede reads, but a read must not invalidate a
  // later read. Keep these two orders independent within this fixed client.
  const apply = (enabled: boolean) => {
    saveGeneration += 1
    cached = enabled
    notify()
  }
  const beginRead = () => {
    const read = ++readsStarted
    const startGeneration = saveGeneration
    const startEpoch = epoch
    return (enabled: boolean) => {
      if (
        epoch !== startEpoch ||
        saveGeneration !== startGeneration ||
        read < newestReadCommitted
      ) {
        return
      }
      newestReadCommitted = read
      cached = enabled
      notify()
    }
  }
  const load = () => {
    if (inflight) return inflight
    const commit = beginRead()
    const request = api
      .getFeedbackSettings()
      .then((settings) => commit(settings.enabled))
      .catch(() => {
        if (cached === null) commit(false)
      })
      .finally(() => {
        if (inflight === request) inflight = null
      })
    inflight = request
    return request
  }

  const ensureSync = () => {
    if (stop || !platform) return
    let disposed = false
    let unlisten: (() => void) | undefined
    const offReconnect = platform.onTransportReconnect(() => {
      if (disposed) return
      // Reconnect reads may overlap. Only a save/broadcast or a newer read
      // that already committed can discard this answer.
      const commit = beginRead()
      void api
        .getFeedbackSettings()
        .then((settings) => commit(settings.enabled))
        .catch(() => {})
    })
    const cleanup = () => {
      disposed = true
      unlisten?.()
      offReconnect?.()
    }
    stop = cleanup
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
      .catch(() => {
        cleanup()
        // A later mount/save can retry after the transport becomes ready.
        if (stop === cleanup) stop = null
      })
  }

  const prime = (enabled: boolean, sourcePlatform?: BackendPlatform) => {
    platform = sourcePlatform ?? platform
    // Priming before any hook mounts must still follow later broadcasts.
    ensureSync()
    apply(enabled)
  }
  const acquire = (sourcePlatform: BackendPlatform) => {
    refs += 1
    platform = sourcePlatform
    ensureSync()
    if (cached === null) void load()
    let released = false
    return () => {
      if (released) return
      released = true
      refs -= 1
      if (refs === 0) {
        stop?.()
        stop = null
        epoch += 1
        inflight = null
        cached = null
      }
    }
  }
  return { prime, acquire, listeners, getSnapshot: () => cached ?? false }
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

/** A save only primes the fixed client's consumers. Pass its platform when
 *  priming before any consumer has mounted; standalone callers use the default. */
export function primeFeedbackEnabled(
  enabled: boolean,
  api: BackendApi = legacyBackendApi,
  platform?: BackendPlatform
): void {
  getCache(api).prime(
    enabled,
    platform ?? (api === legacyBackendApi ? defaultBackendPlatform : undefined)
  )
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
