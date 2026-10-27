import type { BackendKey } from "@/lib/backend/types"
import type { FileWorkspaceTab } from "@/contexts/workspace-context"

import { getBrowserTabState, browserWorkspaceTabId } from "./browser-tab-store"
import { remoteConnectionOfProfile } from "./remote-host"

/** Native IDs stay shell-wide. Remember the workspace that issued each ID,
 * including ordinary profiles opened by a remote workspace. Keep this across
 * runtime replacement so its orphan sweep cannot mistake another host's tab
 * for a local tab. A real native close releases the entry. */
const tabBackends = new Map<string, BackendKey>()

export interface NativeBrowserIdentity {
  hostConnectionId?: number | null
  profile?: string | null
}

export function rememberBrowserTabBackends(
  backendKey: BackendKey | null,
  tabs: readonly FileWorkspaceTab[]
): void {
  if (!backendKey) return
  for (const tab of tabs) {
    if (tab.kind === "browser") rememberBrowserTabBackend(tab.id, backendKey)
  }
}

export function rememberBrowserTabBackend(
  workspaceTabId: string,
  backendKey: BackendKey | null
): void {
  if (backendKey) tabBackends.set(workspaceTabId, backendKey)
}

/** Explicit connection/profile identity wins over records and never depends
 * on which runtime is focused. An unidentified shell request is local. */
export function nativeBrowserBackendKey(
  identity: NativeBrowserIdentity,
  backendTabId?: string | null,
  openerBackendTabId?: string | null
): BackendKey {
  const connectionId =
    identity.hostConnectionId ?? remoteConnectionOfProfile(identity.profile)
  if (connectionId != null) return `remote:${connectionId}`
  for (const id of [backendTabId, openerBackendTabId]) {
    if (!id) continue
    const key = browserWorkspaceTabId(id)
    const remembered = tabBackends.get(key)
    if (remembered) return remembered
    const state = getBrowserTabState(key)
    const remoteId =
      state?.hostConnectionId ?? remoteConnectionOfProfile(state?.profile)
    if (remoteId != null) return `remote:${remoteId}`
  }
  return "local"
}

export function forgetBrowserTabBackend(backendTabId: string): void {
  tabBackends.delete(browserWorkspaceTabId(backendTabId))
}

/** Tests only. */
export function resetBrowserRuntimeScopeForTests(): void {
  tabBackends.clear()
}
