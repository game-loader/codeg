"use client"

/**
 * The assistants page's way to open a session link in a reply
 * (`codeg://session/<id>`): what the conversation is codeg reads first —
 * its project and agent — then it opens as a conversation tab, where the
 * owner can answer what it waits on, as `useOpenInWorkbench` opens one.
 */

import { useCallback } from "react"
import { toast } from "sonner"

import type { SessionLinkOpener } from "@/components/ai-elements/session-link-opener"
import { useTabActions } from "@/contexts/tab-context"
import { useBackendStoreSelection } from "@/contexts/backend-stores-selection-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useBackendApi } from "@/contexts/backend-client-context"
import { toErrorMessage } from "@/lib/app-error"

export function useSessionLinkOpener(): SessionLinkOpener {
  const backendApi = useBackendApi()
  const { openConversations } = useWorkbenchRoute()
  const useScopedTabActions =
    useBackendStoreSelection()?.tabs.useTabActions ?? useTabActions
  const { openTab } = useScopedTabActions()
  return useCallback(
    (conversationId: number) => {
      backendApi
        .personalAgentConversationTarget(conversationId)
        .then((target) => {
          openConversations()
          openTab(
            target.folder_id,
            target.conversation_id,
            target.agent_type,
            false,
            target.title ?? undefined
          )
        })
        .catch((e) => toast.error(toErrorMessage(e)))
    },
    [backendApi, openConversations, openTab]
  )
}
