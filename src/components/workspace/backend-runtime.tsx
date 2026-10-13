"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react"
import { BackendClientProvider } from "@/contexts/backend-client-context"
import {
  BackendStoresProvider,
  useBackendStores,
} from "@/contexts/backend-stores-context"
import { ScopedRemoteConnectionProvider } from "@/contexts/remote-connection-context"
import { WorkspaceRuntimeVisibilityProvider } from "@/contexts/workspace-runtime-visibility-context"
import { OverlayHostHiddenProvider } from "@/components/ui/overlay-host-hidden"
import {
  useWorkspaceActions,
  useWorkspaceFileTabs,
  useWorkspaceView,
} from "@/contexts/workspace-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useSidebarContext } from "@/contexts/sidebar-context"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useTerminalContext } from "@/contexts/terminal-context"
import { useSearchDialog } from "@/contexts/search-dialog-context"
import type {
  BackendRuntime,
  RecoveryBuffer,
  RuntimeView,
} from "@/lib/backend/runtime"
import type { WindowResourceRef } from "@/lib/backend/window-layout"
import type { WindowResourceTab } from "./multi-host-tabs"
import type { ConversationStatus, DbConversationSummary } from "@/lib/types"
import { cn } from "@/lib/utils"

/** A stable host node: focus/split changes update style, never its providers. */
export function BackendRuntimeView({
  runtime,
  visible,
  focused,
  expired,
  style,
  onFocus,
  children,
}: {
  runtime: BackendRuntime
  visible: boolean
  focused: boolean
  expired: boolean
  style?: CSSProperties
  onFocus(): void
  children: ReactNode
}) {
  const visibility = useMemo(
    () => ({ managed: true, visible, focused }),
    [visible, focused]
  )
  return (
    <BackendClientProvider client={runtime.client}>
      <BackendStoresProvider stores={runtime.stores}>
        <ScopedRemoteConnectionProvider
          connection={runtime.client.remoteConnection}
          expired={expired}
        >
          <WorkspaceRuntimeVisibilityProvider value={visibility}>
            <OverlayHostHiddenProvider hidden={!visible}>
              <div
                data-backend-key={runtime.client.key}
                data-runtime-generation={runtime.generation}
                data-runtime-focused={focused}
                className={cn(
                  "absolute min-h-0 min-w-0 overflow-hidden",
                  !visible &&
                    "conversation-tab-hidden invisible pointer-events-none"
                )}
                style={style}
                aria-hidden={!visible}
                inert={!visible || undefined}
                onPointerDownCapture={onFocus}
                onFocusCapture={onFocus}
              >
                {children}
              </div>
            </OverlayHostHiddenProvider>
          </WorkspaceRuntimeVisibilityProvider>
        </ScopedRemoteConnectionProvider>
      </BackendStoresProvider>
    </BackendClientProvider>
  )
}

