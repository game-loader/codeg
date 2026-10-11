"use client"

import { useCallback } from "react"
import { useOptionalBackendClient } from "@/contexts/backend-client-context"
import { useWorkspaceRuntimeVisibility } from "@/contexts/workspace-runtime-visibility-context"
import { getBackendEventScope } from "@/lib/backend/resource-identity"

export function useBackendEventScope(): string | undefined {
  return getBackendEventScope(useOptionalBackendClient())
}

/** A native/iframe surface may have focus without a React pointer event.
 * Its DOM owner is authoritative; untargeted window chords use pane focus. */
export function useRuntimeEventScope() {
  const client = useOptionalBackendClient()
  const { managed, visible, focused } = useWorkspaceRuntimeVisibility()
  return useCallback(
    (target?: EventTarget | null): boolean => {
      if (!managed) return true
      if (!visible) return false
      const owner =
        target instanceof Element
          ? target
              .closest("[data-backend-key]")
              ?.getAttribute("data-backend-key")
          : null
      return owner ? owner === client?.key : focused
    },
    [client, managed, visible, focused]
  )
}
