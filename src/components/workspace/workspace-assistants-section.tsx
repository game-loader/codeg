"use client"

import { useEffect, useState } from "react"
import { SidebarSectionHeader } from "@/components/conversations/sidebar-section-header"
import {
  AssistantsSectionActions,
  AssistantsSectionBadge,
  SHOW_SIDEBAR_ASSISTANTS_EVENT,
  SidebarAssistants,
  readAssistantsCollapsed,
  useRemoteAssistantsFoldKey,
  useSidebarRosterDialogs,
  writeAssistantsCollapsed,
} from "@/components/personal-agent/sidebar-assistants"
import { BetaBadge } from "@/components/ui/beta-badge"
import { useBackendEventScope } from "@/hooks/use-runtime-event-scope"

/** Rendered in the shared sidebar with the focused workspace's providers. */
export function WorkspaceAssistantsSection() {
  const dialogs = useSidebarRosterDialogs()
  const scope = useBackendEventScope()
  const key = useRemoteAssistantsFoldKey()
  const [expanded, setExpanded] = useState(() => !readAssistantsCollapsed(key))
  useEffect(() => {
    const show = (e: Event) => {
      if ((e as CustomEvent<string>).detail === scope) setExpanded(true)
    }
    window.addEventListener(SHOW_SIDEBAR_ASSISTANTS_EVENT, show)
    return () => window.removeEventListener(SHOW_SIDEBAR_ASSISTANTS_EVENT, show)
  }, [scope])

  return (
    <>
      <SidebarSectionHeader
        section="assistants"
        expanded={expanded}
        onToggle={() => {
          writeAssistantsCollapsed(expanded, key)
          setExpanded(!expanded)
        }}
        labelBadge={
          <>
            <BetaBadge />
            {!expanded && <AssistantsSectionBadge />}
          </>
        }
        trailing={(className) => (
          <AssistantsSectionActions
            dialogs={dialogs.api}
            className={className}
          />
        )}
      />
      {expanded && <SidebarAssistants dialogs={dialogs.api} />}
      {dialogs.node}
    </>
  )
}
