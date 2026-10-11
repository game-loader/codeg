"use client"

import { useBackendApi } from "@/contexts/backend-client-context"
import type { BackendApi } from "@/lib/backend/types"
import { useCallback, useEffect, useSyncExternalStore } from "react"

import type { ScienceListItem } from "@/lib/types"

const EMPTY: ScienceListItem[] = []
interface Cache {
  snapshot: ScienceListItem[]
  inflight: Promise<void> | null
  listeners: Set<() => void>
}
const caches = new WeakMap<BackendApi, Cache>()
function getCache(api: BackendApi): Cache {
  let cache = caches.get(api)
  if (!cache) {
    cache = { snapshot: EMPTY, inflight: null, listeners: new Set() }
    caches.set(api, cache)
  }
  return cache
}
function load(api: BackendApi): void {
  const cache = getCache(api)
  if (cache.snapshot !== EMPTY || cache.inflight) return
  cache.inflight = api
    .scienceList()
    .then((list) => {
      cache.snapshot = list
      for (const notify of cache.listeners) notify()
    })
    .catch((err) => {
      console.warn("[useBuiltInScience] failed:", err)
    })
    .finally(() => {
      cache.inflight = null
    })
}
export function useBuiltInScience(): ScienceListItem[] {
  const api = useBackendApi()
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
    () => cache.snapshot,
    () => EMPTY
  )
  useEffect(() => load(api), [api])
  return snapshot
}
