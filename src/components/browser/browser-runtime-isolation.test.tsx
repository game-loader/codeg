import { act, cleanup, render, renderHook } from "@testing-library/react"
import { StrictMode, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import type { BackendClient } from "@/lib/backend/types"
import type { BrowserTabState } from "@/lib/browser/types"

type Handler = (payload: unknown) => void
const shell = vi.hoisted(() => ({
  handlers: new Map<string, Set<Handler>>(),
  subscribe: vi.fn((event: string, handler: Handler) => {
    const handlers = shell.handlers.get(event) ?? new Set<Handler>()
    handlers.add(handler)
    shell.handlers.set(event, handlers)
    return Promise.resolve(() => handlers.delete(handler))
  }),
  close: vi.fn<(id: string, requestId?: string) => Promise<void>>(() =>
    Promise.resolve()
  ),
  listTabs: vi.fn<() => Promise<BrowserTabState[]>>(() => Promise.resolve([])),
  grant: vi.fn(() => Promise.resolve()),
  answer: vi.fn(() => Promise.resolve()),
  hostRules: vi.fn(() => Promise.resolve()),
}))

vi.mock("@/lib/transport", () => ({
  getShellTransport: () => ({ subscribe: shell.subscribe }),
  isDesktop: () => true,
}))
vi.mock("@/lib/browser/blank-page-theme", () => ({
  watchBlankPageTheme: () => () => {},
}))
vi.mock("@/lib/browser/browser-api", () => ({
  browserCapabilities: () => Promise.resolve({ available: true }),
  browserListTabs: shell.listTabs,
  browserListDownloads: () => Promise.resolve([]),
  browserClose: shell.close,
  browserAgentGrant: shell.grant,
  browserAnswerOpenRequest: shell.answer,
  browserSetHostRules: shell.hostRules,
  browserSetSignInUserAgent: () => Promise.resolve(),
}))
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => workspaces.get(useBackendClient())!.actions,
  useWorkspaceFileTabs: () => ({
    fileTabs: workspaces.get(useBackendClient())!.fileTabs,
  }),
}))

import {
  BackendClientProvider,
  useBackendClient,
} from "@/contexts/backend-client-context"
import { WorkspaceRuntimeVisibilityProvider } from "@/contexts/workspace-runtime-visibility-context"
import { createBackendClient } from "@/lib/backend/client"
import {
  markBrowserTabHidden,
  releaseBrowserTab,
  resetBrowserTabStoreForTests,
  setBrowserTabState,
  useBrowserAgentActivity,
  useBrowserFindRequest,
} from "@/lib/browser/browser-tab-store"
import {
  resetBrowserPrefsForTests,
  setBrowserSuspendBackgroundTabs,
} from "@/lib/browser/browser-prefs"
import { resetDefaultAgentGrantForTests } from "@/lib/browser/browser-agent-grant"
import {
  BROWSER_TAB_SUSPEND_AFTER_MS,
  browserTabsStorageKey,
  readPersistedBrowserTabs,
  writePersistedBrowserTabs,
} from "@/lib/browser/browser-tab-persistence"
import { resetBrowserRuntimeScopeForTests } from "@/lib/browser/browser-runtime-scope"
import { BrowserEventsBridge } from "./browser-events-bridge"
import {
  BrowserTabsPersistence,
  resetBrowserTabsPersistenceForTests,
} from "./browser-tabs-persistence"
import { BrowserTabsSuspender, SUSPEND_POLL_MS } from "./browser-tabs-suspender"

function workspace() {
  return {
    fileTabs: [] as FileWorkspaceTab[],
    actions: {
      adoptBrowserTab: vi.fn(
        (params: { backendTabId: string }) => `browser:${params.backendTabId}`
      ),
      closeFileTab: vi.fn(),
      openBrowserTab: vi.fn(() => "browser:opened"),
      restoreBrowserTabs: vi.fn(),
      suspendBrowserTab: vi.fn(),
    },
  }
}
const workspaces = new Map<BackendClient, ReturnType<typeof workspace>>()

