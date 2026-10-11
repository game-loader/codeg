"use client"

import { useBackendApi } from "@/contexts/backend-client-context"
import type { BackendApi } from "@/lib/backend/types"
import * as legacyBackendApi from "@/lib/api"
import { useCallback, useEffect, useSyncExternalStore } from "react"
import type { AgentSkillItem, AgentType } from "@/lib/types"

const EMPTY: AgentSkillItem[] = []
interface Cache {
  values: Map<string, AgentSkillItem[]>
  inflight: Map<string, Promise<void>>
  listeners: Set<() => void>
}
const caches = new WeakMap<BackendApi, Cache>()
function getCache(api: BackendApi): Cache {
  let cache = caches.get(api)
  if (!cache) {
    cache = { values: new Map(), inflight: new Map(), listeners: new Set() }
    caches.set(api, cache)
  }
  return cache
}
function keyFor(agent: AgentType, path: string | null) {
  return JSON.stringify([agent, path])
}
function load(
  api: BackendApi,
  cache: Cache,
  agent: AgentType,
  path: string | null
) {
  const key = keyFor(agent, path)
  if (cache.values.has(key) || cache.inflight.has(key)) return
  const request = api
    .acpListAgentSkills({ agentType: agent, workspacePath: path })
    .then((result) => {
      // Invalidated/superseded requests cannot refill a stale entry.
      if (cache.inflight.get(key) !== request) return
      cache.values.set(key, result.supported ? result.skills : EMPTY)
      for (const notify of cache.listeners) notify()
    })
    .catch((err) => console.warn("[useAgentSkills] failed:", err))
    .finally(() => {
      if (cache.inflight.get(key) === request) cache.inflight.delete(key)
    })
  cache.inflight.set(key, request)
}
export function useAgentSkills(
  agent: AgentType | null,
  workspacePath?: string | null
): AgentSkillItem[] {
  const api = useBackendApi()
  const cache = getCache(api)
  const path = workspacePath ?? null
  const key = agent ? keyFor(agent, path) : null
  const skills = useSyncExternalStore(
    useCallback(
      (notify: () => void) => {
        cache.listeners.add(notify)
        return () => {
          cache.listeners.delete(notify)
        }
      },
      [cache]
    ),
    () => (key ? (cache.values.get(key) ?? EMPTY) : EMPTY),
    () => EMPTY
  )
  useEffect(() => {
    if (!agent || !key) return
    load(api, cache, agent, path)
    const onFocus = () => {
      cache.values.delete(key)
      cache.inflight.delete(key)
      load(api, cache, agent, path)
    }
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [api, cache, agent, path, key])
  return skills
}
export function invalidateAgentSkillsCache(
  agent?: AgentType,
  api: BackendApi = legacyBackendApi
): void {
  const cache = getCache(api)
  for (const key of new Set([
    ...cache.values.keys(),
    ...cache.inflight.keys(),
  ])) {
    if (!agent || (JSON.parse(key) as [string, string | null])[0] === agent) {
      cache.values.delete(key)
      cache.inflight.delete(key)
    }
  }
}
