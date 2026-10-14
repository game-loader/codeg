"use client"

import { createContext, useContext, useMemo } from "react"
import type { BackendStores } from "@/lib/backend/stores"

export const BackendStoresContext = createContext<BackendStores | null>(null)

/** Keep standalone fallbacks local to the resources a consumer actually uses.
 * Importing this context never initializes the unrelated resource singletons. */
export function useBackendStores(
  fallback: Partial<BackendStores>
): BackendStores {
  const stores = useContext(BackendStoresContext)
  const standalone = useMemo(
    () => ({
      workspace: fallback.workspace,
      tabs: fallback.tabs,
      conversationRuntime: fallback.conversationRuntime,
      conversationTags: fallback.conversationTags,
      academic: fallback.academic,
      canvas: fallback.canvas,
      canvasBoards: fallback.canvasBoards,
      commandTerminalLinks: fallback.commandTerminalLinks,
      forgeRefresh: fallback.forgeRefresh,
      storage: fallback.storage,
    }),
    [
      fallback.workspace,
      fallback.tabs,
      fallback.conversationRuntime,
      fallback.conversationTags,
      fallback.academic,
      fallback.canvas,
      fallback.canvasBoards,
      fallback.commandTerminalLinks,
      fallback.forgeRefresh,
      fallback.storage,
    ]
  )
  return stores ?? (standalone as BackendStores)
}

/** Standalone compatibility helpers are selected only when no provider exists. */
export function useBackendStoreSelection(): BackendStores | null {
  return useContext(BackendStoresContext)
}
