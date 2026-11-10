"use client"

import { useTabStore as legacyTabs } from "@/stores/tab-store"
import { useAppWorkspaceStore as legacyWorkspace } from "@/stores/app-workspace-store"
import { useBackendStores } from "@/contexts/backend-stores-selection-context"
import { useOptionalBackendClient } from "@/contexts/backend-client-context"
import { useBackendEventScope } from "@/hooks/use-runtime-event-scope"
import { useCallback } from "react"
import { openTaskFromMessage } from "@/lib/task-from-message"

/**
 * "Turn this message into a work task": opens the task editor over the
 * conversation, seeded with the text and the source project folder (see
 * `TaskFromMessageHost`). Worktree conversations resolve to their parent
 * project folder (tasks bind to projects); chat-mode / unknown folders leave
 * the editor to pick one.
 */
export function useCreateTaskFromMessage(getText: () => string) {
  const backendKey = useOptionalBackendClient()?.key
  const backendScope = useBackendEventScope()
  const backendStores = useBackendStores({
    tabs: legacyTabs,
    workspace: legacyWorkspace,
  })
  const useTabStore = backendStores.tabs
  const useAppWorkspaceStore = backendStores.workspace
  const tabFolderId = useTabStore((s) => {
    const tab = s.rawTabs.find((t) => t.id === s.activeTabId)
    return tab?.folderId ?? null
  })

  return useCallback(() => {
    const text = getText().trim()
    if (!text) return
    const folders = useAppWorkspaceStore.getState().folders
    let folder =
      tabFolderId == null
        ? null
        : (folders.find((f) => f.id === tabFolderId) ?? null)
    if (folder?.parent_id != null) {
      folder = folders.find((f) => f.id === folder?.parent_id) ?? null
    }
    const folderId =
      folder != null && folder.parent_id == null && folder.kind === "regular"
        ? folder.id
        : null
    openTaskFromMessage({ text, folderId, backendKey, backendScope })
  }, [getText, tabFolderId, useAppWorkspaceStore, backendKey, backendScope])
}
