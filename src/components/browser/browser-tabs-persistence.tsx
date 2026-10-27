"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useOptionalBackendClient } from "@/contexts/backend-client-context"
import type { BackendClient } from "@/lib/backend/types"

import {
  useWorkspaceActions,
  useWorkspaceFileTabs,
} from "@/contexts/workspace-context"
import { browserCapabilities } from "@/lib/browser/browser-api"
import { browserDeviceKey } from "@/lib/browser/browser-device"
import {
  DEFAULT_BROWSER_PROFILE_ID,
  browserProfileExists,
  getBrowserPrefs,
} from "@/lib/browser/browser-prefs"
import {
  readPersistedBrowserTabs,
  browserTabsStorageKey,
  samePersistedBrowserTabs,
  snapshotBrowserTabs,
  writePersistedBrowserTabs,
  type PersistedBrowserTab,
} from "@/lib/browser/browser-tab-persistence"
import {
  getBrowserTabState,
  subscribeBrowserTabs,
} from "@/lib/browser/browser-tab-store"
import { getCurrentWindowLabel } from "@/lib/browser/window-label"

/** Coalesces a burst of changes (a page load moves URL and title in two
 *  events) into one localStorage write. */
const SAVE_DEBOUNCE_MS = 400

// Window labels this document already restored for. Guards the StrictMode
// double effect and a re-mount of the workspace providers within one
// document; a new document (reload, relaunch) starts empty and restores.
const restoredWindows = new Set<string>()
// A new client is a new runtime generation with new tab records. It must
// restore again; StrictMode and remounts of the same generation must not.
let restoredClients = new WeakMap<BackendClient, Set<string>>()

/** Tests only. */
export function resetBrowserTabsPersistenceForTests(): void {
  restoredWindows.clear()
  restoredClients = new WeakMap()
}

/**
 * Keeps the browser tabs of this window in localStorage and brings them back
 * on the next run. Mounted once inside the workspace providers, next to the
 * events bridge; renders nothing.
 *
 * Order matters at startup: nothing is written until the restore has run,
 * or the empty strip of a fresh document would wipe what the last run saved.
 * Only where a built-in browser exists — in web mode there are no browser
 * tabs and the stored list (from a desktop run against the same origin,
 * unlikely but possible) is left alone.
 */
export function BrowserTabsPersistence() {
  const client = useOptionalBackendClient()
  const { restoreBrowserTabs } = useWorkspaceActions()
  const { fileTabs } = useWorkspaceFileTabs()
  const scope = client ?? "standalone"
  const label = getCurrentWindowLabel()
  const key = browserTabsStorageKey(label, client?.key)
  const [readyScope, setReadyScope] = useState<typeof scope | null>(null)
  // Latest-state mirror for the timers below (synced post-commit, like the
  // workspace provider does for its own action callbacks).
  const fileTabsRef = useRef({ scope, fileTabs })
  useEffect(() => {
    fileTabsRef.current = { scope, fileTabs }
  }, [scope, fileTabs])
  const lastWrittenRef = useRef<{
    scope: typeof scope
    tabs: PersistedBrowserTab[]
  } | null>(null)

  // Restore once per runtime generation (or standalone document), then write.
  useEffect(() => {
    let cancelled = false
    void browserCapabilities().then((caps) => {
      if (cancelled || !caps.available) return
      let restored = restoredWindows
      if (client) {
        restored = restoredClients.get(client) ?? new Set<string>()
        restoredClients.set(client, restored)
      }
      if (!restored.has(key)) {
        const entries = readPersistedBrowserTabs(label, client?.key)
        lastWrittenRef.current = { scope, tabs: entries }
        // A profile deleted since the last run has no store any more; its
        // tabs come back in the default one rather than not at all.
        const prefs = getBrowserPrefs()
        const restorable = entries.map((entry) =>
          browserProfileExists(prefs, entry.profile)
            ? entry
            : { ...entry, profile: DEFAULT_BROWSER_PROFILE_ID }
        )
        if (restorable.length > 0) restoreBrowserTabs(restorable)
        restored.add(key)
      }
      setReadyScope(scope)
    })
    return () => {
      cancelled = true
    }
  }, [restoreBrowserTabs, client, key, label, scope])

  // What the strip looks like as far as persistence is concerned: browser
  // records, their order, and the fields a record itself carries. File tab
  // churn (keystrokes, reloads) does not change this string, so it does not
  // schedule a write.
  const signature = useMemo(
    () =>
      fileTabs
        .filter((tab) => tab.kind === "browser")
        .map(
          (tab) =>
            `${tab.id}\u0000${tab.browser.profile}\u0000${tab.browser.initialUrl}\u0000${tab.title}\u0000${browserDeviceKey(tab.browser.device)}`
        )
        .join("\u0001"),
    [fileTabs]
  )

  useEffect(() => {
    if (readyScope !== scope) return
    let timer: number | null = null
    const save = () => {
      if (fileTabsRef.current.scope !== scope) return
      const snapshot = snapshotBrowserTabs(
        fileTabsRef.current.fileTabs,
        getBrowserTabState
      )
      if (
        lastWrittenRef.current &&
        lastWrittenRef.current.scope === scope &&
        samePersistedBrowserTabs(lastWrittenRef.current.tabs, snapshot)
      ) {
        return
      }
      lastWrittenRef.current = { scope, tabs: snapshot }
      writePersistedBrowserTabs(snapshot, label, client?.key)
    }
    const schedule = () => {
      if (timer !== null) return
      timer = window.setTimeout(() => {
        timer = null
        save()
      }, SAVE_DEBOUNCE_MS)
    }
    const flush = () => {
      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
      save()
    }
    schedule()
    // Live URL / title changes arrive through the tab store, not the records.
    const unsubscribe = subscribeBrowserTabs(schedule)
    window.addEventListener("pagehide", flush)
    return () => {
      unsubscribe()
      window.removeEventListener("pagehide", flush)
      // A pending write must not be lost to a re-run (signature change) or
      // an unmount; the refs hold the latest inputs either way.
      flush()
    }
  }, [readyScope, scope, signature, label, client])

  return null
}
