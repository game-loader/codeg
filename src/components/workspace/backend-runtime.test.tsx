import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { useState, useSyncExternalStore } from "react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BackendRuntimeView, RuntimeBridge } from "./backend-runtime"
import { BackendRegistry } from "@/lib/backend/registry"
import { BackendRuntime } from "@/lib/backend/runtime"
import { useBackendClient } from "@/contexts/backend-client-context"
import type { BackendKey } from "@/lib/backend/types"
import type {
  FileWorkspaceTab,
  WorkspacePane,
} from "@/contexts/workspace-context"
import type { WindowResourceRef } from "@/lib/backend/window-layout"
import { MultiHostTabs } from "./multi-host-tabs"
import messages from "@/i18n/messages/en.json"
import {
  firstLeafId,
  leafIds,
  singleGroupLayout,
  splitGroup,
} from "@/lib/tab-group-layout"
import { groupOfTab } from "@/stores/tab-store"

const picker = vi.hoisted(() => ({
  open: vi.fn(),
  services: vi.fn().mockResolvedValue([]),
}))
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: picker.open }))
vi.mock("@/lib/browser/browser-api", () => ({
  browserListServices: picker.services,
}))
vi.mock("@/lib/browser/use-browser-capabilities", () => ({
  useBrowserCapabilities: () => ({ available: true }),
}))
vi.mock("@/lib/transport", async (original) => ({
  ...(await original<typeof import("@/lib/transport")>()),
  isDesktop: () => true,
}))

interface Fixture {
  files: FileWorkspaceTab[]
  activeFileTabId: string
  activePane: WorkspacePane
  actions: {
    switchFileTab: ReturnType<typeof vi.fn>
    closeFileTab: ReturnType<typeof vi.fn>
    closeOtherFileTabs: ReturnType<typeof vi.fn>
    closeAllFileTabs: ReturnType<typeof vi.fn>
    openBrowserTab: ReturnType<typeof vi.fn>
    activateConversationPane: ReturnType<typeof vi.fn>
    openFilePreview: ReturnType<typeof vi.fn>
  }
  route: {
    routeId: "conversations"
    openConversations: ReturnType<typeof vi.fn>
    setRoute: ReturnType<typeof vi.fn>
  }
  toggle: ReturnType<typeof vi.fn>
  setSearchOpen: ReturnType<typeof vi.fn>
}
const fixtures = new Map<BackendKey, Fixture>()
function useFixture() {
  return fixtures.get(useBackendClient().key)!
}
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => useFixture().actions,
  useWorkspaceFileTabs: () => {
    const fixture = useFixture()
    return { fileTabs: fixture.files, activeFileTabId: fixture.activeFileTabId }
  },
  useWorkspaceView: () => ({ activePane: useFixture().activePane }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => useFixture().route,
}))
vi.mock("@/contexts/sidebar-context", () => ({
  useSidebarContext: () => ({ isOpen: false, toggle: useFixture().toggle }),
}))
vi.mock("@/contexts/aux-panel-context", () => ({
  useAuxPanelContext: () => ({
    isOpen: false,
    toggle: useFixture().toggle,
    clearFolderToolContext: useFixture().toggle,
  }),
}))
vi.mock("@/contexts/terminal-context", () => ({
  useTerminalContext: () => ({ isOpen: false, toggle: useFixture().toggle }),
}))
vi.mock("@/contexts/search-dialog-context", () => ({
  useSearchDialog: () => ({ setOpen: useFixture().setSearchOpen }),
}))

