"use client"

import { useCallback } from "react"

import { useBackendEventScope } from "@/hooks/use-runtime-event-scope"
import { PERSONAL_AGENT_EVENTS } from "@/stores/personal-agent-ui-store"

type SessionEvent =
  (typeof PERSONAL_AGENT_EVENTS)[keyof typeof PERSONAL_AGENT_EVENTS]

export function useSendSessionEvent() {
  const scope = useBackendEventScope()
  return useCallback(
    (name: SessionEvent) => {
      window.dispatchEvent(new CustomEvent(name, { detail: scope }))
    },
    [scope]
  )
}
