// Thin transport wrappers over the computer-use commands.
//
// Two kinds: the settings record, which every runtime serves (it is one
// setting in one database), and everything about the screen itself — status,
// permissions, the window list, sharing — which exists where computer use is
// served: the desktop app, for the machine it runs on, and a codeg-server its
// operator has let share the screen it runs on (`CODEG_COMPUTER_USE`), for
// its web clients. Whether this window has it is `computerAvailable`.

import { useBackendPlatform } from "@/contexts/backend-client-context"
import type { BackendPlatform } from "@/lib/backend/types"
import { defaultBackendPlatform as legacyBackendPlatform } from "@/lib/backend/defaults"
import { useCallback, useEffect, useSyncExternalStore } from "react"

import type {
  ComputerDelivery,
  ComputerStatePayload,
  ComputerStatus,
  ComputerToolsSettings,
  DriverInfo,
  OsPermission,
  PermissionRequestResult,
  PickerWindow,
  ShareManyResult,
  SharedWindow,
  GrantLevel,
  StopKeyStatus,
} from "./types"

export async function getComputerToolsSettings(
  backendPlatform: BackendPlatform = legacyBackendPlatform
): Promise<ComputerToolsSettings> {
  return backendPlatform.getTransport().call("get_computer_tools_settings")
}

/** Move only the group switch. */
export async function setComputerToolsEnabled(
  enabled: boolean,
  backendPlatform: BackendPlatform = legacyBackendPlatform
): Promise<ComputerToolsSettings> {
  return backendPlatform
    .getTransport()
    .call("set_computer_tools_enabled", { enabled })
}

/** Move the grant timeout, the blocklist, the stop shortcut, the strip,
 *  whether a window may come to the front and how an action goes by
 *  default — only what is given; the rest of the record (the switch
 *  included) stays as it is stored. */
export async function setComputerToolsPreferences(
  preferences: {
    grantTtlMinutes?: number
    blocklist?: string[]
    /** Keys of the default entries to leave off the list. */
    blocklistRemoved?: string[]
    /** Empty switches the shortcut off. */
    stopShortcut?: string
    showIndicator?: boolean
    allowForeground?: boolean
    defaultDelivery?: ComputerDelivery
    launchEnabled?: boolean
    clipboardEnabled?: boolean
    screenEnabled?: boolean
  },
  backendPlatform: BackendPlatform = legacyBackendPlatform
): Promise<ComputerToolsSettings> {
  return backendPlatform
    .getTransport()
    .call("set_computer_tools_preferences", preferences)
}

/** What a server says of computer use (`computer_available`). */
export interface ComputerServed {
  /** It shares the screen it runs on with its web clients. */
  available: boolean
  /** The machine whose screen that is. */
  platform: "macos" | "windows" | "linux"
}

interface ServedCache {
  served: ComputerServed | null
  asking: Promise<boolean> | null
  askAgain: boolean
  reconnectsWatched: boolean
  listeners: Set<() => void>
}
let servedCaches = new WeakMap<BackendPlatform, ServedCache>()
function servedCache(platform: BackendPlatform): ServedCache {
  let cache = servedCaches.get(platform)
  if (!cache) {
    cache = {
      served: null,
      asking: null,
      askAgain: false,
      reconnectsWatched: false,
      listeners: new Set(),
    }
    servedCaches.set(platform, cache)
  }
  return cache
}

export function computerAvailable(
  backendPlatform: BackendPlatform = legacyBackendPlatform
): boolean {
  return (
    backendPlatform.isLocalDesktop() ||
    servedCache(backendPlatform).served?.available === true
  )
}

export function computerServerPlatform(
  backendPlatform: BackendPlatform = legacyBackendPlatform
): ComputerServed["platform"] | null {
  return backendPlatform.isLocalDesktop()
    ? null
    : (servedCache(backendPlatform).served?.platform ?? null)
}