const registries: BackendRegistry<BackendRuntime>[] = []
function setup(local = false) {
  const shell = {
    call: vi.fn(),
    subscribe: vi.fn().mockResolvedValue(() => {}),
    isDesktop: () => true,
  }
  const registry = new BackendRegistry(
    (target, lifetime) =>
      new BackendRuntime(target, lifetime, {
        shellTransport: shell,
        windowInstanceId: "test-window",
        createRemoteTransport: () => shell,
      })
  )
  registries.push(registry)
  for (const id of [1, 2]) {
    const key = local && id === 1 ? "local" : (`remote:${id}` as const)
    const runtime = registry.upsert(
      key === "local"
        ? { key, name: key, connection: null }
        : {
            key,
            name: key,
            connection: {
              id,
              name: key,
              base_url: `http://host-${id}`,
              token: "",
              headers: [],
              sort_order: id,
              created_at: "",
              updated_at: "",
            },
          }
    )
    runtime.stores.tabs.setState({
      tabs: [
        {
          id: "conversation-1",
          kind: "conversation",
          folderId: 1,
          conversationId: 1,
          agentType: "claude_code",
          title: "Conversation",
          isPinned: true,
          status: "in_progress",
        },
      ],
      activeTabId: "conversation-1",
      tabsHydrated: true,
      switchTab: vi.fn(),
      closeTab: vi.fn(),
    })
    fixtures.set(key, {
      files: [
        {
          id: "file:/same/a.ts",
          kind: "file",
          folderId: null,
          path: "/same/a.ts",
          title: "a.ts",
          description: null,
          language: "typescript",
          content: "huge buffer",
          loading: false,
          isDirty: false,
        },
      ],
      activeFileTabId: "file:/same/a.ts",
      activePane: "files",
      actions: {
        switchFileTab: vi.fn(),
        closeFileTab: vi.fn(),
        closeOtherFileTabs: vi.fn(),
        closeAllFileTabs: vi.fn(),
        openBrowserTab: vi.fn(),
        activateConversationPane: vi.fn(),
        openFilePreview: vi.fn().mockResolvedValue("/same/a.ts"),
      },
      route: {
        routeId: "conversations",
        openConversations: vi.fn(),
        setRoute: vi.fn(),
      },
      toggle: vi.fn(),
      setSearchOpen: vi.fn(),
    })
  }
  return registry
}
function view(runtime: BackendRuntime, visible = true, focused = visible) {
  return (
    <BackendRuntimeView
      runtime={runtime}
      visible={visible}
      focused={focused}
      expired={false}
      onFocus={() => {}}
    >
      <RuntimeBridge runtime={runtime} />
      <div data-testid={runtime.client.key} />
    </BackendRuntimeView>
  )
}
beforeEach(() => {
  localStorage.clear()
  fixtures.clear()
  picker.open.mockReset().mockResolvedValue(null)
  picker.services.mockClear()
})
afterEach(() => {
  act(() => {
    for (const registry of registries.splice(0)) registry.dispose()
  })
})

