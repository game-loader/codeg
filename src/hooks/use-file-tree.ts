"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { useBackendApi } from "@/contexts/backend-client-context"
import type { WorkspaceFileEntry } from "@/lib/types"
import { randomUUID } from "@/lib/utils"

export interface FlatFileEntry {
  name: string
  /** Relative path from folder root (same as WorkspaceFileEntry.path) */
  relativePath: string
  kind: "file" | "dir"
  /** Pre-computed lowercase relativePath for filtering */
  lowerPath: string
  /** Pre-computed lowercase name for filtering */
  lowerName: string
}

interface UseFileTreeOptions {
  folderPath: string | undefined
  enabled: boolean
  query: string
  limit?: number
  filesOnly?: boolean
}

interface UseFileTreeResult {
  allFiles: FlatFileEntry[]
  loading: boolean
  loaded: boolean
  /** Discard local results; an explicit refresh also invalidates native data. */
  reset: (refreshIndex?: boolean) => void
}

/**
 * Keep only the current query's bounded matches in the renderer. Discovery,
 * indexing and ranking are shared in the backend, with a native cache budget.
 */
export function useFileTree({
  folderPath,
  enabled,
  query,
  limit = 100,
  filesOnly = false,
}: UseFileTreeOptions): UseFileTreeResult {
  const backendApi = useBackendApi()
  const [allFiles, setAllFiles] = useState<FlatFileEntry[]>([])
  const [loading, setLoading] = useState(false)
  // State, not a ref: `loaded` is returned from render, so it must re-render
  // when it changes rather than be read off a ref.
  const [loadedScope, setLoadedScope] = useState<{
    pathKey: string
    api: typeof backendApi
  } | null>(null)
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  const refresh = useRef(false)
  // Set when a refresh was requested and the picker is next enabled: every
  // query until the next reset then needs a native snapshot built since that
  // moment. A window (not a per-request flag) lets later keystrokes reuse the
  // snapshot the first one built, even if that first response was aborted.
  const freshSince = useRef<number | null>(null)
  const consumer = useRef<string | undefined>(undefined)

  // Results for the previous keystroke stay visible (callers re-rank them
  // against the new query) until the new response lands, so typing does not
  // blank the list. Only a different workspace or result shape clears them.
  const scopeRef = useRef<{ pathKey: string; api: typeof backendApi } | null>(
    null
  )
  const pathKey = [enabled, folderPath, filesOnly].join("\0")

  useEffect(() => {
    const current = ++generation.current
    // The synchronous resets and loading flag belong to the search request
    // issued below (an external system), keyed by the scope ref.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (
      scopeRef.current?.pathKey !== pathKey ||
      scopeRef.current.api !== backendApi
    ) {
      scopeRef.current = { pathKey, api: backendApi }
      setLoadedScope(null)
      setAllFiles([])
    }
    if (!enabled || !folderPath) {
      setLoading(false)
      return
    }
    let canceled = false
    const abort = new AbortController()
    setLoading(true)
    /* eslint-enable react-hooks/set-state-in-effect */
    if (refresh.current) {
      refresh.current = false
      freshSince.current = performance.now()
    }
    const since = freshSince.current

    async function load() {
      try {
        const files: WorkspaceFileEntry[] =
          await backendApi.searchWorkspaceFiles(folderPath!, query, {
            limit,
            filesOnly,
            refresh: false,
            ...(since === null
              ? {}
              : {
                  maxAgeMs: Math.max(0, Math.floor(performance.now() - since)),
                }),
            request: {
              consumerId: (consumer.current ??= randomUUID()),
              generation: current,
            },
            signal: abort.signal,
          })
        if (canceled || generation.current !== current) return
        const flat: FlatFileEntry[] = files.map((f) => ({
          name: f.name,
          relativePath: f.path,
          kind: f.kind,
          lowerPath: f.path.toLowerCase(),
          lowerName: f.name.toLowerCase(),
        }))

        if (!canceled && generation.current === current) {
          setAllFiles(flat)
          setLoadedScope({ pathKey, api: backendApi })
        }
      } catch {
        if (!canceled && generation.current === current) setAllFiles([])
      } finally {
        if (!canceled && generation.current === current) setLoading(false)
      }
    }

    const timer = setTimeout(() => void load(), query.trim() ? 150 : 0)
    return () => {
      canceled = true
      abort.abort()
      clearTimeout(timer)
    }
  }, [
    backendApi,
    pathKey,
    enabled,
    folderPath,
    query,
    limit,
    filesOnly,
    revision,
  ])

  const reset = useCallback((refreshIndex = false) => {
    setLoadedScope(null)
    scopeRef.current = null
    generation.current += 1
    if (refreshIndex) {
      refresh.current = true
      freshSince.current = null
    }
    setAllFiles([])
    setRevision((value) => value + 1)
  }, [])

  const currentScope =
    loadedScope?.pathKey === pathKey && loadedScope.api === backendApi
  return {
    allFiles: currentScope ? allFiles : [],
    loading,
    loaded: currentScope,
    reset,
  }
}
