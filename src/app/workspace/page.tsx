"use client"

import { ConversationDetailPanel } from "@/components/conversations/conversation-detail-panel"
import { useFileDropGuard } from "@/hooks/use-file-drop-guard"

export default function WorkspacePage() {
  // Keep a file dropped outside a composer from navigating the window.
  useFileDropGuard()
  return <ConversationDetailPanel />
}
