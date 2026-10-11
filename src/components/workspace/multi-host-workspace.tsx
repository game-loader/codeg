"use client"

import { BrowserEvalConfirm } from "@/components/browser/browser-eval-confirm"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import {
  PanelLeft,
  PanelRight,
  Search,
  Settings,
  SquareTerminal,
  Columns2,
  Rows2,
  X,
} from "lucide-react"
import { BackendRegistry, type BackendDescriptor } from "@/lib/backend/registry"
import {
  BackendRuntime,
  createWindowInstanceId,
  readWindowTabs,
  saveWindowTabs,
  runtimeRecoveryStore,
  type RuntimeView,
} from "@/lib/backend/runtime"
import type { BackendKey } from "@/lib/backend/types"
import { getShellTransport } from "@/lib/transport"
import { listRemoteWorkspaceConnections } from "@/lib/remote-workspace"
import {
  emptyWindowLayout,
  readWindowLayout,
  reconcileWindowDestination,
  retireWindowResources,
  saveWindowLayout,
  windowResourceKey,
  type MultiHostWindowLayout,
  type WindowResourceRef,
} from "@/lib/backend/window-layout"
import { BackendRuntimeView } from "./backend-runtime"
import { MultiHostSidebar, type HostFolderCatalog } from "./multi-host-sidebar"
import { MultiHostTabs, type WindowResourceTab } from "./multi-host-tabs"
import { HostWorktreeDialog } from "./host-worktree-dialog"
import { BackendClientProvider } from "@/contexts/backend-client-context"
import { BackendStoresProvider } from "@/contexts/backend-stores-context"
import { ScopedRemoteConnectionProvider } from "@/contexts/remote-connection-context"
import { WorkspaceFolderDialog } from "@/components/layout/workspace-folder-dialog"
import { RemoteWorkspaceManageDialog } from "@/components/layout/remote-workspace-manage-dialog"
import { WindowControls } from "@/components/layout/window-controls"
import { AppToaster } from "@/components/ui/app-toaster"
import { Button } from "@/components/ui/button"
import { usePlatform } from "@/hooks/use-platform"
import { cn } from "@/lib/utils"
import { toErrorMessage } from "@/lib/app-error"
import { saveTextFile } from "@/lib/save-file"
import type { FolderDetail } from "@/lib/types"
import type { WorkbenchRouteId } from "@/contexts/workbench-route-context"

interface HostSummary extends HostFolderCatalog {
  generation: number
  view: RuntimeView | null
}

function RuntimeObserver({
  runtime,
  onChange,
}: {
  runtime: BackendRuntime
  onChange(key: BackendKey, summary: HostSummary): void
}) {
  const state = useSyncExternalStore(
    runtime.stores.workspace.subscribe,
    runtime.stores.workspace.getState,
    runtime.stores.workspace.getInitialState
  )
  const view = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot
  )
  const folders = useMemo(() => {
    const opened = new Set(state.folders.map((folder) => folder.id))
    for (const folder of state.folders) {
      let parent = folder.parent_id
      const visited = new Set<number>()
      while (parent && !visited.has(parent)) {
        visited.add(parent)
        opened.add(parent)
        parent =
          state.allFolders.find((candidate) => candidate.id === parent)
            ?.parent_id ?? null
      }
    }
    return state.allFolders.filter((folder) => opened.has(folder.id))
  }, [state.folders, state.allFolders])
  useEffect(() => {
    onChange(runtime.client.key, {
      generation: runtime.generation,
      folders,
      loading: state.foldersLoading,
      view,
    })
  }, [onChange, runtime, folders, state.foldersLoading, view])
  return null
}

const ROUTES: WorkbenchRouteId[] = [
  "conversations",
  "tasks",
  "automations",
  "forge",
  "canvas",
  "academic",
  "tokenUsage",
  "machines",
]

