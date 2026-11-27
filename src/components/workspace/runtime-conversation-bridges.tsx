"use client"

import { useEffect, useMemo } from "react"
import { useBackendStoreSelection } from "@/contexts/backend-stores-selection-context"
import { useTabStore as legacyUseTabStore } from "@/contexts/tab-context"
import { useAcpActions } from "@/contexts/acp-connections-context"
export { WorkbenchRouteConversationSync } from "./workbench-route-conversation-sync"

/** The production layout's open tabs keep their scoped ACP connections alive. */
export function TabKeysSync() {
  const stores = useBackendStoreSelection()
  const useTabStore = stores?.tabs ?? legacyUseTabStore
  const tabs = useTabStore((state) => state.tabs)
  const { registerOpenTabKeys } = useAcpActions()
  const keys = useMemo(() => new Set(tabs.map((tab) => tab.id)), [tabs])
  useEffect(() => {
    registerOpenTabKeys(keys)
  }, [keys, registerOpenTabKeys])
  return null
}