export function askComputerServed(
  backendPlatform: BackendPlatform = legacyBackendPlatform
): Promise<boolean> {
  if (backendPlatform.isLocalDesktop()) return Promise.resolve(true)
  const cache = servedCache(backendPlatform)
  if (cache.served !== null) return Promise.resolve(cache.served.available)
  return ask(backendPlatform)
}

function ask(backendPlatform: BackendPlatform): Promise<boolean> {
  const cache = servedCache(backendPlatform)
  watchReconnects(backendPlatform)
  if (cache.asking) return cache.asking
  cache.asking = backendPlatform
    .getTransport()
    .call<ComputerServed>("computer_available", {})
    .then(
      (answer) => {
        const changed =
          cache.served?.available !== answer.available ||
          cache.served?.platform !== answer.platform
        cache.served = answer
        if (changed) for (const listener of cache.listeners) listener()
        return answer.available
      },
      () => cache.served?.available ?? false
    )
    .finally(() => {
      cache.asking = null
      if (cache.askAgain) {
        cache.askAgain = false
        void ask(backendPlatform)
      }
    })
  return cache.asking
}

function watchReconnects(backendPlatform: BackendPlatform) {
  const cache = servedCache(backendPlatform)
  if (cache.reconnectsWatched) return
  cache.reconnectsWatched = true
  backendPlatform.onTransportReconnect(() => {
    if (cache.asking) cache.askAgain = true
    else void ask(backendPlatform)
  })
}

export function subscribeComputerServed(
  listener: () => void,
  backendPlatform: BackendPlatform = legacyBackendPlatform
): () => void {
  const cache = servedCache(backendPlatform)
  cache.listeners.add(listener)
  return () => cache.listeners.delete(listener)
}

export function useComputerAvailable(): boolean {
  const backendPlatform = useBackendPlatform()
  const subscribe = useCallback(
    (listener: () => void) =>
      subscribeComputerServed(listener, backendPlatform),
    [backendPlatform]
  )
  const snapshot = useCallback(
    () => computerAvailable(backendPlatform),
    [backendPlatform]
  )
  const available = useSyncExternalStore(subscribe, snapshot, snapshot)
  useEffect(() => {
    if (!available) void askComputerServed(backendPlatform)
  }, [available, backendPlatform])
  return available
}

/** Tests only. */
export function resetComputerServedForTest(
  answer: ComputerServed | null = null
) {
  servedCaches = new WeakMap()
  servedCache(legacyBackendPlatform).served = answer
}

export async function computerStatus(
  backendPlatform: BackendPlatform = legacyBackendPlatform
): Promise<ComputerStatus> {
  return backendPlatform.getTransport().call("computer_status", {})
}

/** The shared windows: codeg's own state, with no helper to start — cheap
 *  enough to ask for when a window loads. */
export async function computerSharedState(
  backendPlatform: BackendPlatform = legacyBackendPlatform
): Promise<ComputerStatePayload> {
  return backendPlatform.getTransport().call("computer_shared_state", {})
}

/** Ask macOS for this one permission, from a helper started for the
 *  purpose, and say where that leaves things. */
export async function computerRequestPermission(
  permission: OsPermission,
  backendPlatform: BackendPlatform = legacyBackendPlatform
): Promise<PermissionRequestResult> {
  return backendPlatform
    .getTransport()
    .call("computer_request_permission", { permission })
}

export async function computerOpenPermissionSettings(
  permission: OsPermission,
  backendPlatform: BackendPlatform = legacyBackendPlatform
): Promise<void> {
  return backendPlatform
    .getTransport()
    .call("computer_open_permission_settings", {
      permission,
    })
}

/** Show codeg-computer-helper in the Finder, to drag into System Settings. */
export async function computerRevealHelper(
  backendPlatform: BackendPlatform = legacyBackendPlatform
): Promise<void> {
  return backendPlatform.getTransport().call("computer_reveal_helper", {})
}

export async function computerListShareableWindows(
  backendPlatform: BackendPlatform = legacyBackendPlatform
): Promise<PickerWindow[]> {
  return backendPlatform
    .getTransport()
    .call("computer_list_shareable_windows", {})
}