function RecoveryBuffers() {
  const t = useTranslations("MultiHost")
  const records = useSyncExternalStore(
    runtimeRecoveryStore.subscribe,
    runtimeRecoveryStore.getSnapshot,
    runtimeRecoveryStore.getSnapshot
  )
  const [error, setError] = useState<string | null>(null)
  if (records.length === 0) return null
  return (
    <details
      open
      className="max-h-72 shrink-0 overflow-auto border-b bg-muted/40 px-3 py-2"
    >
      <summary className="cursor-pointer text-sm font-medium">
        {t("recoveryTitle")} · {records.length}
      </summary>
      <p className="py-1 text-xs text-muted-foreground">{t("recoveryHint")}</p>
      {records.map((record) => (
        <details
          open
          key={record.id}
          className="my-2 rounded border bg-background p-2"
        >
          <summary className="cursor-pointer text-xs">
            {record.machineName} · {record.backendKey} · {record.title}
          </summary>
          <p className="break-all py-1 text-xs text-muted-foreground">
            {record.destination ?? t("local")} ·{" "}
            {record.path ?? record.sourceId}
          </p>
          {record.saveError && (
            <p className="text-xs text-destructive">{record.saveError}</p>
          )}
          {!record.persisted && (
            <p role="alert" className="text-xs text-destructive">
              {t("recoveryMemoryOnly")}
            </p>
          )}
          <textarea
            readOnly
            aria-label={`${t("recoveryBuffer")} · ${record.machineName} · ${record.path ?? record.sourceId}`}
            value={record.content}
            className="mt-1 h-24 w-full resize-y rounded border p-2 font-mono text-xs"
          />
          <div className="mt-1 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(record.content)
                } catch {
                  setError(t("recoveryCopyFailed"))
                }
              }}
            >
              {t("recoveryCopy")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                try {
                  await saveTextFile({
                    content: JSON.stringify(record, null, 2),
                    suggestedName: `${record.title.replace(/[^\w.-]/g, "_")}.recovery.json`,
                    mimeType: "application/json;charset=utf-8",
                    filterName: t("recoveryTitle"),
                    ext: "json",
                  })
                } catch {
                  setError(t("recoveryExportFailed"))
                }
              }}
            >
              {t("recoveryExport")}
            </Button>
          </div>
        </details>
      ))}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </details>
  )
}

