"use client"

import { useContext, type ReactNode } from "react"
import { defaultBackendStores, type BackendStores } from "@/lib/backend/stores"

import { BackendStoresContext } from "./backend-stores-selection-context"

export function BackendStoresProvider(props: {
  stores: BackendStores
  children: ReactNode
}): ReactNode {
  return (
    <BackendStoresContext.Provider value={props.stores}>
      {props.children}
    </BackendStoresContext.Provider>
  )
}

/** Providers select a runtime; its registry, rather than React, disposes it. */
export function useBackendStores(): BackendStores {
  return useContext(BackendStoresContext) ?? defaultBackendStores
}
