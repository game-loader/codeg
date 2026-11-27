"use client"

/**
 * In the workspace: opens the assistants page's settings — or a tab of its
 * assistant's own page — when another window asks (`openPersonalAgentPage`),
 * or when the workspace was opened on `?pa=<page>` (the web, when no
 * workspace tab was open to ask). Follows a
 * notification the owner opened (1.13): the assistant on its card, or the
 * conversation it points at, or one of the menu bar's assistants (10.10).
 * And on the desktop hands the backend each assistant's avatar as PNGs, for
 * the icon of the notifications it posts and the menu bar's face.
 */

import { useShowSidebarAssistants } from "@/components/personal-agent/sidebar-assistants"
import { useCallback, useEffect, useRef } from "react"

import { useOptionalBackendClient } from "@/contexts/backend-client-context"
import { usePrimaryAgent } from "@/contexts/personal-agent-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useWorkspaceRuntimeVisibility } from "@/contexts/workspace-runtime-visibility-context"
import { useReducedMotion } from "@/hooks/use-chat-motion"
import { uploadAvatarPngs } from "@/lib/personal-agent-avatar-png"
import { listenPersonalAgentFollow } from "@/lib/personal-agent-notify"
import {
  isBotTab,
  personalAgentPageOf,
  listenPersonalAgentOpen,
  PERSONAL_AGENT_OPEN_PARAM,
  type PersonalAgentPage,
} from "@/lib/personal-agent-open"
import type { PersonalAgentNotifyLink } from "@/lib/types"
import { useRoster } from "@/stores/personal-agent-roster-store"
import { usePersonalAgentUiStore } from "@/stores/personal-agent-ui-store"

import { useSessionLinkOpener } from "./session-link"

export function PersonalAgentOpenBridge({ onOpen }: { onOpen?: () => void }) {
  const uiStore = usePersonalAgentUiStore()
  const client = useOptionalBackendClient()
  const { managed } = useWorkspaceRuntimeVisibility()
  const showSidebarAssistants = useShowSidebarAssistants()
  const { setRoute } = useWorkbenchRoute()
  const openSession = useSessionLinkOpener()
  const { snapshot } = usePrimaryAgent()
  const entries = useRoster()
  const still = useReducedMotion()
  const primaryId = snapshot?.agent?.id ?? null
  const onOpenRef = useRef(onOpen)
  useEffect(() => {
    onOpenRef.current = onOpen
  }, [onOpen])

  const open = useCallback(
    (page: PersonalAgentPage) => {
      const ui = uiStore.getState()
      if (page === "assistants") {
        // The primary's conversation, whichever one the page showed last,
        // and the sidebar's group of them open.
        ui.setViewBot(null)
        ui.showConversation()
        showSidebarAssistants()
      } else if (isBotTab(page)) ui.openBotPage(page)
      else ui.openSettings(page)
      setRoute("personalAgent")
      onOpenRef.current?.()
    },
    [setRoute, showSidebarAssistants, uiStore]
  )

  useEffect(() => listenPersonalAgentOpen(open, client), [client, open])

  useEffect(() => {
    // A bare startup URL belongs to the window's original workspace. A
    // separate remote window owns its own URL; embedded panes get client events.
    if (managed && client?.key !== "local") return
    const params = new URLSearchParams(window.location.search)
    const asked = params.get(PERSONAL_AGENT_OPEN_PARAM)
    if (asked != null) {
      params.delete(PERSONAL_AGENT_OPEN_PARAM)
      const rest = params.toString()
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`
      )
      const page = personalAgentPageOf(asked)
      if (page) open(page)
    }
  }, [client, managed, open])

  // Who the primary is, for the page's "`null` is the primary".
  const who = useRef<{ primary: number | null; kinds: Map<number, string> }>({
    primary: null,
    kinds: new Map(),
  })
  useEffect(() => {
    who.current = {
      primary: primaryId,
      kinds: new Map((entries ?? []).map((e) => [e.id, e.kind])),
    }
  }, [primaryId, entries])

  useEffect(
    () =>
      listenPersonalAgentFollow((link: PersonalAgentNotifyLink) => {
        onOpenRef.current?.()
        if (link.kind === "conversation") {
          openSession(link.conversation_id)
          return
        }
        const { primary, kinds } = who.current
        const isPrimary =
          link.bot_id === primary || kinds.get(link.bot_id) === "primary"
        const ui = uiStore.getState()
        ui.setViewBot(isPrimary ? null : link.bot_id)
        ui.showConversation()
        ui.setPendingJump(
          link.row_id != null ? { bot: link.bot_id, row: link.row_id } : null
        )
        setRoute("personalAgent")
      }, client),
    [client, openSession, setRoute, uiStore]
  )

  useEffect(() => {
    if (!entries) return
    if (client) uploadAvatarPngs(entries, still, client)
    else uploadAvatarPngs(entries, still)
  }, [client, entries, still])

  return null
}