export function MultiHostWorkspace({
  renderWorkspace,
}: {
  renderWorkspace(runtime: BackendRuntime): ReactNode
}) {
  const t = useTranslations("MultiHost")
  const [localName] = useState(() => t("local"))
  const [registry, setRegistry] =
    useState<BackendRegistry<BackendRuntime> | null>(null)
  const [layout, setLayout] = useState(emptyWindowLayout)
  const [savedTabs, setSavedTabs] = useState(readWindowTabs)
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const [pendingSelection, setPendingSelection] =
    useState<WindowResourceRef | null>(null)
  const [summaries, setSummaries] = useState<
    ReadonlyMap<BackendKey, HostSummary>
  >(new Map())
  const [focused, setFocused] = useState<BackendKey>("local")
  const [machinesOpen, setMachinesOpen] = useState(true)
  const [manageOpen, setManageOpen] = useState(false)
  const [repositoryTarget, setRepositoryTarget] =
    useState<BackendRuntime | null>(null)
  const [worktreeTarget, setWorktreeTarget] = useState<{
    runtime: BackendRuntime
    folder: FolderDetail
  } | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [connectionsLoaded, setConnectionsLoaded] = useState(false)
  const [splitPercent, setSplitPercent] = useState(50)
  const refreshConnectionsRef = useRef<() => void>(() => {})
  const restored = useRef(new Set<string>())
  const { isMac } = usePlatform()

  const changeLayout = useCallback(
    (update: (previous: MultiHostWindowLayout) => MultiHostWindowLayout) => {
      setLayout((previous) => {
        const next = update(previous)
        return next
      })
    },
    []
  )

  useEffect(() => {
    const saved = readWindowLayout()
    setLayout(saved)
    setPendingSelection(saved.selected)
    runtimeRecoveryStore.reload()
    setFocused(
      saved.selected &&
        (saved.selected.backendKey === saved.primary ||
          saved.selected.backendKey === saved.secondary)
        ? saved.selected.backendKey
        : saved.primary
    )
    const shellTransport = getShellTransport()
    const windowInstanceId = createWindowInstanceId()
    const destinations = new Map(Object.entries(saved.destinations))
    const next = new BackendRegistry<BackendRuntime>((target, lifetime) => {
      const before = destinations.get(target.key)
      const url = target.connection?.base_url
      const runtime = new BackendRuntime(target, lifetime, {
        shellTransport,
        windowInstanceId,
        resetDestinationState: before !== undefined && before !== url,
        previousDestination: before,
        onConfigurationChanged: () => refreshConnectionsRef.current(),
      })
      if (url) destinations.set(target.key, url)
      return runtime
    })
    next.upsert({ key: "local", name: localName, connection: null })
    setRegistry(next)
    let disposed = false
    let request = 0
    const refresh = async () => {
      const sequence = ++request
      try {
        const connections = await listRemoteWorkspaceConnections()
        if (disposed || sequence !== request) return
        const wanted = new Map(
          connections.map((connection) => [
            `remote:${connection.id}` as BackendKey,
            connection.base_url,
          ])
        )
        const retired = new Set<BackendKey>()
        for (const [key, before] of destinations) {
          if (key !== "local" && wanted.get(key as BackendKey) !== before)
            retired.add(key as BackendKey)
        }
        for (const host of next.getSnapshot()) {
          if (host.key !== "local" && !wanted.has(host.key))
            retired.add(host.key)
        }
        // Retire the independently persisted companion state BEFORE advancing
        // destinations or mounting a replacement provider. This also covers a
        // URL edited elsewhere while this workspace window was closed.
        if (retired.size > 0) {
          setSavedTabs((tabs) =>
            tabs.filter((tab) => !retired.has(tab.ref.backendKey))
          )
          setPendingSelection((ref) =>
            ref && retired.has(ref.backendKey) ? null : ref
          )
          setClosed(
            (keys) =>
              new Set(
                [...keys].filter(
                  (key) =>
                    ![...retired].some((backendKey) =>
                      key.startsWith(`[${JSON.stringify(backendKey)},`)
                    )
                )
              )
          )
          for (const token of restored.current) {
            if ([...retired].some((key) => token.startsWith(`${key}:`)))
              restored.current.delete(token)
          }
        }
        changeLayout((previous) =>
          connections.reduce(
            (value, connection) =>
              reconcileWindowDestination(
                value,
                `remote:${connection.id}`,
                connection.base_url
              ),
            [...retired].reduce(retireWindowResources, previous)
          )
        )
        for (const connection of connections) {
          const key = `remote:${connection.id}` as const
          const current = next.get(key)?.client.remoteConnection
          if (current && current.config_revision !== connection.config_revision)
            next.remove(key)
        }
        next.syncRemoteConnections(connections)
        setConnectionsLoaded(true)
        setConnectionError(null)
      } catch (error) {
        if (!disposed && sequence === request)
          setConnectionError(toErrorMessage(error))
      }
    }
    refreshConnectionsRef.current = () => {
      void refresh()
    }
    void refresh()
    // Connection edits can originate in another settings window.
    const unsubscribe = shellTransport.onReconnect?.(() => {
      void refresh()
    })
    const onFocus = () => {
      void refresh()
    }
    window.addEventListener("focus", onFocus)
    const onPageHide = () => {
      disposed = true
      next.dispose()
    }
    window.addEventListener("pagehide", onPageHide)
    window.addEventListener("beforeunload", onPageHide)
    const onStorage = () => runtimeRecoveryStore.reload()
    window.addEventListener("storage", onStorage)
    return () => {
      disposed = true
      unsubscribe?.()
      window.removeEventListener("focus", onFocus)
      window.removeEventListener("beforeunload", onPageHide)
      window.removeEventListener("pagehide", onPageHide)
      window.removeEventListener("storage", onStorage)
      next.dispose()
    }
  }, [changeLayout, localName])

  useEffect(() => {
    if (registry?.get("local"))
      registry.upsert({ key: "local", name: t("local"), connection: null })
  }, [registry, t])

  const onSummary = useCallback((key: BackendKey, summary: HostSummary) => {
    setSummaries((previous) => {
      const before = previous.get(key)
      if (
        before?.folders === summary.folders &&
        before.generation === summary.generation &&
        before.loading === summary.loading &&
        before.view === summary.view
      )
        return previous
      const next = new Map(previous)
      next.set(key, summary)
      return next
    })
  }, [])

  return registry ? (
    <WindowWorkspace
      registry={registry}
      layout={layout}
      savedTabs={savedTabs}
      setSavedTabs={setSavedTabs}
      closed={closed}
      setClosed={setClosed}
      pendingSelection={pendingSelection}
      setPendingSelection={setPendingSelection}
      changeLayout={changeLayout}
      summaries={summaries}
      focused={focused}
      setFocused={setFocused}
      machinesOpen={machinesOpen}
      setMachinesOpen={setMachinesOpen}
      manageOpen={manageOpen}
      setManageOpen={setManageOpen}
      repositoryTarget={repositoryTarget}
      setRepositoryTarget={setRepositoryTarget}
      worktreeTarget={worktreeTarget}
      setWorktreeTarget={setWorktreeTarget}
      connectionError={connectionError}
      connectionsLoaded={connectionsLoaded}
      refreshConnections={() => refreshConnectionsRef.current()}
      splitPercent={splitPercent}
      setSplitPercent={setSplitPercent}
      restored={restored.current}
      onSummary={onSummary}
      renderWorkspace={renderWorkspace}
      isMac={isMac}
    />
  ) : (
    <div className="fixed inset-0 flex items-center justify-center bg-background text-muted-foreground">
      {t("loading")}
    </div>
  )
}

