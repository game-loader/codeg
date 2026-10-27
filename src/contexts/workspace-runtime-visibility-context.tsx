"use client"

import { createContext, useContext, type ReactNode } from "react"

export interface WorkspaceRuntimeVisibility {
  managed: boolean
  visible: boolean
  focused: boolean
}

const DEFAULT_VISIBILITY: WorkspaceRuntimeVisibility = {
  managed: false,
  visible: true,
  focused: true,
}

const WorkspaceRuntimeVisibilityContext = createContext(DEFAULT_VISIBILITY)

export function WorkspaceRuntimeVisibilityProvider({
  value,
  children,
}: {
  value: WorkspaceRuntimeVisibility
  children: ReactNode
}) {
  return (
    <WorkspaceRuntimeVisibilityContext.Provider value={value}>
      {children}
    </WorkspaceRuntimeVisibilityContext.Provider>
  )
}

export function useWorkspaceRuntimeVisibility(): WorkspaceRuntimeVisibility {
  return useContext(WorkspaceRuntimeVisibilityContext)
}