describe("runtime bridge", () => {
  it("publishes actual file and conversation metadata with stable identity across buffer-only changes", () => {
    const registry = setup()
    const a = registry.get("remote:1")!
    const publish = vi.spyOn(a, "publishView")
    const rendered = render(view(a))
    const first = a.getSnapshot()!
    expect(first.tabs).toHaveLength(2)
    expect(first.tabs[0].running).toBe(true)
    expect(first.selected).toMatchObject({
      backendKey: "remote:1",
      kind: "file",
      id: "file:/same/a.ts",
    })
    expect(JSON.stringify(first)).not.toContain("huge buffer")
    expect(publish).toHaveBeenCalledOnce()
    fixtures.get("remote:1")!.files = [
      { ...fixtures.get("remote:1")!.files[0], content: "another huge buffer" },
    ]
    rendered.rerender(view(a))
    expect(a.getSnapshot()).toBe(first)
    expect(publish).toHaveBeenCalledOnce()
    fixtures.get("remote:1")!.files = [
      { ...fixtures.get("remote:1")!.files[0], isDirty: true },
    ]
    rendered.rerender(view(a))
    expect(a.getSnapshot()?.tabs[1].dirty).toBe(true)
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it("binds outer select/close/restore callbacks to their provider and rejects a foreign machine", async () => {
    const registry = setup()
    const a = registry.get("remote:1")!
    const b = registry.get("remote:2")!
    render(
      <>
        {view(a)}
        {view(b)}
      </>
    )
    const ref: WindowResourceRef = {
      backendKey: "remote:1",
      kind: "file",
      id: "file:/same/a.ts",
      path: "/same/a.ts",
    }
    const actions = a.getSnapshot()!
    act(() => {
      actions.select(ref)
      actions.close(ref)
      actions.select({ ...ref, backendKey: "remote:2" })
      actions.close({ ...ref, backendKey: "remote:2" })
    })
    expect(
      fixtures.get("remote:1")?.actions.switchFileTab
    ).toHaveBeenCalledOnce()
    expect(
      fixtures.get("remote:1")?.actions.closeFileTab
    ).toHaveBeenCalledOnce()
    expect(
      fixtures.get("remote:2")?.actions.switchFileTab
    ).not.toHaveBeenCalled()
    await actions.restoreFile(ref)
    expect(
      fixtures.get("remote:1")?.actions.openFilePreview
    ).toHaveBeenCalledWith("/same/a.ts", { background: true })
    act(() => {
      actions.select({
        backendKey: "remote:1",
        kind: "conversation",
        id: "conversation-1",
        folderId: 1,
      })
    })
    expect(a.stores.tabs.getState().switchTab).toHaveBeenCalledWith(
      "conversation-1"
    )
    expect(b.stores.tabs.getState().switchTab).not.toHaveBeenCalled()
  })

  it("keeps scopes alive while hidden and clears only the unmounted bridge", () => {
    const registry = setup()
    const a = registry.get("remote:1")!
    const b = registry.get("remote:2")!
    const rendered = render(
      <>
        {view(a)}
        {view(b, false)}
      </>
    )
    const before = a.getSnapshot()
    const node = screen.getByTestId("remote:1")
    rendered.rerender(
      <>
        {view(a, false)}
        {view(b)}
      </>
    )
    expect(screen.getByTestId("remote:1")).toBe(node)
    expect(node.closest("[data-runtime-generation]")).toHaveAttribute("inert")
    expect(a.getSnapshot()).toBe(before)
    expect(a.stores.workspace.isDisposed()).toBe(false)
    rendered.unmount()
    expect(a.getSnapshot()).toBeNull()
    expect(b.getSnapshot()).toBeNull()
    expect(a.stores.workspace.isDisposed()).toBe(false)
  })
})

// Same production boundary as the bridge tests above: real retained runtime
// providers, stores, bridge, strip and Radix menus; only workspace leaf actions
// and the native dialog are substituted. The strip lives outside both owners.
function Controls({
  a,
  b,
  initialFocus = b.client.key,
}: {
  a: BackendRuntime
  b: BackendRuntime
  initialFocus?: BackendKey
}) {
  const [focused, setFocused] = useState(initialFocus)
  const aView = useSyncExternalStore(a.subscribe, a.getSnapshot, a.getSnapshot)
  const bView = useSyncExternalStore(b.subscribe, b.getSnapshot, b.getSnapshot)
  const focusedView = focused === a.client.key ? aView : bView
  const owner = (ref: WindowResourceRef) =>
    ref.backendKey === a.client.key ? aView : bView
  return (
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <MultiHostTabs
        tabs={[...(aView?.tabs ?? []), ...(bView?.tabs ?? [])]}
        selected={focusedView?.selected ?? null}
        onSelect={(ref) => {
          setFocused(ref.backendKey)
          owner(ref)?.select(ref)
        }}
        onClose={(ref) => owner(ref)?.close(ref)}
        renderTabMenu={(ref, trigger) =>
          owner(ref)?.renderTabMenu?.(ref, trigger) ?? trigger
        }
        onTabAddMenuHost={focusedView?.setTabAddMenuHost}
      />
      {view(a, focused === a.client.key, focused === a.client.key)}
      {view(b, focused === b.client.key, focused === b.client.key)}
    </NextIntlClientProvider>
  )
}

function seedConversations(runtime: BackendRuntime, draft = false) {
  const tab = runtime.stores.tabs.getState().tabs[0]
  const tabs = [
    { ...tab, conversationId: draft ? null : tab.conversationId },
    { ...tab, id: "conversation-2", conversationId: 2, title: "Second" },
  ]
  runtime.stores.tabs.setState({
    tabs,
    rawTabs: tabs,
    activeTabId: tab.id,
    groupLayout: singleGroupLayout("owner-group"),
    groupOf: {},
    groupSelection: { "owner-group": tab.id },
    tileByGroup: {},
  })
}

async function conversationMenu(
  machine: string,
  action: string,
  title = "Conversation"
) {
  fireEvent.contextMenu(
    screen.getByRole("tab", { name: `${title} ${machine}` })
  )
  await act(async () => {
    screen.getByRole("menuitem", { name: action }).click()
  })
}

async function openFileAddMenu() {
  const trigger = screen.getByRole("button", { name: "New tab" })
  await act(async () => {
    for (const type of ["pointerdown", "pointerup", "click"]) {
      fireEvent(
        trigger,
        new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })
      )
    }
  })
}

