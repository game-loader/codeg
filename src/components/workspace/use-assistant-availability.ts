"use client"

import { useEffect, useState } from "react"

import { useOptionalBackendClient } from "@/contexts/backend-client-context"
import type { BackendClient } from "@/lib/backend/types"
import { readServerVersionStrict } from "@/lib/updater"

/** The personal assistant API first shipped in 0.49.0. */
export function supportsAssistantWorkspace(version: string | null): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(-[^+]+)?(?:\+.+)?$/.exec(version ?? "")
  if (!match) return false
  const [, major, minor, patch, prerelease] = match
  return (
    Number(major) > 0 ||
    Number(minor) > 49 ||
    (Number(minor) === 49 && (Number(patch) > 0 || !prerelease))
  )
}

export function useAssistantAvailability(): boolean {
  const client = useOptionalBackendClient()
  const [result, setResult] = useState<{
    client: BackendClient
    supported: boolean
  }>()
  useEffect(() => {
    if (!client || client.key === "local") return
    let revision = 0
    const probe = async () => {
      const current = ++revision
      try {
        const version = await readServerVersionStrict(client.platform)
        if (current === revision)
          setResult({ client, supported: supportsAssistantWorkspace(version) })
      } catch {
        // No answer yet. The owning transport will signal when it reconnects.
      }
    }
    const off = client.platform.onTransportReady(() => void probe())
    void probe()
    return () => {
      revision++
      off?.()
    }
  }, [client])
  return (
    !client ||
    client.key === "local" ||
    (result?.client === client && result.supported)
  )
}
