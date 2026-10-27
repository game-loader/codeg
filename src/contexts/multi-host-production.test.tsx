import { useEffect } from "react"
import {
  TabKeysSync,
  WorkbenchRouteConversationSync,
} from "@/components/workspace/runtime-conversation-bridges"
import {
  WorkbenchRouteProvider,
  useWorkbenchRoute,
} from "@/contexts/workbench-route-context"
import {
  CONNECTION_IDLE_TIMEOUT_MS,
  IDLE_SWEEP_INTERVAL_MS,
} from "@/lib/constants"
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BackendClientProvider } from "@/contexts/backend-client-context"
import { BackendStoresProvider } from "@/contexts/backend-stores-context"
import {
  AcpConnectionsProvider,
  STREAM_FLUSH_MAX_MS,
  useAcpActions,
  useConnectionStore,
} from "@/contexts/acp-connections-context"
import { AppWorkspaceProvider } from "@/contexts/app-workspace-context"
import { useActiveFolder } from "@/contexts/active-folder-context"
import {
  WorkspaceProvider,
  useWorkspaceContext,
} from "@/contexts/workspace-context"
import { TabProvider, useTabContext } from "@/contexts/tab-context"
import {
  TerminalProvider,
  useTerminalContext,
} from "@/contexts/terminal-context"
import { WorkspaceRuntimeVisibilityProvider } from "@/contexts/workspace-runtime-visibility-context"
import {
  CONNECTION_ID,
  CONTEXT_KEY,
  FILE,
  ROOT,
  conversation,
  createProductionHost,
  folder,
} from "./multi-host-production.test-helpers"
import {
  CONVERSATION_CHANGED_EVENT,
  FOLDER_CHANGED_EVENT,
  type ConversationChange,
  type FolderChange,
} from "@/lib/types"

// Stable translations and native/visual effects only. Never mock the API
// factory, scoped stores, provider actions, active folder or watcher hooks.
vi.mock("next-intl", () => {
  const t = (key: string) => key
  return { useTranslations: () => t }
})
vi.mock("@/lib/desktop-notification", () => ({
  notifyDesktop: vi.fn(async () => true),
  withDesktopNotificationsSuppressed: (fn: () => unknown) => fn(),
}))
vi.mock("@/lib/notification-sound", () => ({
  playEventSound: vi.fn(),
  primeNotificationSoundOutput: vi.fn(),
  withEventSoundsSuppressed: (fn: () => unknown) => fn(),
}))
vi.mock("sonner", () => ({
  toast: {
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
  },
}))

// A scoped consumer accidentally using the compatibility singleton must fail
// here, even if its own error handler swallows the transport error.
const boundary = vi.hoisted(() => ({
  legacyTransport: vi.fn(() => {
    throw new Error("Production multi-host consumer used the legacy transport")
  }),
  fetch: vi.fn(() => {
    throw new Error("Production provider test attempted network I/O")
  }),
}))
vi.mock("@/lib/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/transport")>()),
  getTransport: boundary.legacyTransport,
  getShellTransport: boundary.legacyTransport,
}))

type Observation = {
  acp: ReturnType<typeof useAcpActions>
  connections: ReturnType<typeof useConnectionStore>
  workspace: ReturnType<typeof useWorkspaceContext>
  tabs: ReturnType<typeof useTabContext>
  terminal: ReturnType<typeof useTerminalContext>
  activeFolder: ReturnType<typeof useActiveFolder>
  route: ReturnType<typeof useWorkbenchRoute>
}
type TestHost = ReturnType<typeof createProductionHost>

let hosts: TestHost[] = []
const observations = new Map<TestHost, Observation>()

function observe(host: TestHost): Observation {
  const value = observations.get(host)
  if (!value) throw new Error(`${host.host} providers are not mounted`)
  return value
}

