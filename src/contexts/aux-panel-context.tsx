"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import {
  loadPersistedPanelState,
  savePersistedPanelState,
} from "@/lib/panel-state-storage"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useTabStore as legacyTabs } from "@/contexts/tab-context"
import { useBackendStores } from "@/contexts/backend-stores-selection-context"
import type { FolderDetail } from "@/lib/types"
import { detectPlatform } from "@/hooks/use-platform"
import { isDesktop } from "@/lib/platform"

export type AuxPanelTab =
  | "session_details"
  | "file_tree"
  | "changes"
  | "git_log"

const STORAGE_KEY = "workspace:right-sidebar"

const DEFAULT_WIDTH = 320
const MIN_WIDTH = 200
const MAX_WIDTH = 900
const DEFAULT_IS_OPEN = false

// The tabs now sit on their own row below the fixed top-right window-chrome
// overlay (terminal/aux/settings), so they no longer need extra width to clear
// it. The minimum only has to keep that overlay — and, on Windows/Linux, the
// native caption strip beside it (~116 + 138) — from spilling past the panel's
// left edge over the middle column. Elsewhere the base 200 is plenty.
function resolveAuxMinWidth(): number {
  const platform = detectPlatform()
  if (isDesktop() && (platform === "windows" || platform === "linux")) {
    return 260
  }
  return MIN_WIDTH
}

interface AuxPanelContextValue {
  isOpen: boolean
  restored: boolean
  width: number
  minWidth: number
  maxWidth: number
  activeTab: AuxPanelTab
  toggle: () => void
  /** Imperatively set the panel open/closed (used by the chat-mode auto-hide). */
  setOpen: (open: boolean) => void
  setWidth: (w: number) => void
  setActiveTab: (tab: AuxPanelTab) => void
  openTab: (tab: AuxPanelTab) => void
  /** Transient explicit location, independent of the retained composer. */
  folderToolContext: Pick<FolderDetail, "id" | "path"> | null
  clearFolderToolContext: () => void
  openFolderTab: (
    tab: Exclude<AuxPanelTab, "session_details">,
    folder: Pick<FolderDetail, "id" | "path">
  ) => void
  pendingRevealPath: string | null
  revealInFileTree: (path: string) => void
  consumePendingRevealPath: () => void
}

const AuxPanelContext = createContext<AuxPanelContextValue | null>(null)

export function useAuxPanelContext() {
  const ctx = useContext(AuxPanelContext)
  if (!ctx) {
    throw new Error("useAuxPanelContext must be used within AuxPanelProvider")
  }
  return ctx
}

function clampWidth(width: number, minWidth: number) {
  return Math.max(minWidth, Math.min(MAX_WIDTH, width))
}

interface AuxPanelProviderProps {
  children: ReactNode
}

