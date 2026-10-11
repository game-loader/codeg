"use client"

import type { BackendStores } from "@/lib/backend/stores"
import { defaultBackendStoreStorage } from "@/stores/backend-store-storage"
import type { BackendApi, BackendPlatform } from "@/lib/backend/types"
import * as legacyBackendApi from "@/lib/api"
import { defaultBackendPlatform as legacyBackendPlatform } from "@/lib/backend/defaults"
import { useTabStore, groupOfTab } from "@/stores/tab-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { firstLeafId } from "@/lib/tab-group-layout"
import { hasMessageInputDraftContent } from "@/lib/message-input-draft"

import type { AgentType } from "@/lib/types"

export interface AcademicConversationTarget {
  paper_id: string
  agent_type: string
  folder_id: number | null
  working_dir: string | null
}

/** Keep the per-group draft singleton; never silently repurpose unsent text. */
export async function openAcademicConversation(
  target: AcademicConversationTarget,
  backendApi: BackendApi = legacyBackendApi,
  backendPlatform: BackendPlatform = legacyBackendPlatform,
  stores: Pick<BackendStores, "workspace" | "tabs" | "storage"> = {
    workspace: useAppWorkspaceStore,
    tabs: useTabStore,
    storage: defaultBackendStoreStorage,
  }
) {
  const transport = backendPlatform.getTransport()
  if (target.folder_id != null) {
    const folder = await backendApi.getFolder(target.folder_id)
    if (transport !== backendPlatform.getTransport())
      throw new Error("Workspace changed")
    stores.workspace.getState().upsertFolder(folder)
  }
  // Re-read AFTER fetching the folder: the user can type or switch meanwhile.
  const state = stores.tabs.getState()
  const group = state.activeTabId
    ? groupOfTab(state.groupOf, state.groupLayout, state.activeTabId)
    : firstLeafId(state.groupLayout)
  const draft = state.rawTabs.find(
    (tab) =>
      tab.conversationId == null &&
      groupOfTab(state.groupOf, state.groupLayout, tab.id) === group
  )
  if (
    draft &&
    hasMessageInputDraftContent(
      stores.storage.drafts.buildNewConversationDraftStorageKey(draft.id)
    )
  ) {
    if (draft.academicPaperId === target.paper_id) {
      state.switchTab(draft.id)
      return
    }
    throw new Error("academicDraftConflict")
  }
  const options = {
    forceAgent: target.agent_type as AgentType,
    academicPaperId: target.paper_id,
  }
  if (target.folder_id != null && target.working_dir) {
    state.openNewConversationTab(target.folder_id, target.working_dir, options)
  } else {
    state.openChatModeTab(options)
  }
}
