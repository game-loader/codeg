"use client"

import { useBackendStoreSelection } from "@/contexts/backend-stores-selection-context"
import {
  useAppWorkspaceStore,
  type AppWorkspaceStoreState,
} from "@/stores/app-workspace-store"

export function useAssistantWorkspace<T>(
  select: (state: AppWorkspaceStoreState) => T
): T {
  const useWorkspaceStore =
    useBackendStoreSelection()?.workspace ?? useAppWorkspaceStore
  return useWorkspaceStore(select)
}