export function AuxPanelProvider({ children }: AuxPanelProviderProps) {
  const storageKey = STORAGE_KEY
  const { activeFolderId, activeFolder } = useActiveFolder()
  const stores = useBackendStores({ tabs: legacyTabs })
  const activeTabId = stores.tabs((s) => s.activeTabId)
  const [isOpen, setIsOpen] = useState(DEFAULT_IS_OPEN)
  const [width, setWidthState] = useState(DEFAULT_WIDTH)
  const [restored, setRestored] = useState(false)
  const [activeTab, setActiveTabState] =
    useState<AuxPanelTab>("session_details")
  const [explicitFolder, setExplicitFolder] = useState<{
    folder: Pick<FolderDetail, "id" | "path">
    tabId: string | null
  } | null>(null)
  const folderToolContext =
    explicitFolder &&
    explicitFolder.tabId === activeTabId &&
    explicitFolder.folder.id === activeFolder?.id &&
    explicitFolder.folder.path === activeFolder.path &&
    activeFolder.kind !== "chat"
      ? explicitFolder.folder
      : null
  const [pendingRevealPath, setPendingRevealPath] = useState<string | null>(
    null
  )
  // Platform-derived minimum (see resolveAuxMinWidth); stable for the session.
  const minWidth = useMemo(() => resolveAuxMinWidth(), [])

  const toggle = useCallback(() => {
    setExplicitFolder(null)
    setIsOpen((prev) => !prev)
  }, [])

  const setOpen = useCallback((open: boolean) => {
    if (!open) setExplicitFolder(null)
    setIsOpen(open)
  }, [])

  const setActiveTab = useCallback((tab: AuxPanelTab) => {
    if (tab === "session_details") setExplicitFolder(null)
    setActiveTabState(tab)
  }, [])
  const clearFolderToolContext = useCallback(() => setExplicitFolder(null), [])

  const setWidth = useCallback(
    (w: number) => {
      setWidthState(clampWidth(w, minWidth))
    },
    [minWidth]
  )

  const openTab = useCallback((tab: AuxPanelTab) => {
    setExplicitFolder(null)
    setActiveTabState(tab)
    setIsOpen(true)
  }, [])

  const openFolderTab = useCallback(
    (
      tab: Exclude<AuxPanelTab, "session_details">,
      folder: Pick<FolderDetail, "id" | "path">
    ) => {
      setExplicitFolder({
        folder: { id: folder.id, path: folder.path },
        tabId: stores.tabs.getState().activeTabId,
      })
      setActiveTabState(tab)
      setIsOpen(true)
    },
    [stores]
  )

  useEffect(() => {
    if (explicitFolder && !folderToolContext) {
      // Do not revive an explicit destination after returning to an old tab/path.
      setExplicitFolder(null)
    }
  }, [explicitFolder, folderToolContext])

  const revealInFileTree = useCallback((path: string) => {
    setPendingRevealPath(path)
    setExplicitFolder(null)
    setActiveTabState("file_tree")
    setIsOpen(true)
  }, [])

  const consumePendingRevealPath = useCallback(() => {
    setPendingRevealPath(null)
  }, [])

  useEffect(() => {
    const stored = loadPersistedPanelState(storageKey)
    const isMobileViewport = window.innerWidth < 768
    const defaultOpen = isMobileViewport ? false : DEFAULT_IS_OPEN
    // Hydrate from localStorage after mount to keep SSR/CSR markup consistent.
    setIsOpen(isMobileViewport ? false : (stored?.isOpen ?? defaultOpen))
    setWidthState(clampWidth(stored?.width ?? DEFAULT_WIDTH, minWidth))
    setRestored(true)
  }, [storageKey, minWidth])

  useEffect(() => {
    if (!restored) return
    savePersistedPanelState(storageKey, { isOpen, width })
  }, [isOpen, restored, storageKey, width])

  // Reset pending reveal path when the active folder changes; file tree
  // state is content-driven by the workspace contexts and will refetch
  // naturally via its folder-path dependency.
  useEffect(() => {
    setPendingRevealPath(null)
  }, [activeFolderId])

  const value = useMemo(
    () => ({
      isOpen,
      restored,
      width,
      minWidth,
      maxWidth: MAX_WIDTH,
      activeTab,
      toggle,
      setOpen,
      setWidth,
      setActiveTab,
      openTab,
      folderToolContext,
      clearFolderToolContext,
      openFolderTab,
      pendingRevealPath,
      revealInFileTree,
      consumePendingRevealPath,
    }),
    [
      isOpen,
      restored,
      width,
      minWidth,
      activeTab,
      toggle,
      setOpen,
      setWidth,
      openTab,
      folderToolContext,
      clearFolderToolContext,
      openFolderTab,
      setActiveTab,
      pendingRevealPath,
      revealInFileTree,
      consumePendingRevealPath,
    ]
  )

  return (
    <AuxPanelContext.Provider value={value}>
      {children}
    </AuxPanelContext.Provider>
  )
}
