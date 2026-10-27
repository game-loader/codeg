import type { BackendRuntime } from "./runtime"
import type { BackendRegistry } from "./registry"
import type { BackendKey } from "./types"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"

/** Check captured lifetime before looking up the replacement runtime. */
export function resolveCatalogRuntime(
  registry: BackendRegistry<BackendRuntime>,
  key: BackendKey,
  generation: number,
  folder?: FolderDetail
): BackendRuntime | null {
  if (registry.descriptor(key)?.generation !== generation) return null
  const runtime = registry.get(key)
  if (!runtime) return null
  if (
    folder &&
    !runtime.stores.workspace
      .getState()
      .allFolders.some(
        (f) => f.id === folder.id && f.path === folder.path && f.kind !== "chat"
      )
  )
    return null
  return runtime
}

export function selectFolderContext(
  runtime: BackendRuntime,
  folder: FolderDetail
): void {
  runtime.stores.workspace.getState().setActiveFolderId(folder.id)
  runtime.getSnapshot()?.navigate("conversations")
}

export function openExistingConversation(
  runtime: BackendRuntime,
  folder: FolderDetail,
  conversation: DbConversationSummary
): boolean {
  const live = runtime.stores.workspace
    .getState()
    .conversations.find(
      (c) =>
        c.id === conversation.id &&
        c.folder_id === folder.id &&
        c.agent_type === conversation.agent_type
    )
  if (!live) return false
  selectFolderContext(runtime, folder)
  runtime.stores.tabs
    .getState()
    .openTab(
      folder.id,
      live.id,
      live.agent_type,
      false,
      live.title ?? undefined
    )
  return true
}
