"use client"

import { useTabStore, groupOfTab } from "@/stores/tab-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { firstLeafId } from "@/lib/tab-group-layout"
import {
  buildNewConversationDraftStorageKey,
  hasMessageInputDraftContent,
} from "@/lib/message-input-draft"
import { getFolder } from "@/lib/api"
import { getTransport } from "@/lib/transport"
import type { AgentType } from "@/lib/types"

export interface AcademicConversationTarget {
  paper_id: string
  agent_type: string
  folder_id: number | null
  working_dir: string | null
}

/** Keep the per-group draft singleton; never silently repurpose unsent text. */
export async function openAcademicConversation(
  target: AcademicConversationTarget
) {
  const transport = getTransport()
  if (target.folder_id != null) {
    const folder = await getFolder(target.folder_id)
    if (transport !== getTransport()) throw new Error("Workspace changed")
    useAppWorkspaceStore.getState().upsertFolder(folder)
  }
  // Re-read AFTER fetching the folder: the user can type or switch meanwhile.
  const state = useTabStore.getState()
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
    hasMessageInputDraftContent(buildNewConversationDraftStorageKey(draft.id))
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
