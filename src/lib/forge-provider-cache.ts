"use client"

import { useEffect, useState, useSyncExternalStore } from "react"
import { useBackendApi } from "@/contexts/backend-client-context"
import * as defaultApi from "@/lib/api"
import type { ForgeProviderId, ForgeRemote } from "@/lib/types"

/**
 * Each project folder's forge remote — its `origin`, as the backend reads it —
 * shared by the readers that only need to know where the folder lives: the aux
 * panel naming its change-request tab before it is ever opened (GitLab calls
 * them merge requests, GitHub and Gitea pull requests, as the repository panel
 * words its own switcher), and the task board deciding whether a reviewed
 * task can be delivered to a pull request at all.
 *
 * One lookup per folder per session by default, shared by every reader. A
 * folder whose remote is missing or unreadable is remembered as `null`, while
 * a lookup that FAILED is not remembered at all, so the next visit asks again.
 * The repository panel reports each remote it resolves here as well, which is
 * how a forge the backend corrects ("this host is a GitLab after all") reaches
 * every reader without a second lookup. A reader that acts on the answer can
 * ask for it to be re-read when it mounts (`revalidate`), keeping what is
 * known on screen meanwhile.
 */
type ForgeApi = Pick<typeof defaultApi, "folderForgeRemote">

function createCache() {
  const remotes = new Map<number, ForgeRemote | null>()
  const inFlight = new Set<number>()
  const listeners = new Set<() => void>()
  return {
    remotes,
    inFlight,
    listeners,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

const caches = new WeakMap<ForgeApi, ReturnType<typeof createCache>>()
function cacheFor(api: ForgeApi) {
  let cache = caches.get(api)
  if (!cache) {
    cache = createCache()
    caches.set(api, cache)
  }
  return cache
}

/** Whether two readings say the same thing about the folder — what decides
 *  whether readers have anything new to render. */
function sameRemote(a: ForgeRemote | null, b: ForgeRemote | null): boolean {
  if (a == null || b == null) return a === b
  return (
    a.provider === b.provider &&
    a.supported === b.supported &&
    a.server_host === b.server_host &&
    a.owner_repo === b.owner_repo &&
    a.remote_url === b.remote_url &&
    a.web_origin === b.web_origin
  )
}

/** Record the remote a folder resolved to (`null`: none readable). */
export function rememberForgeRemote(
  folderId: number,
  remote: ForgeRemote | null,
  api: ForgeApi = defaultApi
): void {
  const { remotes, listeners } = cacheFor(api)
  if (
    remotes.has(folderId) &&
    sameRemote(remotes.get(folderId) ?? null, remote)
  )
    return
  remotes.set(folderId, remote)
  for (const listener of listeners) listener()
}

function ensureForgeRemote(
  api: ForgeApi,
  folderId: number,
  revalidate: boolean
): void {
  const { remotes, inFlight } = cacheFor(api)
  if (inFlight.has(folderId)) return
  if (remotes.has(folderId) && !revalidate) return
  inFlight.add(folderId)
  api
    .folderForgeRemote(folderId)
    .then((remote) => rememberForgeRemote(folderId, remote, api))
    .catch(() => {
      // Left as it was rather than recorded: a transient failure must not pin
      // "no remote" (or the default wording) on a folder for the session.
    })
    .finally(() => {
      inFlight.delete(folderId)
    })
}

/**
 * `folderId`'s forge remote, or `null` while unknown and for a folder without
 * a readable remote. Looks it up on first use; with `revalidate`, also reads
 * it again whenever the reader mounts or the folder changes.
 */
export function useFolderForgeRemote(
  folderId: number | null,
  options?: { revalidate?: boolean }
): ForgeRemote | null {
  const api = useBackendApi()
  const { remotes, subscribe } = cacheFor(api)
  const revalidate = options?.revalidate === true
  const remote = useSyncExternalStore(
    subscribe,
    () => (folderId == null ? null : (remotes.get(folderId) ?? null)),
    () => null
  )
  useEffect(() => {
    if (folderId != null) ensureForgeRemote(api, folderId, revalidate)
  }, [api, folderId, revalidate])
  return remote
}

/**
 * The forge `folderId`'s remote lives on, or `null` while unknown and for a
 * folder without a readable remote. Looks it up on first use.
 */
export function useFolderForgeProvider(
  folderId: number | null
): ForgeProviderId | null {
  return useFolderForgeRemote(folderId)?.provider ?? null
}

/** What a fresh read of a folder's remote has come to. */
export type FreshForgeRemote =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; remote: ForgeRemote | null }
  | { status: "failed" }

/**
 * `folderId`'s forge remote as the backend reads it NOW — for a reader about to
 * act on it rather than to word something: a delivery resolves its target from
 * this same remote when it runs, so a remembered answer is not good enough to
 * show next to the button that sends it. Read on every mount and every change
 * of `folderId` (pass `null` in between to start over), never answered from
 * memory; a successful read is reported to every other reader as well.
 */
export function useFreshFolderForgeRemote(
  folderId: number | null
): FreshForgeRemote {
  const api = useBackendApi()
  const [read, setRead] = useState<{
    api: ForgeApi
    folderId: number
    result: FreshForgeRemote
  } | null>(null)
  useEffect(() => {
    // Whatever the previous read said belongs to the previous ask.
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setRead(null)
    if (folderId == null) return
    let cancelled = false
    api
      .folderForgeRemote(folderId)
      .then((remote) => {
        // A read overtaken by a newer ask is not reported either: answers
        // landing out of order must not leave the older one in the cache.
        if (cancelled) return
        rememberForgeRemote(folderId, remote, api)
        setRead({ api, folderId, result: { status: "ready", remote } })
      })
      .catch(() => {
        if (!cancelled) setRead({ api, folderId, result: { status: "failed" } })
      })
    return () => {
      cancelled = true
    }
  }, [api, folderId])
  if (folderId == null) return { status: "idle" }
  if (read == null || read.folderId !== folderId || read.api !== api) {
    return { status: "loading" }
  }
  return read.result
}

/** Test seam: forget every folder, so each test starts from no lookups. */
export function resetForgeProviderCacheForTests(): void {
  caches.delete(defaultApi)
}
