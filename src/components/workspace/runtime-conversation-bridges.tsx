"use client"

import { useEffect, useMemo, useRef } from "react"
import { useBackendStoreSelection } from "@/contexts/backend-stores-selection-context"
import {
  useTabStore as legacyUseTabStore,
  useTabActions as legacyUseTabActions,
} from "@/contexts/tab-context"
import { useAcpActions } from "@/contexts/acp-connections-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"

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

/** Local activation reveals conversations; a mirrored remote activation does not. */
export function WorkbenchRouteConversationSync() {
  const stores = useBackendStoreSelection()
  const useTabStore = stores?.tabs ?? legacyUseTabStore
  const useTabActions = stores?.tabs.useTabActions ?? legacyUseTabActions
  const activeTabId = useTabStore((state) => state.activeTabId)
  const { consumeRemoteActivation } = useTabActions()
  const { openConversations } = useWorkbenchRoute()
  const previous = useRef(activeTabId)
  useEffect(() => {
    if (previous.current === activeTabId) return
    previous.current = activeTabId
    if (!consumeRemoteActivation()) openConversations()
  }, [activeTabId, consumeRemoteActivation, openConversations])
  return null
}