/** Captures REAL context actions; all requests originate inside providers. */
function ProviderObserver({ host }: { host: TestHost }) {
  const acp = useAcpActions()
  const connections = useConnectionStore()
  const workspace = useWorkspaceContext()
  const tabs = useTabContext()
  const terminal = useTerminalContext()
  const activeFolder = useActiveFolder()
  const route = useWorkbenchRoute()
  useEffect(() => {
    observations.set(host, {
      acp,
      connections,
      workspace,
      tabs,
      terminal,
      activeFolder,
      route,
    })
  }, [host, acp, connections, workspace, tabs, terminal, activeFolder, route])
  return (
    <output data-testid={`active-folder-${host.host}`}>
      {activeFolder.activeFolder?.name ?? "none"}
    </output>
  )
}

function RetainedScope({
  host,
  visible,
  focused,
}: {
  host: TestHost
  visible: boolean
  focused: boolean
}) {
  return (
    <BackendClientProvider client={host.client}>
      <BackendStoresProvider stores={host.stores}>
        <WorkspaceRuntimeVisibilityProvider
          value={{ managed: true, visible, focused }}
        >
          <section data-testid={`scope-${host.host}`} hidden={!visible}>
            <AcpConnectionsProvider>
              <AppWorkspaceProvider>
                <WorkspaceProvider>
                  <TabProvider>
                    <TerminalProvider>
                      <WorkbenchRouteProvider>
                        <TabKeysSync />
                        <WorkbenchRouteConversationSync />
                        <ProviderObserver host={host} />
                      </WorkbenchRouteProvider>
                    </TerminalProvider>
                  </TabProvider>
                </WorkspaceProvider>
              </AppWorkspaceProvider>
            </AcpConnectionsProvider>
          </section>
        </WorkspaceRuntimeVisibilityProvider>
      </BackendStoresProvider>
    </BackendClientProvider>
  )
}

function DualHosts({
  a,
  b,
  split = false,
  focused = "A",
}: {
  a: TestHost
  b: TestHost
  split?: boolean
  focused?: "A" | "B"
}) {
  return (
    <div data-layout={split ? "split" : "single"}>
      <RetainedScope
        host={a}
        visible={split || focused === "A"}
        focused={focused === "A"}
      />
      <RetainedScope
        host={b}
        visible={split || focused === "B"}
        focused={focused === "B"}
      />
    </div>
  )
}

async function mountDualHosts() {
  const a = createProductionHost("A")
  const b = createProductionHost("B")
  hosts.push(a, b)
  const view = render(<DualHosts a={a} b={b} />)
  await act(async () => {})
  for (const host of [a, b]) {
    expect(observe(host).tabs.tabsHydrated).toBe(true)
    expect(host.stores.workspace.getState().foldersHydrated).toBe(true)
    expect(observe(host).activeFolder.activeFolder?.name).toBe(
      `${host.host} folder 1`
    )
  }
  return { a, b, view }
}

function connect(host: TestHost) {
  return observe(host).acp.connect(
    CONTEXT_KEY,
    "claude_code",
    ROOT,
    "same-session-1",
    1
  )
}

function send(host: TestHost, text: string) {
  return observe(host).acp.sendPrompt(CONTEXT_KEY, [{ type: "text", text }], {
    folderId: 1,
    conversationId: 1,
    clientMessageId: "same-message",
  })
}

function connection(host: TestHost) {
  const value = observe(host).connections.getConnection(CONTEXT_KEY)
  if (!value) throw new Error(`${host.host} has no connection`)
  return value
}

function liveText(host: TestHost) {
  return (
    connection(host)
      .liveMessage?.content.filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("") ?? ""
  )
}

async function flushStream() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(STREAM_FLUSH_MAX_MS + 1)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  hosts = []
  observations.clear()
  vi.stubGlobal("fetch", boundary.fetch)
})

afterEach(async () => {
  // Unmount while stores still exist; then drain watcher shutdown/eviction
  // grace periods and release held requests even when an assertion failed.
  cleanup()
  for (const host of hosts) host.transport.releasePending()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_601)
  })
  for (const host of hosts) host.stores.dispose()
  try {
    for (const host of hosts) {
      expect(host.transport.unexpectedCommands).toEqual([])
      expect(host.transport.attachments.size).toBe(0)
      expect(host.transport.reconnectListeners.size).toBe(0)
      expect(
        [...host.transport.listeners.values()].every((set) => !set.size)
      ).toBe(true)
    }
    expect(boundary.legacyTransport).not.toHaveBeenCalled()
    expect(boundary.fetch).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    observations.clear()
  }
})