describe("unified controls with real runtime owners", () => {
  it.each(["right", "down"] as const)(
    "splits %s on A while B is focused and both hosts reuse tab IDs",
    async (direction) => {
      const registry = setup()
      const a = registry.get("remote:1")!,
        b = registry.get("remote:2")!
      seedConversations(a)
      seedConversations(b)
      const splitA = vi.spyOn(a.stores.tabs.getState(), "splitTab")
      const splitB = vi.spyOn(b.stores.tabs.getState(), "splitTab")
      const beforeB = b.stores.tabs.getState().groupLayout
      render(<Controls a={a} b={b} />)
      const aNode = screen.getByTestId("remote:1"),
        bNode = screen.getByTestId("remote:2")
      expect(bNode.closest("[data-runtime-generation]")).toHaveAttribute(
        "data-runtime-focused",
        "true"
      )
      await conversationMenu(
        "remote:1",
        direction === "right" ? "Split Right" : "Split Down"
      )
      expect(splitA).toHaveBeenCalledWith("conversation-1", direction, {
        move: false,
      })
      expect(splitB).not.toHaveBeenCalled()
      expect(leafIds(a.stores.tabs.getState().groupLayout)).toHaveLength(2)
      expect(b.stores.tabs.getState().groupLayout).toBe(beforeB)
      expect(screen.getAllByRole("tablist")).toHaveLength(1)
      expect(screen.getByTestId("remote:1")).toBe(aNode)
      expect(screen.getByTestId("remote:2")).toBe(bNode)
    }
  )

  it("tiles and untiles the clicked group, then dissolves a persisted split on A only", async () => {
    const registry = setup()
    const a = registry.get("remote:1")!,
      b = registry.get("remote:2")!
    seedConversations(a)
    seedConversations(b)
    a.stores.tabs.setState({
      groupLayout: splitGroup(
        singleGroupLayout("owner-group"),
        "owner-group",
        "right",
        "other-group"
      ),
      groupOf: {
        "conversation-1": "other-group",
        "conversation-2": "owner-group",
      },
      groupSelection: {
        "other-group": "conversation-1",
        "owner-group": "conversation-2",
      },
      tileByGroup: { "other-group": true },
    })
    const tileA = vi.spyOn(a.stores.tabs.getState(), "toggleGroupTile")
    const dissolveA = vi.spyOn(a.stores.tabs.getState(), "dissolveGroup")
    const tileB = vi.spyOn(b.stores.tabs.getState(), "toggleGroupTile")
    const dissolveB = vi.spyOn(b.stores.tabs.getState(), "dissolveGroup")
    render(<Controls a={a} b={b} />)
    await conversationMenu("remote:1", messages.Folder.tabs.untileDisplay)
    expect(a.stores.tabs.getState().tileByGroup["other-group"]).toBe(false)
    await conversationMenu("remote:1", messages.Folder.tabs.tileDisplay)
    expect(a.stores.tabs.getState().tileByGroup["other-group"]).toBe(true)
    expect(tileA).toHaveBeenNthCalledWith(1, "other-group")
    expect(tileA).toHaveBeenNthCalledWith(2, "other-group")
    await conversationMenu("remote:1", "Unsplit")
    expect(dissolveA).toHaveBeenCalledWith("other-group")
    expect(leafIds(a.stores.tabs.getState().groupLayout)).toEqual([
      "owner-group",
    ])
    expect(tileB).not.toHaveBeenCalled()
    expect(dissolveB).not.toHaveBeenCalled()
  })

  it.each(["right", "down"] as const)(
    "retains split-and-move %s, move group, orientation and unsplit-all actions",
    async (direction) => {
      const registry = setup()
      const a = registry.get("remote:1")!,
        b = registry.get("remote:2")!
      seedConversations(a)
      seedConversations(b)
      const splitA = vi.spyOn(a.stores.tabs.getState(), "splitTab")
      const moveA = vi.spyOn(a.stores.tabs.getState(), "moveTabToGroup")
      const orientationA = vi.spyOn(
        a.stores.tabs.getState(),
        "toggleGroupOrientation"
      )
      const unsplitA = vi.spyOn(a.stores.tabs.getState(), "unsplitAll")
      render(<Controls a={a} b={b} />)
      await conversationMenu(
        "remote:1",
        direction === "right" ? "Split and Move Right" : "Split and Move Down"
      )
      expect(splitA).toHaveBeenCalledWith("conversation-1", direction, {
        move: true,
      })
      const movedGroup = groupOfTab(
        a.stores.tabs.getState().groupOf,
        a.stores.tabs.getState().groupLayout,
        "conversation-1"
      )
      expect(movedGroup).not.toBe("owner-group")
      await conversationMenu("remote:1", "Change Splitter Orientation")
      expect(orientationA).toHaveBeenCalledWith(movedGroup)
      expect(a.stores.tabs.getState().groupLayout).toMatchObject({
        orientation: direction === "right" ? "vertical" : "horizontal",
      })
      await conversationMenu("remote:1", "Move to Opposite Group")
      expect(moveA).toHaveBeenCalledWith("conversation-1", "owner-group")
      await conversationMenu("remote:1", "Split Right")
      await conversationMenu("remote:1", "Split Down")
      expect(
        leafIds(a.stores.tabs.getState().groupLayout).length
      ).toBeGreaterThanOrEqual(3)
      await conversationMenu("remote:1", "Unsplit All")
      expect(unsplitA).toHaveBeenCalledOnce()
      expect(leafIds(a.stores.tabs.getState().groupLayout)).toEqual([
        firstLeafId(a.stores.tabs.getState().groupLayout),
      ])
      expect(leafIds(b.stores.tabs.getState().groupLayout)).toEqual([
        "owner-group",
      ])
    }
  )

  it("keeps drafts group-bound while retaining plain split and group controls", () => {
    const registry = setup()
    const a = registry.get("remote:1")!,
      b = registry.get("remote:2")!
    seedConversations(a, true)
    seedConversations(b)
    a.stores.tabs.setState({
      groupLayout: splitGroup(
        singleGroupLayout("owner-group"),
        "owner-group",
        "right",
        "other-group"
      ),
    })
    render(<Controls a={a} b={b} />)
    fireEvent.contextMenu(
      screen.getByRole("tab", { name: "Conversation remote:1" })
    )
    expect(
      screen.getByRole("menuitem", { name: "Split and Move Right" })
    ).toHaveAttribute("data-disabled")
    expect(
      screen.getByRole("menuitem", { name: "Split and Move Down" })
    ).toHaveAttribute("data-disabled")
    expect(
      screen.queryByRole("menuitem", { name: "Move to Opposite Group" })
    ).toBeNull()
    expect(
      screen.getByRole("menuitem", { name: "Split Right" })
    ).not.toHaveAttribute("data-disabled")
    expect(
      screen.getByRole("menuitem", { name: "Unsplit" })
    ).toBeInTheDocument()
  })

  it("moves to a numbered group through the original submenu on the captured host", async () => {
    const registry = setup()
    const a = registry.get("remote:1")!,
      b = registry.get("remote:2")!
    seedConversations(a)
    seedConversations(b)
    const tabs = [
      ...a.stores.tabs.getState().tabs,
      {
        ...a.stores.tabs.getState().tabs[0],
        id: "conversation-3",
        conversationId: 3,
        title: "Third",
      },
    ]
    a.stores.tabs.setState({
      tabs,
      rawTabs: tabs,
      groupLayout: splitGroup(
        splitGroup(
          singleGroupLayout("owner-group"),
          "owner-group",
          "right",
          "second-group"
        ),
        "second-group",
        "right",
        "third-group"
      ),
      groupOf: {
        "conversation-1": "owner-group",
        "conversation-2": "second-group",
        "conversation-3": "third-group",
      },
      groupSelection: {
        "owner-group": "conversation-1",
        "second-group": "conversation-2",
        "third-group": "conversation-3",
      },
    })
    const moveA = vi.spyOn(a.stores.tabs.getState(), "moveTabToGroup")
    const moveB = vi.spyOn(b.stores.tabs.getState(), "moveTabToGroup")
    render(<Controls a={a} b={b} />)
    fireEvent.contextMenu(
      screen.getByRole("tab", { name: "Conversation remote:1" })
    )
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Move to Group" }), {
      key: "ArrowRight",
    })
    await act(async () => {
      screen.getByRole("menuitem", { name: "Group 3 Third" }).click()
    })
    expect(moveA).toHaveBeenCalledWith("conversation-1", "third-group")
    expect(moveB).not.toHaveBeenCalled()
    expect(a.stores.tabs.getState().groupOf["conversation-1"]).toBe(
      "third-group"
    )
  })

  it("preserves conversation close-others group scope and closes all only on A", async () => {
    const registry = setup()
    const a = registry.get("remote:1")!,
      b = registry.get("remote:2")!
    seedConversations(a)
    seedConversations(b)
    const tabs = [
      ...a.stores.tabs.getState().tabs,
      {
        ...a.stores.tabs.getState().tabs[0],
        id: "conversation-3",
        conversationId: 3,
        title: "Third",
      },
    ]
    a.stores.tabs.setState({
      tabs,
      rawTabs: tabs,
      groupLayout: splitGroup(
        singleGroupLayout("owner-group"),
        "owner-group",
        "right",
        "other-group"
      ),
      groupOf: { "conversation-3": "other-group" },
      groupSelection: {
        "owner-group": "conversation-1",
        "other-group": "conversation-3",
      },
    })
    const othersA = vi.spyOn(a.stores.tabs.getState(), "closeOtherTabs")
    const allA = vi.spyOn(a.stores.tabs.getState(), "closeAllTabs")
    const allB = vi.spyOn(b.stores.tabs.getState(), "closeAllTabs")
    render(<Controls a={a} b={b} />)
    await conversationMenu("remote:1", "Close Others")
    expect(othersA).toHaveBeenCalledWith("conversation-1")
    expect(a.stores.tabs.getState().tabs.map((tab) => tab.id)).toEqual([
      "conversation-1",
      "conversation-3",
    ])
    expect(b.stores.tabs.getState().tabs).toHaveLength(2)
    await conversationMenu("remote:1", "Close All")
    expect(allA).toHaveBeenCalledOnce()
    expect(allB).not.toHaveBeenCalled()
    expect(a.stores.tabs.getState().tabs).toHaveLength(0)
    expect(b.stores.tabs.getState().tabs).toHaveLength(2)
  })

  it("routes file close-others/all through A's existing dirty-close actions", async () => {
    const registry = setup()
    const a = registry.get("remote:1")!,
      b = registry.get("remote:2")!
    render(<Controls a={a} b={b} />)
    for (const action of ["Close Others", "Close All"]) {
      fireEvent.contextMenu(screen.getByRole("tab", { name: "a.ts remote:1" }))
      await act(async () => {
        screen.getByRole("menuitem", { name: action }).click()
      })
    }
    expect(
      fixtures.get("remote:1")!.actions.closeOtherFileTabs
    ).toHaveBeenCalledWith("file:/same/a.ts")
    expect(
      fixtures.get("remote:1")!.actions.closeAllFileTabs
    ).toHaveBeenCalledOnce()
    expect(
      fixtures.get("remote:2")!.actions.closeOtherFileTabs
    ).not.toHaveBeenCalled()
    expect(
      fixtures.get("remote:2")!.actions.closeAllFileTabs
    ).not.toHaveBeenCalled()
  })

  it("offers one focused add menu, with native picking only in the actual local owner context", async () => {
    const registry = setup(true)
    const a = registry.get("local")!,
      b = registry.get("remote:2")!
    render(<Controls a={a} b={b} />)
    expect(screen.getAllByRole("button", { name: "New tab" })).toHaveLength(1)
    await openFileAddMenu()
    expect(screen.queryByRole("menuitem", { name: "Open file…" })).toBeNull()
    await act(async () => {
      screen.getByRole("menuitem", { name: "Browser tab" }).click()
    })
    expect(
      fixtures.get("remote:2")!.actions.openBrowserTab
    ).toHaveBeenCalledWith("about:blank")
    expect(picker.services).not.toHaveBeenCalled()
    const aNode = screen.getByTestId("local"),
      bNode = screen.getByTestId("remote:2")
    fireEvent.click(screen.getByRole("tab", { name: "a.ts local" }))
    expect(screen.getAllByRole("button", { name: "New tab" })).toHaveLength(1)
    expect(
      within(screen.getByRole("tablist")).getByRole("button", {
        name: "New tab",
      })
    ).toBeInTheDocument()
    picker.open.mockResolvedValue("/tmp/src/../review-note.md")
    await openFileAddMenu()
    await act(async () => {
      screen.getByRole("menuitem", { name: "Open file…" }).click()
    })
    expect(picker.open).toHaveBeenCalledWith({ title: "Open file" })
    expect(fixtures.get("local")!.actions.openFilePreview).toHaveBeenCalledWith(
      "/tmp/review-note.md"
    )
    expect(
      fixtures.get("remote:2")!.actions.openFilePreview
    ).not.toHaveBeenCalled()
    expect(picker.services).toHaveBeenCalledOnce()
    expect(screen.getAllByRole("tablist")).toHaveLength(1)
    expect(screen.getByTestId("local")).toBe(aNode)
    expect(screen.getByTestId("remote:2")).toBe(bNode)
    expect(JSON.stringify(a.getSnapshot()!.tabs)).not.toContain("react")
  })

  it("rejects an open menu action after its captured generation retires", async () => {
    const registry = setup()
    const a = registry.get("remote:1")!,
      b = registry.get("remote:2")!
    seedConversations(a)
    const tile = vi.spyOn(a.stores.tabs.getState(), "toggleGroupTile")
    render(<Controls a={a} b={b} />)
    fireEvent.contextMenu(
      screen.getByRole("tab", { name: "Conversation remote:1" })
    )
    const item = screen.getByRole("menuitem", {
      name: messages.Folder.tabs.tileDisplay,
    })
    // Registry retirement precedes teardown. Fire the still-connected native
    // menu in that gap so the lifetime guard, not DOM removal, rejects it.
    const dispose = a.dispose.bind(a)
    vi.spyOn(a, "dispose").mockImplementation(() => {
      expect(item.isConnected).toBe(true)
      item.click()
      dispose()
    })
    const capturedTabs = a.stores.tabs.getState().tabs
    let replacement!: BackendRuntime
    act(() => {
      replacement = registry.upsert({
        key: "remote:1",
        name: "Replacement A",
        connection: { ...a.client.remoteConnection!, token: "replacement" },
      })
      replacement.stores.tabs.setState({
        tabs: capturedTabs,
        rawTabs: capturedTabs,
      })
    })
    const replacementTile = vi.spyOn(
      replacement.stores.tabs.getState(),
      "toggleGroupTile"
    )
    expect(tile).not.toHaveBeenCalled()
    expect(replacementTile).not.toHaveBeenCalled()
    expect(replacement.generation).not.toBe(a.generation)
  })

  it("rejects native picker completion after its local runtime retires", async () => {
    const registry = setup(true)
    const a = registry.get("local")!,
      b = registry.get("remote:2")!
    let finish!: (path: string) => void
    picker.open.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        })
    )
    render(<Controls a={a} b={b} initialFocus="local" />)
    await openFileAddMenu()
    await act(async () => {
      screen.getByRole("menuitem", { name: "Open file…" }).click()
    })
    await waitFor(() => expect(picker.open).toHaveBeenCalledOnce())
    act(() => {
      registry.remove("local")
    })
    await act(async () => {
      finish("/tmp/stale.md")
    })
    expect(
      fixtures.get("local")!.actions.openFilePreview
    ).not.toHaveBeenCalled()
    expect(
      fixtures.get("remote:2")!.actions.openFilePreview
    ).not.toHaveBeenCalled()
  })

  it("keeps a pending local picker bound to A when focus switches to remote B", async () => {
    const registry = setup(true)
    const a = registry.get("local")!,
      b = registry.get("remote:2")!
    let finish!: (path: string) => void
    picker.open.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        })
    )
    render(<Controls a={a} b={b} initialFocus="local" />)
    await openFileAddMenu()
    await act(async () => {
      screen.getByRole("menuitem", { name: "Open file…" }).click()
    })
    await waitFor(() => expect(picker.open).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole("tab", { name: "a.ts remote:2" }))
    expect(screen.getAllByRole("button", { name: "New tab" })).toHaveLength(1)
    await act(async () => {
      finish("/tmp/local-note.md")
    })
    expect(fixtures.get("local")!.actions.openFilePreview).toHaveBeenCalledWith(
      "/tmp/local-note.md"
    )
    expect(
      fixtures.get("remote:2")!.actions.openFilePreview
    ).not.toHaveBeenCalled()
  })
})