/** A `data:` URL, or null when there is none to show. */
export async function computerWindowThumbnail(
  targetId: string,
  backendPlatform: BackendPlatform = legacyBackendPlatform
): Promise<string | null> {
  return backendPlatform
    .getTransport()
    .call("computer_window_thumbnail", { targetId })
}

export async function computerShareWindow(
  targetId: string,
  level: GrantLevel,
  backendPlatform: BackendPlatform = legacyBackendPlatform
): Promise<SharedWindow[]> {
  return backendPlatform
    .getTransport()
    .call("computer_share_window", { targetId, level })
}

/** Share every window named at one level — each as
 *  {@link computerShareWindow} would, skipping those that cannot be. */
export async function computerShareWindows(
  targetIds: string[],
  level: GrantLevel,
  backendPlatform: BackendPlatform = legacyBackendPlatform
): Promise<ShareManyResult> {
  return backendPlatform
    .getTransport()
    .call("computer_share_windows", { targetIds, level })
}

/** Share an application as a whole at `level`, or end its share at `none`:
 *  the one a window is of, or one already shared, by its share's id. */
export async function computerShareApp(
  app: { targetId: string } | { appId: string },
  level: GrantLevel,
  backendPlatform: BackendPlatform = legacyBackendPlatform
): Promise<ComputerStatePayload> {
  return backendPlatform.getTransport().call("computer_share_app", {
    targetId: "targetId" in app ? app.targetId : null,
    appId: "appId" in app ? app.appId : null,
    level,
  })
}

/** Share the entire screen at `level`, or end its share at `none`. */
export async function computerShareScreen(
  level: GrantLevel,
  backendPlatform: BackendPlatform = legacyBackendPlatform
): Promise<ComputerStatePayload> {
  return backendPlatform.getTransport().call("computer_share_screen", { level })
}

export async function computerRevokeAll(
  backendPlatform: BackendPlatform = legacyBackendPlatform
): Promise<void> {
  return backendPlatform.getTransport().call("computer_revoke_all", {})
}

/** Stop sharing, all at once: every window stops being shared and whatever
 *  agents are in the middle of is cut off. Nothing is held after it —
 *  sharing a window again is the next step. */
export async function computerStop(
  backendPlatform: BackendPlatform = legacyBackendPlatform
): Promise<void> {
  return backendPlatform.getTransport().call("computer_stop", {})
}

/** Whether the stop shortcut is in force; `computer://stop-key` carries the
 *  changes. */
export async function computerStopKeyStatus(
  backendPlatform: BackendPlatform = legacyBackendPlatform
): Promise<StopKeyStatus> {
  return backendPlatform.getTransport().call("computer_stop_key_status", {})
}

/** The strip telling codeg how large it drew itself, in CSS pixels. */
export async function computerIndicatorFit(
  width: number,
  height: number,
  backendPlatform: BackendPlatform = legacyBackendPlatform
): Promise<void> {
  return backendPlatform
    .getTransport()
    .call("computer_indicator_fit", { width, height })
}

/** cua-driver: the release this codeg runs, what the cache holds, anything
 *  under way. `computer://driver` carries the changes. */
export async function computerDriverInfo(
  backendPlatform: BackendPlatform = legacyBackendPlatform
): Promise<DriverInfo> {
  return backendPlatform.getTransport().call("computer_driver_info", {})
}

/** Fetch the release this codeg runs and clear older ones. Answers once it
 *  is done; the download's progress travels on `computer://driver`. */
export async function computerDriverInstall(
  backendPlatform: BackendPlatform = legacyBackendPlatform
): Promise<DriverInfo> {
  return backendPlatform
    .getTransport()
    .call("computer_driver_install", {}, { timeoutMs: 600_000 })
}

/** Remove cua-driver: computer use is switched off and the helper stopped
 *  first. */
export async function computerDriverUninstall(
  backendPlatform: BackendPlatform = legacyBackendPlatform
): Promise<DriverInfo> {
  return backendPlatform.getTransport().call("computer_driver_uninstall", {})
}