function client(connectionId?: number) {
  const transport = {
    isDesktop: () => true,
    call: vi.fn(() => Promise.resolve(undefined as never)),
    subscribe: vi.fn(() => Promise.resolve(() => {})),
  }
  const result = createBackendClient({
    key: connectionId ? `remote:${connectionId}` : "local",
    name: connectionId ? `Host ${connectionId}` : "Local",
    remoteConnectionId: connectionId,
    baseUrl: `http://host-${connectionId ?? "local"}:3000`,
    desktop: true,
    transport,
  })
  workspaces.set(result, workspace())
  return result
}

function Runtime({
  client,
  focused = false,
  children,
}: {
  client: BackendClient
  focused?: boolean
  children: ReactNode
}) {
  return (
    <BackendClientProvider client={client}>
      <WorkspaceRuntimeVisibilityProvider
        value={{ managed: true, visible: focused, focused }}
      >
        {children}
      </WorkspaceRuntimeVisibilityProvider>
    </BackendClientProvider>
  )
}

function tab(id: string, profile = "default"): FileWorkspaceTab {
  return {
    id: `browser:${id}`,
    kind: "browser",
    folderId: 1,
    title: id,
    path: null,
    browser: {
      initialUrl: `https://example.com/${id}`,
      openerTabId: null,
      profile,
    },
  } as FileWorkspaceTab
}

function state(id: string, profile = "default"): BrowserTabState {
  return {
    tabId: id,
    ownerWindow: "main",
    kind: "page",
    surface: "child",
    channel: "native",
    channelError: null,
    url: `https://example.com/${id}`,
    requestedUrl: `https://example.com/${id}`,
    title: id,
    favicon: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    origin: "https://example.com",
    zoom: 1,
    error: null,
    remoteHost: null,
    openerTabId: null,
    profile,
    agentGrant: null,
  }
}