function WindowWorkspace({
  registry,
  layout,
  savedTabs,
  setSavedTabs,
  closed,
  setClosed,
  pendingSelection,
  setPendingSelection,
  changeLayout,
  summaries: cachedSummaries,
  focused,
  setFocused,
  machinesOpen,
  setMachinesOpen,
  manageOpen,
  setManageOpen,
  repositoryTarget,
  setRepositoryTarget,
  worktreeTarget,
  setWorktreeTarget,
  connectionError,
  connectionsLoaded,
  refreshConnections,
  splitPercent,
  setSplitPercent,
  restored,
  onSummary,
  renderWorkspace,
  isMac,
}: {
  registry: BackendRegistry<BackendRuntime>
  layout: MultiHostWindowLayout
  savedTabs: WindowResourceTab[]
  setSavedTabs: React.Dispatch<React.SetStateAction<WindowResourceTab[]>>
  closed: ReadonlySet<string>
  setClosed: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>
  pendingSelection: WindowResourceRef | null
  setPendingSelection: React.Dispatch<
    React.SetStateAction<WindowResourceRef | null>
  >
  changeLayout(
    update: (previous: MultiHostWindowLayout) => MultiHostWindowLayout
  ): void
  summaries: ReadonlyMap<BackendKey, HostSummary>
  focused: BackendKey
  setFocused(key: BackendKey): void
  machinesOpen: boolean
  setMachinesOpen(open: boolean): void
  manageOpen: boolean
  setManageOpen(open: boolean): void
  repositoryTarget: BackendRuntime | null
  setRepositoryTarget(runtime: BackendRuntime | null): void
  worktreeTarget: { runtime: BackendRuntime; folder: FolderDetail } | null
  setWorktreeTarget(
    target: { runtime: BackendRuntime; folder: FolderDetail } | null
  ): void
  connectionError: string | null
  connectionsLoaded: boolean
  refreshConnections(): void
  splitPercent: number
  setSplitPercent(value: number): void
  restored: Set<string>
  onSummary(key: BackendKey, summary: HostSummary): void
  renderWorkspace(runtime: BackendRuntime): ReactNode
  isMac: boolean
}) {
  const t = useTranslations("MultiHost")
  const tSidebar = useTranslations("Folder.sidebar")
  const tChrome = useTranslations("Folder.folderTitleBar")
  const tTokens = useTranslations("Folder.statusBar.tokens")
  const tAcademic = useTranslations("Academic")
  const hosts = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getSnapshot
  )
  const summaries = useMemo(
    () =>
      new Map(
        [...cachedSummaries].filter(([key, summary]) =>
          hosts.some(
            (host) => host.key === key && host.generation === summary.generation
          )
        )
      ),
    [cachedSummaries, hosts]
  )
  const focusedRuntime = registry.get(focused)
  const focusedView = summaries.get(focused)?.view
  const split = layout.split !== "none" && layout.secondary !== null
  const actualTabs = hosts.flatMap((host) =>
    (summaries.get(host.key)?.view?.tabs ?? []).map((tab) => ({
      ...tab,
      machineName: host.name,
    }))
  )
  const actualKeys = new Set(
    actualTabs.map((tab) => windowResourceKey(tab.ref))
  )
  const restorableFiles: WindowResourceTab[] = layout.files.map((ref) => ({
    ref,
    title: ref.path.split(/[\\/]/).pop() || ref.id,
    machineName: registry.descriptor(ref.backendKey)?.name ?? ref.backendKey,
  }))
  const placeholders = [...savedTabs, ...restorableFiles]
    .filter((tab, index, entries) => {
      const key = windowResourceKey(tab.ref)
      if (
        actualKeys.has(key) ||
        closed.has(key) ||
        entries.findIndex((entry) => windowResourceKey(entry.ref) === key) !==
          index
      )
        return false
      const host = registry.descriptor(tab.ref.backendKey)
      if (!host) return !connectionsLoaded
      // Replaced endpoints discard all old resources, including conversations.
      if (host?.baseUrl && layout.destinations[host.key] !== host.baseUrl)
        return false
      const view = summaries.get(tab.ref.backendKey)?.view
      return (
        !host ||
        host.status !== "connected" ||
        !view?.hydrated ||
        (tab.ref.kind === "file" &&
          !restored.has(`${host.key}:${host.generation}:${key}`))
      )
    })
    .map((tab) => ({
      ...tab,
      machineName:
        registry.descriptor(tab.ref.backendKey)?.name ?? tab.machineName,
    }))
  const order = new Map(
    savedTabs.map((tab, index) => [windowResourceKey(tab.ref), index])
  )
  const nextTabs = [...actualTabs, ...placeholders].sort(
    (left, right) =>
      (order.get(windowResourceKey(left.ref)) ?? Infinity) -
      (order.get(windowResourceKey(right.ref)) ?? Infinity)
  )
  const tabsSignature = JSON.stringify(nextTabs)
  const tabs = useMemo(
    () => JSON.parse(tabsSignature) as WindowResourceTab[],
    [tabsSignature]
  )
  const selectedCandidate =
    (pendingSelection?.backendKey === focused ? pendingSelection : null) ??
    focusedView?.selected ??
    (layout.selected?.backendKey === focused ? layout.selected : null)
  const selected =
    selectedCandidate &&
    tabs.some(
      (tab) =>
        windowResourceKey(tab.ref) === windowResourceKey(selectedCandidate)
    )
      ? selectedCandidate
      : null

  useEffect(() => {
    if (!connectionsLoaded || hosts.length === 0) return
    // Buffer-only updates keep the signature equal and never update metadata.
    setSavedTabs((previous) =>
      JSON.stringify(previous) === tabsSignature ? previous : tabs
    )
    saveWindowTabs(tabs)
    const files = tabs.flatMap((tab) =>
      tab.ref.kind === "file" && tab.ref.path ? [tab.ref] : []
    )
    const selectedKey = selected ? windowResourceKey(selected) : null
    const oldKey = layout.selected ? windowResourceKey(layout.selected) : null
    if (
      JSON.stringify(files) !== JSON.stringify(layout.files) ||
      selectedKey !== oldKey
    ) {
      changeLayout((previous) => ({ ...previous, files, selected }))
    }
  }, [
    tabs,
    selected,
    layout.selected,
    layout.files,
    changeLayout,
    hosts.length,
    connectionsLoaded,
    setSavedTabs,
    tabsSignature,
  ])
  useEffect(() => {
    if (connectionsLoaded && hosts.length > 0) saveWindowLayout(layout)
  }, [layout, hosts.length, connectionsLoaded])
  useEffect(() => {
    if (!connectionsLoaded || hosts.length === 0) return
    if (!registry.get(focused)) setFocused("local")
    if (
      !registry.get(layout.primary) ||
      (layout.secondary && !registry.get(layout.secondary))
    ) {
      changeLayout((previous) => ({
        ...previous,
        primary: registry.get(previous.primary) ? previous.primary : "local",
        secondary: null,
        split: "none",
      }))
    }
  }, [
    connectionsLoaded,
    registry,
    hosts,
    focused,
    layout.primary,
    layout.secondary,
    setFocused,
    changeLayout,
  ])
  useEffect(() => {
    document.title = `${registry.descriptor(focused)?.name ?? t("title")} - codeg`
  }, [registry, hosts, focused, t])

  useEffect(() => {
    if (!connectionsLoaded) return
    for (const host of hosts) {
      const view = summaries.get(host.key)?.view
      if (!view || host.status !== "connected") continue
      if (host.baseUrl && layout.destinations[host.key] !== host.baseUrl)
        continue
      for (const ref of layout.files.filter(
        (file) => file.backendKey === host.key
      )) {
        const token = `${host.key}:${host.generation}:${windowResourceKey(ref)}`
        if (
          view.tabs.some(
            (tab) => windowResourceKey(tab.ref) === windowResourceKey(ref)
          )
        ) {
          restored.add(token)
          continue
        }
        if (restored.has(token)) continue
        restored.add(token)
        void view.restoreFile(ref).catch(() => {
          restored.delete(token)
        })
      }
    }
  }, [
    registry,
    hosts,
    summaries,
    layout.files,
    layout.selected,
    layout.destinations,
    restored,
    connectionsLoaded,
  ])

  useEffect(() => {
    const ref = pendingSelection
    if (!ref || focused !== ref.backendKey) return
    const view = registry.get(ref.backendKey)?.getSnapshot()
    if (
      !view?.tabs.some(
        (tab) => windowResourceKey(tab.ref) === windowResourceKey(ref)
      )
    )
      return
    // The restored selection is consumed once the scoped tab exists.
    setPendingSelection(null)
    view.select(ref)
  }, [registry, summaries, focused, pendingSelection, setPendingSelection])

  const activateHost = (key: BackendKey) => {
    setPendingSelection(null)
    setFocused(key)
    if (key === layout.primary || (split && key === layout.secondary)) return
    changeLayout((previous) =>
      focused === previous.secondary && split
        ? { ...previous, secondary: key }
        : {
            ...previous,
            primary: key,
            secondary:
              previous.secondary === key
                ? previous.primary
                : previous.secondary,
          }
    )
  }
  const selectTab = (ref: WindowResourceRef) => {
    activateHost(ref.backendKey)
    registry.get(ref.backendKey)?.getSnapshot()?.select(ref)
    changeLayout((previous) => ({ ...previous, selected: ref }))
  }
  const closeTab = (ref: WindowResourceRef) => {
    const key = windowResourceKey(ref)
    if (pendingSelection && windowResourceKey(pendingSelection) === key)
      setPendingSelection(null)
    setClosed((previous) => new Set([...previous, key]))
    const view = registry.get(ref.backendKey)?.getSnapshot()
    if (
      view?.tabs.some(
        (tab) => windowResourceKey(tab.ref) === windowResourceKey(ref)
      )
    )
      view.close(ref)
    else
      changeLayout((previous) => ({
        ...previous,
        files: previous.files.filter(
          (file) => windowResourceKey(file) !== windowResourceKey(ref)
        ),
        selected:
          previous.selected &&
          windowResourceKey(previous.selected) === windowResourceKey(ref)
            ? null
            : previous.selected,
      }))
  }
  const openFolder = (key: BackendKey, folder: FolderDetail) => {
    const runtime = registry.get(key)
    if (!runtime) return
    activateHost(key)
    runtime.stores.workspace.getState().upsertFolder(folder)
    runtime.stores.workspace.getState().setActiveFolderId(folder.id)
    runtime.stores.tabs
      .getState()
      .openNewConversationTab(folder.id, folder.path)
    runtime.getSnapshot()?.navigate("conversations")
  }
  const refreshHost = (key: BackendKey) => {
    const runtime = registry.get(key)
    if (runtime) {
      void runtime.stores.workspace.getState().fetchFolders()
      void runtime.stores.workspace.getState().refreshConversations()
    }
  }
  const startSplit = (direction: "horizontal" | "vertical") => {
    const secondary =
      layout.secondary ?? hosts.find((host) => host.key !== layout.primary)?.key
    if (secondary)
      changeLayout((previous) => ({ ...previous, secondary, split: direction }))
  }
  const paneStyle = (host: BackendDescriptor) => {
    if (!split) return { inset: 0 }
    const secondary = host.key === layout.secondary
    return layout.split === "horizontal"
      ? {
          top: 0,
          bottom: 0,
          left: secondary ? `${splitPercent}%` : 0,
          width: `${secondary ? 100 - splitPercent : splitPercent}%`,
        }
      : {
          left: 0,
          right: 0,
          top: secondary ? `${splitPercent}%` : 0,
          height: `${secondary ? 100 - splitPercent : splitPercent}%`,
        }
  }

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-background text-foreground">
      <header
        className={cn(
          "flex h-10 shrink-0 items-center gap-1 border-b px-2",
          isMac && "pl-20"
        )}
      >
        <Button
          size="icon"
          variant="ghost"
          aria-label={t(machinesOpen ? "hideMachines" : "showMachines")}
          onClick={() => setMachinesOpen(!machinesOpen)}
        >
          <PanelLeft className="size-4" />
        </Button>
        <span className="max-w-40 truncate text-sm">
          {registry.descriptor(focused)?.name ?? focused}
        </span>
        <div data-tauri-drag-region className="h-full min-w-2 flex-1" />
        <Button
          size="icon"
          variant="ghost"
          aria-label={tChrome("search")}
          onClick={() => focusedView?.search()}
        >
          <Search className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={tChrome("toggleTerminal")}
          onClick={() => focusedView?.toggleTerminal()}
        >
          <SquareTerminal className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={tChrome("toggleAuxPanel")}
          onClick={() => focusedView?.toggleAux()}
        >
          <PanelRight className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t("horizontal")}
          disabled={hosts.length < 2}
          onClick={() => startSplit("horizontal")}
        >
          <Columns2 className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t("vertical")}
          disabled={hosts.length < 2}
          onClick={() => startSplit("vertical")}
        >
          <Rows2 className="size-4" />
        </Button>
        {split && (
          <Button
            size="icon"
            variant="ghost"
            aria-label={t("singleView")}
            onClick={() => {
              changeLayout((previous) => ({
                ...previous,
                primary: focused,
                secondary: null,
                split: "none",
              }))
            }}
          >
            <X className="size-4" />
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          aria-label={tChrome("openSettings")}
          onClick={() => {
            void focusedRuntime?.client.api.openSettingsWindow()
          }}
        >
          <Settings className="size-4" />
        </Button>
        <WindowControls />
      </header>
      <MultiHostTabs
        tabs={tabs}
        selected={selected}
        onSelect={selectTab}
        onClose={closeTab}
      />
      <RecoveryBuffers />
      {connectionError && (
        <div className="px-3 py-1 text-xs text-destructive">
          {connectionError}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {machinesOpen && (
          <MultiHostSidebar
            hosts={hosts}
            catalogs={summaries}
            focusedHost={focused}
            collapsed={layout.collapsedHosts}
            onToggleHost={(key) =>
              changeLayout((previous) => ({
                ...previous,
                collapsedHosts: previous.collapsedHosts.includes(key)
                  ? previous.collapsedHosts.filter((value) => value !== key)
                  : [...previous.collapsedHosts, key],
              }))
            }
            onSelectHost={activateHost}
            onOpenFolder={openFolder}
            onAddRepository={(key) =>
              setRepositoryTarget(registry.get(key) ?? null)
            }
            onWorktrees={(key, folder) => {
              const runtime = registry.get(key)
              if (runtime) setWorktreeTarget({ runtime, folder })
            }}
            onRefresh={refreshHost}
            onManageConnections={() => setManageOpen(true)}
          />
        )}
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          {hosts.map((host) => {
            const runtime = registry.get(host.key)!
            const visible =
              host.key === layout.primary ||
              (split && host.key === layout.secondary)
            return (
              <BackendRuntimeView
                key={`${host.key}:${host.generation}`}
                runtime={runtime}
                visible={visible}
                focused={visible && host.key === focused}
                expired={host.status === "unauthorized"}
                style={paneStyle(host)}
                onFocus={() => setFocused(host.key)}
              >
                <RuntimeObserver runtime={runtime} onChange={onSummary} />
                <div
                  className={cn(
                    "flex h-8 items-center gap-2 border-b px-2 text-xs",
                    focused === host.key && "bg-muted"
                  )}
                >
                  <select
                    aria-label={t(
                      host.key === layout.secondary ? "secondary" : "primary"
                    )}
                    value={host.key}
                    onChange={(event) => {
                      const key = event.target.value as BackendKey
                      setFocused(key)
                      changeLayout((previous) =>
                        host.key === previous.secondary
                          ? {
                              ...previous,
                              secondary: key,
                              primary:
                                key === previous.primary
                                  ? host.key
                                  : previous.primary,
                            }
                          : {
                              ...previous,
                              primary: key,
                              secondary:
                                key === previous.secondary
                                  ? host.key
                                  : previous.secondary,
                            }
                      )
                    }}
                  >
                    {hosts.map((machine) => (
                      <option key={machine.key} value={machine.key}>
                        {machine.name}
                      </option>
                    ))}
                  </select>
                  <span className="text-muted-foreground">
                    {t(host.status)}
                  </span>
                  <select
                    aria-label={t("title")}
                    className="ml-auto max-w-40"
                    value={
                      summaries.get(host.key)?.view?.routeId ?? "conversations"
                    }
                    onChange={(event) =>
                      runtime
                        .getSnapshot()
                        ?.navigate(event.target.value as WorkbenchRouteId)
                    }
                  >
                    {ROUTES.map((route) => (
                      <option key={route} value={route}>
                        {route === "conversations"
                          ? t("title")
                          : route === "tokenUsage"
                            ? tTokens("tokenUsage")
                            : route === "academic"
                              ? tAcademic("title")
                              : tSidebar(route)}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-6"
                    aria-label={tSidebar("title")}
                    onClick={() => runtime.getSnapshot()?.toggleSidebar()}
                  >
                    <PanelLeft className="size-3" />
                  </Button>
                </div>
                <div className="relative h-[calc(100%-2rem)] min-h-0">
                  {renderWorkspace(runtime)}
                </div>
                {(host.status === "offline" ||
                  host.status === "unauthorized") && (
                  <div className="absolute bottom-7 left-2 right-2 z-40 rounded border bg-background p-2 text-xs text-destructive">
                    {t("hostUnavailable")}{" "}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        refreshConnections()
                        refreshHost(host.key)
                      }}
                    >
                      {t("refresh")}
                    </Button>
                  </div>
                )}
              </BackendRuntimeView>
            )
          })}
          {!registry.get(layout.primary) && (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
              {t("hostUnavailable")}
            </div>
          )}
          {split && (
            <div
              role="separator"
              aria-label={t("split")}
              aria-orientation={
                layout.split === "horizontal" ? "vertical" : "horizontal"
              }
              className={cn(
                "absolute z-50 bg-border",
                layout.split === "horizontal"
                  ? "bottom-0 top-0 w-1 cursor-col-resize"
                  : "left-0 right-0 h-1 cursor-row-resize"
              )}
              style={
                layout.split === "horizontal"
                  ? { left: `${splitPercent}%` }
                  : { top: `${splitPercent}%` }
              }
              onPointerDown={(event) => {
                const element = event.currentTarget
                const bounds = element.parentElement!.getBoundingClientRect()
                element.setPointerCapture(event.pointerId)
                const move = (pointer: PointerEvent) =>
                  setSplitPercent(
                    Math.max(
                      20,
                      Math.min(
                        80,
                        layout.split === "horizontal"
                          ? ((pointer.clientX - bounds.left) / bounds.width) *
                              100
                          : ((pointer.clientY - bounds.top) / bounds.height) *
                              100
                      )
                    )
                  )
                const stop = () => {
                  element.removeEventListener("pointermove", move)
                  element.removeEventListener("lostpointercapture", stop)
                }
                element.addEventListener("pointermove", move)
                element.addEventListener("lostpointercapture", stop)
              }}
            />
          )}
        </div>
      </div>
      <RemoteWorkspaceManageDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        onChanged={refreshConnections}
      />
      {repositoryTarget &&
        registry.get(repositoryTarget.client.key) === repositoryTarget && (
          <BackendClientProvider client={repositoryTarget.client}>
            <BackendStoresProvider stores={repositoryTarget.stores}>
              <ScopedRemoteConnectionProvider
                connection={repositoryTarget.client.remoteConnection}
              >
                <WorkspaceFolderDialog
                  open
                  onOpenChange={(open) => {
                    if (!open) setRepositoryTarget(null)
                  }}
                  onFolderOpened={(folder) => {
                    openFolder(repositoryTarget.client.key, folder)
                    refreshHost(repositoryTarget.client.key)
                  }}
                />
              </ScopedRemoteConnectionProvider>
            </BackendStoresProvider>
          </BackendClientProvider>
        )}
      {worktreeTarget &&
        registry.get(worktreeTarget.runtime.client.key) ===
          worktreeTarget.runtime && (
          <HostWorktreeDialog
            key={`${worktreeTarget.runtime.generation}:${worktreeTarget.folder.id}`}
            client={worktreeTarget.runtime.client}
            repository={worktreeTarget.folder}
            open
            onOpenChange={(open) => {
              if (!open) setWorktreeTarget(null)
            }}
            onChanged={() => refreshHost(worktreeTarget.runtime.client.key)}
            onRegistered={(folder) =>
              openFolder(worktreeTarget.runtime.client.key, folder)
            }
          />
        )}
      {/* Native eval approval belongs to this window, not every machine pane. */}
      <BrowserEvalConfirm />
      <AppToaster position="bottom-right" duration={15000} closeButton />
    </div>
  )
}
