"use client"

import { useEffect } from "react"

import { useHarnessView } from "@/contexts/harness-view-context"

import { type UnsubscribeFn } from "@/lib/transport"

import { reloadHarnessInstalled } from "./mcp-install-state"

/** A subscription that cannot be had (a transport without events) is no
 *  subscription; the listing is still read on every visit. */
function subscribeSafely(
  subscribe: () => Promise<UnsubscribeFn>
): Promise<UnsubscribeFn | null> {
  try {
    return subscribe().catch(() => null)
  } catch {
    return Promise.resolve(null)
  }
}

/**
 * Keep the host's listing of what is installed from Harness current while a
 * section that shows it is on screen: read once per visit, again on
 * `harness://installed-changed` (an install, an update, an uninstall,
 * anywhere), on `mcp://changed` (an edit can make an entry "changed here"),
 * on `skills://changed` (a skill's folder replaced or restored), and after
 * the event stream reconnects, since what it missed is lost.
 */
export function useHarnessInstalledSync(): void {
  const { slots } = useHarnessView()
  useEffect(() => {
    const reload = () => void reloadHarnessInstalled(slots)
    reload()
    let cancelled = false
    const stops: UnsubscribeFn[] = []
    for (const subscribed of [
      subscribeSafely(() =>
        slots.backend.mcpInstall.onHarnessInstalledChanged(reload)
      ),
      subscribeSafely(() => slots.backend.mcp.onMcpChanged(reload)),
      subscribeSafely(() => slots.backend.skills.onSkillsChanged(reload)),
    ]) {
      void subscribed.then((stop) => {
        if (!stop) return
        if (cancelled) stop()
        else stops.push(stop)
      })
    }
    let stopReconnect: UnsubscribeFn | undefined
    try {
      stopReconnect = slots.backend.getTransport().onReconnect?.(reload)
    } catch {
      // No reconnect hook: the next visit reads again.
    }
    return () => {
      cancelled = true
      for (const stop of stops) stop()
      stopReconnect?.()
    }
  }, [slots])
}
