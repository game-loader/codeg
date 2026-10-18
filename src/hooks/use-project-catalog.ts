"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  getBackendClient,
  normalizeBaseUrl,
  remoteBackendKey,
} from "@/lib/backend-client"
import { isDesktop } from "@/lib/platform"
import {
  buildProjectCatalog,
  loadBackendCatalogSnapshot,
  mergeCatalogRound,
  sidebarProjectView,
  type BackendCatalogSnapshot,
  type CatalogBinding,
  type CatalogEntry,
  type SidebarProjectView,
} from "@/lib/project-catalog"
import type { BackendKey } from "@/lib/project-identity"
import { listRemoteWorkspaceConnections } from "@/lib/remote-workspace"
import type { RemoteWorkspaceConnection } from "@/lib/types"

const EMPTY_VIEW: SidebarProjectView = {
  otherMachinesByFolderId: new Map(),
  elsewhereProjects: [],
}

// Focus refreshes are cheap per machine but fan out to every connection;
// don't redo them on every alt-tab.
const FOCUS_REFRESH_MIN_INTERVAL_MS = 30_000

const refreshListeners = new Set<() => void>()

/**
 * Ask every mounted catalog to re-read now. For changes this window made on
 * another machine (opening a folder there, say), which no event from this
 * window's own backend would report.
 */
export function requestProjectCatalogRefresh(): void {
  for (const listener of refreshListeners) listener()
}

/**
 * Cross-machine project catalog for a local desktop window's sidebar.
 *
 * Interim, read-only: the window keeps rendering its own folders from the
 * workspace store, and only learns (a) which other saved machines share each
 * folder's project and (b) which projects live only on other machines.
 * Acting on another machine still happens in that machine's own window.
 *
 * Disabled (empty view) on the web and in remote-desktop windows, which have
 * no view of the local machine's saved connections.
 *
 * `folderSignature` should change whenever this window's folder set does, so
 * a newly opened folder is attributed without waiting for a focus refresh.
 */
export function useProjectCatalog({
  enabled,
  folderSignature,
}: {
  enabled: boolean
  folderSignature: string
}) {
  const active = enabled && isDesktop()
  const [connections, setConnections] = useState<RemoteWorkspaceConnection[]>(
    []
  )
  const [snapshots, setSnapshots] = useState<BackendCatalogSnapshot[]>([])
  // Last good snapshot per machine, with the address it was read at: an
  // offline machine keeps showing what it had, unless its connection now
  // points at another server (see `mergeCatalogRound`).
  const lastGood = useRef(new Map<BackendKey, CatalogEntry>())
  const generation = useRef(0)
  const lastFocusRefresh = useRef(0)

  const refresh = useCallback(async () => {
    if (!active) return
    const gen = ++generation.current
    let saved: RemoteWorkspaceConnection[]
    try {
      saved = await listRemoteWorkspaceConnections()
    } catch {
      return
    }
    const bindings: CatalogBinding[] = [
      { backendKey: "local", baseUrl: null },
      ...saved.map((c) => ({
        backendKey: remoteBackendKey(c.id),
        baseUrl: normalizeBaseUrl(c.base_url),
      })),
    ]
    const results = await Promise.allSettled(
      bindings.map((b) =>
        loadBackendCatalogSnapshot(getBackendClient(b.backendKey))
      )
    )
    if (gen !== generation.current) return

    const next = mergeCatalogRound(lastGood.current, bindings, results)
    lastGood.current = next
    setConnections(saved)
    setSnapshots(
      bindings.flatMap((b) => next.get(b.backendKey)?.snapshot ?? [])
    )
  }, [active])

  useEffect(() => {
    if (!active) return
    const listener = () => void refresh()
    refreshListeners.add(listener)
    return () => {
      refreshListeners.delete(listener)
    }
  }, [active, refresh])

  useEffect(() => {
    if (!active) return
    // State is only set after the backend reads resolve: this syncs with
    // external machines, not a cascade of synchronous renders.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [active, refresh, folderSignature])

  useEffect(() => {
    if (!active) return
    const onFocus = () => {
      const now = Date.now()
      if (now - lastFocusRefresh.current < FOCUS_REFRESH_MIN_INTERVAL_MS) {
        return
      }
      lastFocusRefresh.current = now
      void refresh()
    }
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [active, refresh])

  const view = useMemo(
    () =>
      active
        ? sidebarProjectView(buildProjectCatalog(snapshots), "local")
        : EMPTY_VIEW,
    [active, snapshots]
  )

  const machineNames = useMemo(() => {
    const names = new Map<BackendKey, string>()
    for (const c of connections) names.set(remoteBackendKey(c.id), c.name)
    return names
  }, [connections])

  return { view, machineNames, refresh }
}
