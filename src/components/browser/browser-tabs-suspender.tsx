"use client"

import { useEffect, useRef } from "react"
import { useOptionalBackendClient } from "@/contexts/backend-client-context"

import {
  useWorkspaceActions,
  useWorkspaceFileTabs,
} from "@/contexts/workspace-context"
import { useBrowserPrefs } from "@/lib/browser/browser-prefs"
import {
  BROWSER_TAB_SUSPEND_AFTER_MS,
  selectBrowserTabsToSuspend,
} from "@/lib/browser/browser-tab-persistence"
import {
  browserTabHiddenAt,
  getBrowserTabState,
} from "@/lib/browser/browser-tab-store"
import { isDesktop } from "@/lib/transport"
import { nativeBrowserBackendKey } from "@/lib/browser/browser-runtime-scope"
import { browserTabBackendId } from "@/lib/file-tab-id"

/** How often the background tabs are checked against the idle threshold; a
 *  page is never released to the minute, so a coarse tick is enough. */
export const SUSPEND_POLL_MS = 60 * 1000

/**
 * The optional background unload (settings → built-in browser): a browser
 * tab that has been off screen for `BROWSER_TAB_SUSPEND_AFTER_MS` has its
 * native surface released; the record stays, on the page the tab was
 * showing, and loads again when the tab is next switched to. Off by default.
 * Renders nothing; mounted next to the events bridge.
 */
export function BrowserTabsSuspender() {
  const client = useOptionalBackendClient()
  const { suspendBackgroundTabs } = useBrowserPrefs()
  const { suspendBrowserTab } = useWorkspaceActions()
  const { fileTabs } = useWorkspaceFileTabs()
  // Latest-state mirror for the timers below (synced post-commit, like the
  // workspace provider does for its own action callbacks).
  const fileTabsRef = useRef(fileTabs)
  useEffect(() => {
    fileTabsRef.current = fileTabs
  }, [fileTabs])

  useEffect(() => {
    if (!suspendBackgroundTabs || !isDesktop()) return
    const tick = () => {
      const candidates = fileTabsRef.current.flatMap((tab) => {
        if (tab.kind !== "browser") return []
        const state = getBrowserTabState(tab.id)
        // A tab record is already runtime-bound, including public pages in
        // ordinary profiles. Explicit native connection identity must agree.
        if (
          client &&
          state &&
          (state.hostConnectionId != null ||
            state.profile?.startsWith("remote-")) &&
          nativeBrowserBackendKey(state, browserTabBackendId(tab.id)) !==
            client.key
        ) {
          return []
        }
        return [
          {
            id: tab.id,
            hiddenAt: browserTabHiddenAt(tab.id),
            loaded: state !== null,
          },
        ]
      })
      for (const id of selectBrowserTabsToSuspend(
        candidates,
        Date.now(),
        BROWSER_TAB_SUSPEND_AFTER_MS
      )) {
        suspendBrowserTab(id)
      }
    }
    const timer = window.setInterval(tick, SUSPEND_POLL_MS)
    return () => window.clearInterval(timer)
  }, [suspendBackgroundTabs, suspendBrowserTab, client])

  return null
}
