"use client"

import { useCallback, useMemo, useSyncExternalStore } from "react"
import {
  useBackendApi,
  useOptionalBackendClient,
} from "@/contexts/backend-client-context"
import {
  getAgentLabel,
  getAgentIconUrl,
  getAgentInitial,
  getCustomAgentDisplayVersion,
  subscribeCustomAgentDisplay,
} from "@/lib/custom-agents"
import type { AgentType } from "@/lib/types"

/** Labels and icons belong to the registry of the fixed workspace client. */
export function useAgentDisplay(reactiveStandalone = false) {
  const client = useOptionalBackendClient()
  const api = useBackendApi()
  useSyncExternalStore(
    useCallback(
      (notify: () => void) =>
        client || reactiveStandalone
          ? subscribeCustomAgentDisplay(notify, api)
          : () => {},
      [api, client, reactiveStandalone]
    ),
    useCallback(
      () =>
        client || reactiveStandalone ? getCustomAgentDisplayVersion(api) : 0,
      [api, client, reactiveStandalone]
    ),
    () => 0
  )
  return useMemo(
    () => ({
      getAgentLabel: (agent: AgentType) =>
        client ? getAgentLabel(agent, api) : getAgentLabel(agent),
      getAgentIconUrl: (agent: AgentType) =>
        client ? getAgentIconUrl(agent, api) : getAgentIconUrl(agent),
      getAgentInitial: (agent: AgentType) =>
        client ? getAgentInitial(agent, api) : getAgentInitial(agent),
    }),
    [api, client]
  )
}