function emit(event: string, payload: unknown) {
  act(() => {
    for (const handler of shell.handlers.get(`browser://${event}`) ?? []) {
      handler(payload)
    }
  })
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe("native browser runtime isolation", () => {
  beforeEach(() => {
    localStorage.clear()
    shell.handlers.clear()
    vi.clearAllMocks()
    shell.listTabs.mockResolvedValue([])
    workspaces.clear()
    resetBrowserRuntimeScopeForTests()
    resetBrowserTabStoreForTests()
    resetBrowserTabsPersistenceForTests()
    resetBrowserPrefsForTests()
    resetDefaultAgentGrantForTests()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it("adopts each popup into its connection once while another host is focused", async () => {
    const local = client()
    const a = client(1)
    const b = client(2)
    workspaces.get(b)!.fileTabs = [tab("b-public")]
    render(
      <>
        <Runtime client={local}>
          <BrowserEventsBridge />
        </Runtime>
        <Runtime client={a}>
          <BrowserEventsBridge />
        </Runtime>
        <Runtime client={b} focused>
          <BrowserEventsBridge />
        </Runtime>
      </>
    )
    await flush()
    expect(shell.subscribe).toHaveBeenCalledTimes(13)
    const popup = {
      presentation: "adopted",
      openerTabId: "gone",
      tabId: "a-popup",
      url: "http://localhost:3000/popup",
      requestedSize: null,
      reason: null,
      profile: "remote-1",
    }
    // No opener or popup state: the explicit remote profile is sufficient.
    emit("popup", popup)
    expect(workspaces.get(a)!.actions.adoptBrowserTab).toHaveBeenCalledTimes(1)
    expect(workspaces.get(b)!.actions.adoptBrowserTab).not.toHaveBeenCalled()
    expect(
      workspaces.get(local)!.actions.adoptBrowserTab
    ).not.toHaveBeenCalled()

    // Public pages use ordinary profiles; their native UUID still belongs
    // to the runtime whose workspace record issued it.
    emit("popup", {
      ...popup,
      tabId: "b-popup",
      openerTabId: "b-public",
      profile: "default",
    })
    expect(workspaces.get(b)!.actions.adoptBrowserTab).toHaveBeenCalledTimes(1)
    emit("popup", { ...popup, tabId: "foreign", profile: "remote-99" })
    expect(
      workspaces.get(local)!.actions.adoptBrowserTab
    ).not.toHaveBeenCalled()

    // A shell-supplied connection identity also routes ordinary profiles.
    emit("popup", {
      ...popup,
      tabId: "a-explicit",
      profile: "default",
      hostConnectionId: 1,
    })
    expect(workspaces.get(a)!.actions.adoptBrowserTab).toHaveBeenCalledTimes(2)
  })

  it("opens and answers requests only in the explicit owner, with generic requests owned by local", async () => {
    const local = client()
    const a = client(1)
    const b = client(2)
    render(
      <>
        <Runtime client={local}>
          <BrowserEventsBridge />
        </Runtime>
        <Runtime client={a}>
          <BrowserEventsBridge />
        </Runtime>
        <Runtime client={b} focused>
          <BrowserEventsBridge />
        </Runtime>
      </>
    )
    await flush()
    const request = {
      url: "http://localhost:3000/",
      source: "modifier-click",
      activate: true,
      ownerWindow: "main",
      openerTabId: "gone",
      profile: "remote-1",
      requestId: "a-request",
    }
    emit("open-request", request)
    expect(workspaces.get(a)!.actions.openBrowserTab).toHaveBeenCalledTimes(1)
    expect(shell.answer).toHaveBeenCalledTimes(1)
    emit("open-request", {
      ...request,
      openerTabId: null,
      profile: null,
      requestId: "local-request",
    })
    expect(workspaces.get(local)!.actions.openBrowserTab).toHaveBeenCalledTimes(
      1
    )
    expect(workspaces.get(b)!.actions.openBrowserTab).not.toHaveBeenCalled()
    expect(shell.answer).toHaveBeenCalledTimes(2)
    emit("open-request", {
      ...request,
      profile: "remote-99",
      requestId: "unknown",
    })
    emit("open-request", {
      ...request,
      ownerWindow: "another-window",
      requestId: "foreign",
    })
    expect(shell.answer).toHaveBeenCalledTimes(2)
  })

  it("uses exactly the owner's fixed platform for grants and updates shell counters once", async () => {
    const local = client()
    const a = client(1)
    const b = client(2)
    workspaces.get(b)!.fileTabs = [tab("b-public")]
    render(
      <>
        <Runtime client={local}>
          <BrowserEventsBridge />
        </Runtime>
        <Runtime client={a}>
          <BrowserEventsBridge />
        </Runtime>
        <Runtime client={b} focused>
          <BrowserEventsBridge />
        </Runtime>
      </>
    )
    await flush()
    emit("state", state("a-tab", "remote-1"))
    emit("state", state("b-public"))
    expect(shell.grant).not.toHaveBeenCalled()
    emit("state", state("local-tab"))
    expect(shell.grant.mock.calls).toEqual([["local-tab", "control"]])
    emit("shortcut", { tabId: "local-tab", shortcut: "find" })
    const find = renderHook(() => useBrowserFindRequest("browser:local-tab"))
    expect(find.result.current).toBe(1)
    emit("agent-activity", {
      tabId: "local-tab",
      action: "read",
      outcome: "done",
      at: 10,
    })
    const activity = renderHook(() =>
      useBrowserAgentActivity("browser:local-tab")
    )
    expect(activity.result.current[0].count).toBe(1)
    expect(shell.hostRules).toHaveBeenCalledTimes(1)
    expect(local.transport.call).not.toHaveBeenCalled()
    expect(a.transport.call).not.toHaveBeenCalled()
    expect(b.transport.call).not.toHaveBeenCalled()
  })

  it("sweeps only A's orphans on A replacement while retaining B's native tabs and subscriptions", async () => {
    const a = client(1)
    const b = client(2)
    workspaces.get(b)!.fileTabs = [tab("b-public")]
    const view = (owner: BackendClient) => (
      <>
        <Runtime key="a" client={owner}>
          <BrowserEventsBridge />
        </Runtime>
        <Runtime key="b" client={b} focused>
          <BrowserEventsBridge />
        </Runtime>
      </>
    )
    const { rerender } = render(view(a))
    await flush()
    shell.listTabs.mockResolvedValue([
      state("a-orphan", "remote-1"),
      state("b-tab", "remote-2"),
      state("b-public"),
      { ...state("a-other-window", "remote-1"), ownerWindow: "another-window" },
      state("local-tab"),
    ])
    const replacement = client(1)
    rerender(view(replacement))
    await flush()
    expect(shell.close.mock.calls).toEqual([["a-orphan"]])
    expect(shell.subscribe).toHaveBeenCalledTimes(13)
    emit("popup", {
      presentation: "adopted",
      openerTabId: "gone",
      tabId: "new-a",
      url: "http://localhost:3000/",
      profile: "remote-1",
    })
    expect(
      workspaces.get(replacement)!.actions.adoptBrowserTab
    ).toHaveBeenCalledTimes(1)
    expect(workspaces.get(a)!.actions.adoptBrowserTab).not.toHaveBeenCalled()
    emit("closed", { tabId: "b-public", ownerWindow: "main", requestId: null })
    expect(workspaces.get(b)!.actions.closeFileTab.mock.calls).toEqual([
      ["browser:b-public"],
    ])
    expect(
      workspaces.get(replacement)!.actions.closeFileTab
    ).not.toHaveBeenCalled()
  })

  it("drops a disposed runtime's delayed orphan sweep", async () => {
    const a = client(1)
    const b = client(2)
    let resolve!: (tabs: BrowserTabState[]) => void
    shell.listTabs.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const { rerender } = render(
      <>
        <Runtime client={a}>
          <BrowserEventsBridge />
        </Runtime>
        <Runtime client={b}>
          <BrowserEventsBridge />
        </Runtime>
      </>
    )
    await flush()
    rerender(
      <Runtime client={b}>
        <BrowserEventsBridge />
      </Runtime>
    )
    await act(async () =>
      resolve([state("late-a", "remote-1"), state("b-tab", "remote-2")])
    )
    expect(shell.close).not.toHaveBeenCalled()
  })

  it("consumes a suspension close once without removing any host's tab record", async () => {
    const a = client(1)
    const b = client(2)
    workspaces.get(a)!.fileTabs = [tab("a-suspended")]
    render(
      <>
        <Runtime client={a}>
          <BrowserEventsBridge />
        </Runtime>
        <Runtime client={b}>
          <BrowserEventsBridge />
        </Runtime>
      </>
    )
    await flush()
    releaseBrowserTab("browser:a-suspended", { suspending: true })
    const requestId = shell.close.mock.calls[0][1]
    emit("closed", { tabId: "a-suspended", ownerWindow: "main", requestId })
    expect(workspaces.get(a)!.actions.closeFileTab).not.toHaveBeenCalled()
    expect(workspaces.get(b)!.actions.closeFileTab).not.toHaveBeenCalled()
  })

  it("releases settled listeners immediately and drops events from a late subscription after unmount", async () => {
    const a = client(1)
    let lateHandler!: Handler
    let resolve!: (unsubscribe: () => boolean) => void
    shell.subscribe.mockImplementationOnce((_event, handler) => {
      lateHandler = handler
      return new Promise((done) => {
        resolve = done
      })
    })
    const { unmount } = render(
      <Runtime client={a}>
        <BrowserEventsBridge />
      </Runtime>
    )
    await flush()
    unmount()
    for (const handlers of shell.handlers.values()) {
      expect(handlers.size).toBe(0)
    }
    const unsubscribe = vi.fn(() => true)
    await act(async () => resolve(unsubscribe))
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    lateHandler(state("late-local"))
    expect(shell.grant).not.toHaveBeenCalled()
  })

  it("restores and writes distinct backend keys at main, including a new generation", async () => {
    vi.useFakeTimers()
    const a = client(1)
    const b = client(2)
    const entries = (name: string) => [
      {
        url: `https://example.com/${name}`,
        title: name,
        folderId: 1,
        profile: "default",
      },
    ]
    writePersistedBrowserTabs(entries("A"), "main", a.key)
    writePersistedBrowserTabs(entries("B"), "main", b.key)
    writePersistedBrowserTabs(entries("legacy"), "main")
    workspaces.get(a)!.fileTabs = [tab("A")]
    workspaces.get(b)!.fileTabs = [tab("B")]
    const view = (owner: BackendClient) => (
      <StrictMode>
        <Runtime key="a" client={owner}>
          <BrowserTabsPersistence />
        </Runtime>
        <Runtime key="b" client={b}>
          <BrowserTabsPersistence />
        </Runtime>
      </StrictMode>
    )
    const { rerender } = render(view(a))
    await flush()
    expect(workspaces.get(a)!.actions.restoreBrowserTabs.mock.calls).toEqual([
      [entries("A")],
    ])
    expect(workspaces.get(b)!.actions.restoreBrowserTabs.mock.calls).toEqual([
      [entries("B")],
    ])
    expect(browserTabsStorageKey("main", a.key)).not.toBe(
      browserTabsStorageKey("main", b.key)
    )
    act(() => {
      setBrowserTabState({
        ...state("A"),
        url: "https://example.com/a-live",
        title: "A live",
      })
      setBrowserTabState({
        ...state("B"),
        url: "https://example.com/b-live",
        title: "B live",
      })
      vi.advanceTimersByTime(500)
    })
    expect(readPersistedBrowserTabs("main", a.key)[0].title).toBe("A live")
    expect(readPersistedBrowserTabs("main", b.key)[0].title).toBe("B live")
    expect(readPersistedBrowserTabs("main")).toEqual(entries("legacy"))

    const replacement = client(1)
    rerender(view(replacement))
    await flush()
    expect(
      workspaces.get(replacement)!.actions.restoreBrowserTabs.mock.calls
    ).toEqual([
      [
        [
          {
            ...entries("A")[0],
            url: "https://example.com/a-live",
            title: "A live",
          },
        ],
      ],
    ])
    workspaces.get(replacement)!.fileTabs = []
    rerender(view(replacement))
    act(() => vi.advanceTimersByTime(500))
    expect(readPersistedBrowserTabs("main", a.key)).toEqual([])
    expect(readPersistedBrowserTabs("main", b.key)[0].title).toBe("B live")
  })

  it("suspends hidden tabs only through their runtime and stops A's timer on replacement", async () => {
    vi.useFakeTimers()
    setBrowserSuspendBackgroundTabs(true)
    const a = client(1)
    const b = client(2)
    workspaces.get(a)!.fileTabs = [tab("a-idle"), tab("wrong-host", "remote-2")]
    workspaces.get(b)!.fileTabs = [tab("b-idle")]
    for (const id of ["a-idle", "b-idle", "wrong-host"]) {
      setBrowserTabState(
        state(id, id === "wrong-host" ? "remote-2" : "default")
      )
      markBrowserTabHidden(`browser:${id}`)
    }
    const { rerender } = render(
      <>
        <Runtime client={a}>
          <BrowserTabsSuspender />
        </Runtime>
        <Runtime client={b} focused>
          <BrowserTabsSuspender />
        </Runtime>
      </>
    )
    act(() => vi.advanceTimersByTime(BROWSER_TAB_SUSPEND_AFTER_MS))
    expect(workspaces.get(a)!.actions.suspendBrowserTab.mock.calls).toEqual([
      ["browser:a-idle"],
    ])
    expect(workspaces.get(b)!.actions.suspendBrowserTab.mock.calls).toEqual([
      ["browser:b-idle"],
    ])
    const replacement = client(1)
    rerender(
      <>
        <Runtime client={replacement}>
          <BrowserTabsSuspender />
        </Runtime>
        <Runtime client={b} focused>
          <BrowserTabsSuspender />
        </Runtime>
      </>
    )
    act(() => vi.advanceTimersByTime(SUSPEND_POLL_MS))
    expect(workspaces.get(a)!.actions.suspendBrowserTab).toHaveBeenCalledTimes(
      1
    )
    expect(
      workspaces.get(replacement)!.actions.suspendBrowserTab
    ).not.toHaveBeenCalled()
  })
})
