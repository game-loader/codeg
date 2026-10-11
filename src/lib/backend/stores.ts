import type { BackendClient } from "./types"
import {
  createAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { createTabStore, useTabStore } from "@/stores/tab-store"
import {
  createConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import { createAcademicStore, useAcademicStore } from "@/stores/academic-store"
import { createCanvasStore, useCanvasStore } from "@/stores/canvas-store"
import {
  createCanvasBoardsStore,
  useCanvasBoardsStore,
} from "@/stores/canvas-boards-store"
import {
  createCommandTerminalLinkStore,
  useCommandTerminalLinkStore,
} from "@/stores/command-terminal-link-store"
import {
  createForgeRefreshStore,
  useForgeRefreshStore,
} from "@/stores/forge-refresh-store"
import {
  createBackendStoreStorage,
  defaultBackendStoreStorage,
} from "@/stores/backend-store-storage"

/** One retained runtime. Visibility changes do not own this lifetime. */
export function createBackendStores(client: BackendClient) {
  const storage = createBackendStoreStorage(client.key)
  const workspace = createAppWorkspaceStore(client.api, storage)
  const conversationRuntime = createConversationRuntimeStore(client.api)
  const tabs = createTabStore(
    client.api,
    storage,
    workspace,
    conversationRuntime
  )
  const academic = createAcademicStore(client.academic)
  const canvas = createCanvasStore(client.api)
  const canvasBoards = createCanvasBoardsStore(client.api)
  const commandTerminalLinks = createCommandTerminalLinkStore()
  const forgeRefresh = createForgeRefreshStore()
  let disposed = false
  return {
    workspace,
    tabs,
    conversationRuntime,
    academic,
    canvas,
    canvasBoards,
    commandTerminalLinks,
    forgeRefresh,
    storage,
    dispose() {
      if (disposed) return
      disposed = true
      // Unsubscribe tabs before clearing their workspace dependency.
      tabs.dispose()
      conversationRuntime.dispose()
      workspace.dispose()
      academic.dispose()
      canvas.dispose()
      canvasBoards.dispose()
      commandTerminalLinks.dispose()
      forgeRefresh.dispose()
      storage.dispose()
    },
  }
}

export type BackendStores = ReturnType<typeof createBackendStores>

/** Standalone pages and existing tests keep the original module singletons. */
export const defaultBackendStores: BackendStores = {
  workspace: useAppWorkspaceStore,
  tabs: useTabStore,
  conversationRuntime: useConversationRuntimeStore,
  academic: useAcademicStore,
  canvas: useCanvasStore,
  canvasBoards: useCanvasBoardsStore,
  commandTerminalLinks: useCommandTerminalLinkStore,
  forgeRefresh: useForgeRefreshStore,
  storage: defaultBackendStoreStorage,
  dispose: () => {},
}
