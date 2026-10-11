"use client"

import { createContext, useContext, type ReactNode } from "react"
import * as defaultApi from "@/lib/api"
import * as defaultAcademic from "@/lib/academic"
import { defaultBackendPlatform } from "@/lib/backend/defaults"
import type {
  BackendClient,
  BackendApi,
  BackendPlatform,
  AcademicApi,
} from "@/lib/backend/types"

const BackendClientContext = createContext<BackendClient | null>(null)

export function BackendClientProvider({
  client,
  children,
}: {
  client: BackendClient
  children: ReactNode
}) {
  return (
    <BackendClientContext.Provider value={client}>
      {children}
    </BackendClientContext.Provider>
  )
}

export function useOptionalBackendClient(): BackendClient | null {
  return useContext(BackendClientContext)
}

export function useBackendClient(): BackendClient {
  const client = useContext(BackendClientContext)
  if (!client) throw new Error("BackendClientProvider is required")
  return client
}

/** Standalone pages retain their single-backend compatibility entry points. */
export function useBackendApi(): BackendApi {
  return useContext(BackendClientContext)?.api ?? defaultApi
}

export function useBackendPlatform(): BackendPlatform {
  return useContext(BackendClientContext)?.platform ?? defaultBackendPlatform
}

export function useBackendAcademicApi(): AcademicApi {
  return useContext(BackendClientContext)?.academic ?? defaultAcademic
}