/** Must be mounted inside WorkspaceLayoutInner's existing provider tree. */
export function RuntimeBridge({ runtime }: { runtime: BackendRuntime }) {
  const stores = useBackendStores()
  const conversations = stores.tabs((state) => state.tabs)
  const activeTabId = stores.tabs((state) => state.activeTabId)
  const hydrated = stores.tabs((state) => state.tabsHydrated)
  const { fileTabs, activeFileTabId } = useWorkspaceFileTabs()
  const workspace = useWorkspaceActions()
  const { activePane } = useWorkspaceView()
  const { openConversations, routeId, setRoute } = useWorkbenchRoute()
  const sidebar = useSidebarContext()
  const aux = useAuxPanelContext()
  const terminal = useTerminalContext()
  const openAuxFolderTab = aux.openFolderTab
  const clearAuxFolderContext = aux.clearFolderToolContext
  const createTerminalInDirectory = terminal.createTerminalInDirectory
  const { setOpen: setSearchOpen } = useSearchDialog()
  const key = runtime.client.key
  const recoveryFiles = useRef(fileTabs)
  const recoveryAnchor = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    recoveryFiles.current = fileTabs
  }, [fileTabs])
  const captureDirtyFiles = useCallback(
    (): RecoveryBuffer[] =>
      recoveryFiles.current.flatMap((tab) =>
        tab.kind === "file" &&
        (tab.isDirty || tab.saveState === "error" || tab.saveState === "saving")
          ? [
              {
                kind: "file" as const,
                sourceId: tab.id,
                title: tab.title,
                path: tab.path,
                content: tab.content,
                language: tab.language,
                saveError: tab.saveError,
              },
            ]
          : []
      ),
    []
  )
  const captureComposerDrafts = useCallback((): RecoveryBuffer[] => {
    const root = recoveryAnchor.current?.closest("[data-runtime-generation]")
    if (!root) return []
    return [
      ...root.querySelectorAll<HTMLElement>(".ProseMirror[contenteditable]"),
    ].flatMap((editor, index) => {
      if (!editor.textContent && !editor.querySelector("img, [data-type]"))
        return []
      return [
        {
          kind: "composer" as const,
          sourceId: `composer-document:${index}`,
          title: `composer-document:${index}`,
          path: null,
          language: "html",
          content: editor.innerHTML,
        },
      ]
    })
  }, [])

  // File buffers change on each keystroke. Publish only tab metadata, preserving
  // the summary identity when content changes without changing dirty/title state.
  const signature = JSON.stringify([
    ...conversations.map(
      (tab): WindowResourceTab => ({
        ref: {
          backendKey: key,
          kind: "conversation",
          id: tab.id,
          folderId: tab.folderId,
        },
        title: tab.title,
        machineName: runtime.client.name,
        running: tab.status === "in_progress",
      })
    ),
    ...fileTabs.map(
      (tab): WindowResourceTab => ({
        ref: {
          backendKey: key,
          kind: "file",
          id: tab.id,
          path: tab.path ?? "",
        },
        title: tab.title,
        machineName: runtime.client.name,
        dirty: tab.isDirty === true,
      })
    ),
  ])
  const tabs = useMemo(
    () => JSON.parse(signature) as WindowResourceTab[],
    [signature]
  )
  const selected =
    tabs.find(
      (tab) =>
        tab.ref.kind === (activePane === "files" ? "file" : "conversation") &&
        tab.ref.id === (activePane === "files" ? activeFileTabId : activeTabId)
    )?.ref ?? null

  const select = useCallback(
    (ref: WindowResourceRef) => {
      if (ref.backendKey !== key) return
      openConversations()
      if (ref.kind === "file") workspace.switchFileTab(ref.id)
      else {
        clearAuxFolderContext()
        stores.tabs.getState().switchTab(ref.id)
        workspace.activateConversationPane()
      }
    },
    [key, openConversations, workspace, stores, clearAuxFolderContext]
  )

  const close = useCallback(
    (ref: WindowResourceRef) => {
      if (ref.backendKey !== key) return
      if (ref.kind === "file") workspace.closeFileTab(ref.id)
      else stores.tabs.getState().closeTab(ref.id)
    },
    [key, workspace, stores]
  )

  const restoreFile = useCallback(
    async (ref: Extract<WindowResourceRef, { kind: "file" }>) => {
      if (ref.backendKey !== key || !ref.path) return
      await workspace.openFilePreview(ref.path, { background: true })
    },
    [key, workspace]
  )

  const search = useCallback(() => setSearchOpen(true), [setSearchOpen])
  const navigate = useCallback(
    (route: RuntimeView["routeId"]) => {
      clearAuxFolderContext()
      if (route === "canvas" && routeId === "canvas")
        stores.canvasBoards.getState().closeBoard()
      setRoute(route)
    },
    [routeId, setRoute, stores, clearAuxFolderContext]
  )
  const newChat = useCallback(
    (folderless = false) => {
      clearAuxFolderContext()
      openConversations()
      const state = stores.workspace.getState()
      const folder = state.allFolders.find(
        (f) => f.id === state.activeFolderId && f.kind !== "chat"
      )
      if (folder && !folderless)
        stores.tabs.getState().openNewConversationTab(folder.id, folder.path)
      else stores.tabs.getState().openChatModeTab()
    },
    [openConversations, stores, clearAuxFolderContext]
  )
  const openLocationTool = useCallback(
    (tool: "files" | "git" | "terminal") => {
      openConversations()
      if (tool === "terminal") {
        const state = stores.workspace.getState()
        const folder = state.getFolder(state.activeFolderId ?? -1)
        if (folder)
          void createTerminalInDirectory(
            folder.path,
            folder.name,
            undefined,
            folder.id
          )
      } else {
        const state = stores.workspace.getState()
        const folder = state.getFolder(state.activeFolderId ?? -1)
        if (folder && folder.kind !== "chat")
          openAuxFolderTab(tool === "files" ? "file_tree" : "changes", folder)
      }
    },
    [openConversations, stores, createTerminalInDirectory, openAuxFolderTab]
  )
  const renameConversation = useCallback(
    async (conversation: DbConversationSummary, title: string) => {
      await runtime.client.api.updateConversationTitle(conversation.id, title)
      await stores.workspace.getState().refreshConversations()
    },
    [runtime, stores]
  )
  const deleteConversation = useCallback(
    async (conversation: DbConversationSummary) => {
      await runtime.client.api.deleteConversation(conversation.id)
      stores.tabs
        .getState()
        .closeConversationTab(
          conversation.folder_id,
          conversation.id,
          conversation.agent_type
        )
      await stores.workspace.getState().refreshConversations()
    },
    [runtime, stores]
  )
  const pinConversation = useCallback(
    async (conversation: DbConversationSummary, pinned: boolean) => {
      stores.workspace.getState().updateConversationLocal(conversation.id, {
        pinned_at: pinned ? new Date().toISOString() : null,
      })
      await runtime.client.api.updateConversationPinned(conversation.id, pinned)
    },
    [runtime, stores]
  )
  const statusConversation = useCallback(
    async (conversation: DbConversationSummary, status: ConversationStatus) => {
      stores.workspace
        .getState()
        .updateConversationLocal(conversation.id, { status })
      await runtime.client.api.updateConversationStatus(conversation.id, status)
    },
    [runtime, stores]
  )
  const view = useMemo<RuntimeView>(
    () => ({
      hydrated,
      tabs,
      selected,
      routeId,
      sidebarOpen: sidebar.isOpen,
      terminalOpen: terminal.isOpen,
      auxOpen: aux.isOpen,
      select,
      close,
      restoreFile,
      navigate,
      newChat,
      openLocationTool,
      renameConversation,
      deleteConversation,
      pinConversation,
      statusConversation,
      search,
      toggleSidebar: sidebar.toggle,
      toggleTerminal: terminal.toggle,
      toggleAux: aux.toggle,
      captureDirtyFiles,
      captureComposerDrafts,
    }),
    [
      tabs,
      selected,
      hydrated,
      routeId,
      navigate,
      newChat,
      openLocationTool,
      renameConversation,
      deleteConversation,
      pinConversation,
      statusConversation,
      sidebar.isOpen,
      sidebar.toggle,
      terminal.isOpen,
      terminal.toggle,
      aux.isOpen,
      aux.toggle,
      select,
      close,
      restoreFile,
      search,
      captureDirtyFiles,
      captureComposerDrafts,
    ]
  )

  useEffect(() => {
    runtime.publishView(view)
  }, [runtime, view])
  useEffect(
    () => () => {
      const last = runtime.getSnapshot()
      if (last) runtime.clearView(last)
    },
    [runtime]
  )
  return <span ref={recoveryAnchor} hidden aria-hidden />
}