describe("real production providers in retained backend scopes", () => {
  it("keeps a delayed A connect on A while B connects and sends with identical IDs", async () => {
    const { a, b, view } = await mountDualHosts()
    const releaseConnect = a.transport.holdNext("acp_connect")
    let pendingConnect!: Promise<void>
    await act(async () => {
      pendingConnect = connect(a)
    })
    expect(a.transport.requests("acp_connect")).toHaveLength(1)
    expect(observe(a).connections.getConnectPending(CONTEXT_KEY)).toBeDefined()
    expect(
      observe(b).connections.getConnectPending(CONTEXT_KEY)
    ).toBeUndefined()

    view.rerender(<DualHosts a={a} b={b} focused="B" />)
    await act(async () => {
      await connect(b)
      await send(b, "B during A connect")
    })
    expect(connection(b).connectionId).toBe(CONNECTION_ID)
    expect(observe(a).connections.getConnection(CONTEXT_KEY)).toBeUndefined()
    expect(a.transport.requests("acp_prompt")).toEqual([])
    expect(b.transport.requests("acp_prompt")).toEqual([
      {
        connectionId: CONNECTION_ID,
        blocks: [{ type: "text", text: "B during A connect" }],
        folderId: 1,
        conversationId: 1,
        clientMessageId: "same-message",
      },
    ])

    await act(async () => {
      releaseConnect()
      await pendingConnect
      await send(a, "A after late connect")
    })
    expect(connection(a).connectionId).toBe(CONNECTION_ID)
    expect(
      observe(a).connections.getConnectPending(CONTEXT_KEY)
    ).toBeUndefined()
    expect(a.transport.requests("acp_prompt")[0]?.blocks).toEqual([
      { type: "text", text: "A after late connect" },
    ])
    expect(b.transport.requests("acp_connect")).toHaveLength(1)
    expect(b.transport.requests("acp_prompt")).toHaveLength(1)
    expect(a.transport.attach).toHaveBeenCalledOnce()
    expect(b.transport.attach).toHaveBeenCalledOnce()
  })

  it("routes concurrent prompts and stream deltas while A's send response is delayed", async () => {
    const { a, b, view } = await mountDualHosts()
    await act(async () => {
      await Promise.all([connect(a), connect(b)])
    })
    const releaseSend = a.transport.holdNext("acp_prompt")
    let pendingSend!: Promise<void>
    let aSettled = false
    await act(async () => {
      pendingSend = send(a, "A prompt").then(() => {
        aSettled = true
      })
      await send(b, "B prompt")
    })
    expect(aSettled).toBe(false)
    view.rerender(<DualHosts a={a} b={b} split focused="B" />)
    act(() => {
      b.transport.emitAcp({ type: "content_delta", text: "B output" })
      a.transport.emitAcp({ type: "content_delta", text: "A late output" })
    })
    await flushStream()
    expect(liveText(a)).toBe("A late output")
    expect(liveText(b)).toBe("B output")
    expect(a.transport.requests("acp_prompt")[0]?.blocks).toEqual([
      { type: "text", text: "A prompt" },
    ])
    expect(b.transport.requests("acp_prompt")[0]?.blocks).toEqual([
      { type: "text", text: "B prompt" },
    ])
    await act(async () => {
      releaseSend()
      await pendingSend
    })
    expect(aSettled).toBe(true)
    expect(liveText(b)).toBe("B output")
  })

  it("keeps permission events and replies on A when B has the same request and connection IDs", async () => {
    const { a, b } = await mountDualHosts()
    await act(async () => {
      await Promise.all([connect(a), connect(b)])
    })
    const permission = (host: "A" | "B") => ({
      type: "permission_request" as const,
      request_id: "same-permission",
      tool_call: { title: `${host} edit`, rawInput: { file_path: FILE } },
      options: [{ option_id: "allow", name: "Allow", kind: "allow_once" }],
    })
    act(() => a.transport.emitAcp(permission("A")))
    expect(connection(a).pendingPermission?.request_id).toBe("same-permission")
    expect(connection(b).pendingPermission).toBeNull()
    act(() => b.transport.emitAcp(permission("B")))
    const bPermission = connection(b).pendingPermission
    expect(bPermission?.request_id).toBe("same-permission")

    await act(async () => {
      await observe(a).acp.respondPermission(
        CONTEXT_KEY,
        "same-permission",
        "allow"
      )
    })
    expect(a.transport.requests("acp_respond_permission")).toEqual([
      {
        connectionId: CONNECTION_ID,
        requestId: "same-permission",
        optionId: "allow",
      },
    ])
    expect(b.transport.requests("acp_respond_permission")).toEqual([])
    expect(connection(a).pendingPermission).toBeNull()
    expect(connection(b).pendingPermission).toBe(bPermission)
    act(() => {
      a.transport.emitAcp({
        type: "permission_resolved",
        request_id: "same-permission",
      })
    })
    expect(connection(b).pendingPermission).toBe(bPermission)
    await act(async () => {
      await observe(b).acp.respondPermission(
        CONTEXT_KEY,
        "same-permission",
        "allow"
      )
    })
    expect(b.transport.requests("acp_respond_permission")).toHaveLength(1)
    expect(connection(b).pendingPermission).toBeNull()
  })

  it("loads, edits and saves identical file paths on their original host through WorkspaceProvider", async () => {
    const { a, b, view } = await mountDualHosts()
    const releaseRead = a.transport.holdNext("read_file_for_edit")
    let pendingRead!: Promise<string | null>
    await act(async () => {
      pendingRead = observe(a).workspace.openFilePreview(FILE)
      await observe(b).workspace.openFilePreview(FILE)
    })
    expect(observe(a).workspace.fileTabs[0]?.loading).toBe(true)
    expect(observe(b).workspace.fileTabs[0]?.content).toBe("B disk contents")
    view.rerender(<DualHosts a={a} b={b} focused="B" />)
    await act(async () => {
      releaseRead()
      await pendingRead
    })
    const aFile = observe(a).workspace.fileTabs[0]!
    const bFile = observe(b).workspace.fileTabs[0]!
    expect(aFile.path).toBe(FILE)
    expect(bFile.path).toBe(FILE)
    expect(aFile.content).toBe("A disk contents")
    act(() => observe(a).workspace.updateActiveFileContent("A edited"))
    expect(observe(a).workspace.fileTabs[0]?.isDirty).toBe(true)
    expect(observe(b).workspace.fileTabs[0]?.isDirty).toBe(false)

    const releaseSave = a.transport.holdNext("save_file_content")
    let pendingSave!: Promise<boolean>
    await act(async () => {
      pendingSave = observe(a).workspace.saveActiveFile()
    })
    act(() => observe(b).workspace.updateActiveFileContent("B edited"))
    await act(async () => {
      expect(await observe(b).workspace.saveActiveFile()).toBe(true)
    })
    expect(observe(a).workspace.fileTabs[0]?.saveState).toBe("saving")
    expect(observe(b).workspace.fileTabs[0]?.savedContent).toBe("B edited")
    await act(async () => {
      releaseSave()
      expect(await pendingSave).toBe(true)
    })
    expect(a.transport.requests("save_file_content")).toEqual([
      {
        rootPath: `${ROOT}/src`,
        path: "shared.ts",
        content: "A edited",
        expectedEtag: "A-etag-1",
      },
    ])
    expect(b.transport.requests("save_file_content")).toEqual([
      {
        rootPath: `${ROOT}/src`,
        path: "shared.ts",
        content: "B edited",
        expectedEtag: "B-etag-1",
      },
    ])
    expect(a.transport.files.get(FILE)?.content).toBe("A edited")
    expect(b.transport.files.get(FILE)?.content).toBe("B edited")
    expect(observe(a).workspace.fileTabs[0]).toMatchObject({
      savedContent: "A edited",
      isDirty: false,
      etag: "A-etag-saved",
    })
    expect(observe(b).workspace.fileTabs[0]).toMatchObject({
      savedContent: "B edited",
      isDirty: false,
      etag: "B-etag-saved",
    })
  })

  it("keeps tab selection, active workspace and side-channel updates independent", async () => {
    const { a, b } = await mountDualHosts()
    const firstA = observe(a).tabs.tabs.find((tab) => tab.conversationId === 1)!
    const firstB = observe(b).tabs.tabs.find((tab) => tab.conversationId === 1)!
    const secondA = observe(a).tabs.tabs.find(
      (tab) => tab.conversationId === 2
    )!
    // Internal UI IDs may include the backend namespace; persisted resources
    // still deliberately collide and must select independent workspaces.
    expect(firstA).toMatchObject({ folderId: 1, conversationId: 1 })
    expect(firstB).toMatchObject({ folderId: 1, conversationId: 1 })
    act(() => observe(a).tabs.switchTab(secondA.id))
    expect(observe(a).tabs.activeTabId).toBe(secondA.id)
    expect(observe(a).activeFolder.activeFolderId).toBe(2)
    expect(observe(b).tabs.activeTabId).toBe(firstB.id)
    expect(observe(b).activeFolder.activeFolderId).toBe(1)

    act(() => {
      a.transport.emitBackend<FolderChange>(FOLDER_CHANGED_EVENT, {
        kind: "upsert",
        folder: { ...folder("A", 2), name: "A renamed folder" },
      })
      a.transport.emitBackend<ConversationChange>(CONVERSATION_CHANGED_EVENT, {
        kind: "upsert",
        summary: { ...conversation("A", 2), title: "A renamed conversation" },
      })
    })
    expect(screen.getByTestId("active-folder-A")).toHaveTextContent(
      "A renamed folder"
    )
    expect(screen.getByTestId("active-folder-B")).toHaveTextContent(
      "B folder 1"
    )
    expect(
      observe(a).tabs.tabs.find((tab) => tab.id === secondA.id)?.title
    ).toBe("A renamed conversation")
    expect(
      observe(b).tabs.tabs.find((tab) => tab.conversationId === 2)?.title
    ).toBe("B conversation 2")

    await act(async () => {
      await observe(a).workspace.openFilePreview(FILE)
    })
    expect(observe(a).workspace.activePane).toBe("files")
    expect(observe(b).workspace.activePane).toBe("conversation")
    act(() => observe(a).tabs.switchTab(firstA.id))
    expect(observe(a).workspace.activePane).toBe("conversation")
    expect(observe(a).activeFolder.activeFolderId).toBe(1)
    expect(observe(b).tabs.activeTabId).toBe(firstB.id)
  })

  it("retains subscriptions and terminals across hiding and split rerenders, with A still streaming into A", async () => {
    const { a, b, view } = await mountDualHosts()
    let aTerminal!: string | null
    let bTerminal!: string | null
    await act(async () => {
      await Promise.all([connect(a), connect(b)])
      aTerminal = await observe(a).terminal.createTerminalInDirectory(
        ROOT,
        "A terminal"
      )
      bTerminal = await observe(b).terminal.createTerminalInDirectory(
        ROOT,
        "B terminal"
      )
      await send(a, "keep A running")
      await send(b, "keep B running")
    })
    expect(aTerminal).toBeTruthy()
    expect(bTerminal).toBeTruthy()
    const aActions = observe(a).acp
    const aStore = observe(a).connections
    const aSubscription = [...a.transport.attachments.values()][0]
    const bSubscription = [...b.transport.attachments.values()][0]

    view.rerender(<DualHosts a={a} b={b} focused="B" />)
    expect(screen.getByTestId("scope-A")).not.toBeVisible()
    act(() =>
      a.transport.emitAcp({ type: "content_delta", text: "A while hidden" })
    )
    await flushStream()
    expect(liveText(a)).toBe("A while hidden")
    expect(liveText(b)).toBe("")
    view.rerender(<DualHosts a={a} b={b} split focused="B" />)
    expect(screen.getByTestId("scope-A")).toBeVisible()
    expect(screen.getByTestId("scope-B")).toBeVisible()
    act(() => {
      a.transport.emitAcp({ type: "content_delta", text: " and split" })
      b.transport.emitAcp({ type: "content_delta", text: "B split" })
    })
    await flushStream()
    expect(liveText(a)).toBe("A while hidden and split")
    expect(liveText(b)).toBe("B split")
    expect(observe(a).acp).toBe(aActions)
    expect(observe(a).connections).toBe(aStore)
    expect([...a.transport.attachments.values()]).toEqual([aSubscription])
    expect([...b.transport.attachments.values()]).toEqual([bSubscription])
    for (const host of [a, b]) {
      expect(host.transport.attach).toHaveBeenCalledOnce()
      expect(host.transport.requests("acp_cancel")).toEqual([])
      expect(host.transport.requests("acp_disconnect")).toEqual([])
      expect(host.transport.requests("terminal_kill")).toEqual([])
    }
    expect(observe(a).terminal.activeTabId).toBe(aTerminal)
    expect(observe(b).terminal.activeTabId).toBe(bTerminal)

    // Positive controls: teardown spies are wired, and an explicit user action
    // reaches only the owning host. Visibility transitions above did neither.
    await act(async () => {
      await observe(a).acp.cancel(CONTEXT_KEY)
      observe(a).terminal.closeTerminal(aTerminal!)
    })
    expect(a.transport.requests("acp_cancel")).toEqual([
      { connectionId: CONNECTION_ID },
    ])
    expect(a.transport.requests("terminal_kill")).toEqual([
      { terminalId: aTerminal },
    ])
    expect(b.transport.requests("acp_cancel")).toEqual([])
    expect(b.transport.requests("terminal_kill")).toEqual([])
    expect(observe(b).terminal.activeTabId).toBe(bTerminal)
  })
  it("keeps each production layout's inactive open conversation alive across idle sweeps", async () => {
    const { a, b } = await mountDualHosts()
    const firstA = a.stores.tabs.getState().tabs[0].id
    const secondA = a.stores.tabs.getState().tabs[1].id
    const firstB = b.stores.tabs.getState().tabs[0].id
    const secondB = b.stores.tabs.getState().tabs[1].id
    await act(async () => {
      await Promise.all([
        observe(a).acp.connect(
          firstA,
          "claude_code",
          ROOT,
          "same-session-1",
          1
        ),
        observe(b).acp.connect(
          firstB,
          "claude_code",
          ROOT,
          "same-session-1",
          1
        ),
      ])
      a.transport.emitAcp({ type: "status_changed", status: "connected" })
      b.transport.emitAcp({ type: "status_changed", status: "connected" })
      observe(a).tabs.switchTab(secondA)
      observe(b).tabs.switchTab(secondB)
      observe(a).acp.setActiveKey(secondA)
      observe(b).acp.setActiveKey(secondB)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        CONNECTION_IDLE_TIMEOUT_MS + 2 * IDLE_SWEEP_INTERVAL_MS + 1
      )
    })
    expect(a.transport.requests("acp_touch_connection")).not.toHaveLength(0)
    expect(b.transport.requests("acp_touch_connection")).not.toHaveLength(0)
    expect(a.transport.requests("acp_disconnect")).toHaveLength(0)
    expect(b.transport.requests("acp_disconnect")).toHaveLength(0)
    expect(observe(a).connections.getConnection(firstA)?.status).toBe(
      "connected"
    )
    expect(observe(b).connections.getConnection(firstB)?.status).toBe(
      "connected"
    )
    // Positive control: losing the actual registration reproduces the old
    // layout bug, without disabling or mocking the production idle sweep.
    act(() => observe(a).acp.registerOpenTabKeys(new Set()))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        CONNECTION_IDLE_TIMEOUT_MS + 2 * IDLE_SWEEP_INTERVAL_MS + 1
      )
    })
    expect(a.transport.requests("acp_disconnect")).toEqual([
      { connectionId: CONNECTION_ID },
    ])
    expect(b.transport.requests("acp_disconnect")).toHaveLength(0)
  })

  it("reveals only the initiating host's conversation route on scoped tab activation", async () => {
    const { a, b } = await mountDualHosts()
    await act(async () => {
      observe(a).route.setRoute("tasks")
      observe(b).route.setRoute("forge")
    })
    await act(async () =>
      observe(a).tabs.switchTab(a.stores.tabs.getState().tabs[1].id)
    )
    expect(observe(a).route.routeId).toBe("conversations")
    expect(observe(b).route.routeId).toBe("forge")
  })
})
