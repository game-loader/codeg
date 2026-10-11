import { act, render, screen } from "@testing-library/react"
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

interface Fixture {
  files: FileWorkspaceTab[]
  activeFileTabId: string
  activePane: WorkspacePane
  actions: {
    switchFileTab: ReturnType<typeof vi.fn>
    closeFileTab: ReturnType<typeof vi.fn>
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
  useAuxPanelContext: () => ({ isOpen: false, toggle: useFixture().toggle }),
}))
vi.mock("@/contexts/terminal-context", () => ({
  useTerminalContext: () => ({ isOpen: false, toggle: useFixture().toggle }),
}))
vi.mock("@/contexts/search-dialog-context", () => ({
  useSearchDialog: () => ({ setOpen: useFixture().setSearchOpen }),
}))

const registries: BackendRegistry<BackendRuntime>[] = []
function setup() {
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
    const key = `remote:${id}` as const
    const runtime = registry.upsert({
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
    })
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
function view(runtime: BackendRuntime, visible = true) {
  return (
    <BackendRuntimeView
      runtime={runtime}
      visible={visible}
      focused={visible}
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
