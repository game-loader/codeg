import { useEffect } from "react"
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, expect, it, vi } from "vitest"
import { MultiHostWorkspace } from "./multi-host-workspace"
import { RuntimeBridge } from "./backend-runtime"
import { useBackendClient } from "@/contexts/backend-client-context"
import { WorkbenchRouteProvider } from "@/contexts/workbench-route-context"
import type { BackendRuntime } from "@/lib/backend/runtime"
import type { BackendKey } from "@/lib/backend/types"
import type { RemoteTransportConfig } from "@/lib/transport"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"
import messages from "@/i18n/messages/en.json"

const fixtures = vi.hoisted(() => ({
  runtimes: new Map<BackendKey, BackendRuntime>(),
  db: new Map<BackendKey, DbConversationSummary[]>(),
  calls: new Map<BackendKey, ReturnType<typeof vi.fn>>(),
  search: new Map<BackendKey, ReturnType<typeof vi.fn>>(),
  aux: vi.fn(),
  terminal: vi.fn(),
  createTerminal: vi.fn(),
  activate: vi.fn(),
  workspaceActions: { activateConversationPane: vi.fn() },
}))
const identity = {
  project_key: "github:owner/repo",
  provider: "github",
  host: "github.com",
  repository_path: "owner/repo",
  remote_name: "origin",
}
const root: FolderDetail = {
  id: 1,
  name: "repo",
  path: "/repo",
  kind: "regular",
  parent_id: null,
  git_branch: "main",
  default_agent_type: "codex",
  color: "",
  sort_order: 0,
  last_opened_at: "",
  alias: null,
  group_id: null,
}
const tree = {
  ...root,
  id: 2,
  parent_id: 1,
  path: "/worktree",
  git_branch: "feature",
}
function conversation(
  id: number,
  folderId: number,
  title: string
): DbConversationSummary {
  return {
    id,
    folder_id: folderId,
    title,
    title_locked: false,
    agent_type: "codex",
    status: "completed",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 2,
    child_count: 0,
    created_at: `2026-10-01T00:00:0${id}Z`,
    updated_at: `2026-10-02T00:00:0${id}Z`,
    pinned_at: null,
  }
}
function histories(key: BackendKey) {
  return [
    conversation(1, 1, `${key} root`),
    conversation(2, 2, `${key} worktree`),
    { ...conversation(3, 3, `${key} chat`), kind: "chat" as const },
  ]
}
function transport(key: BackendKey) {
  const call = vi.fn(
    async (
      command: string,
      params?: { conversationId?: number; title?: string; pinned?: boolean }
    ) => {
      if (command === "update_conversation_title")
        fixtures.db.set(
          key,
          fixtures.db
            .get(key)!
            .map((c) =>
              c.id === params?.conversationId
                ? { ...c, title: params.title! }
                : c
            )
        )
      if (command === "delete_conversation")
        fixtures.db.set(
          key,
          fixtures.db.get(key)!.filter((c) => c.id !== params?.conversationId)
        )
      if (command === "update_conversation_pinned")
        fixtures.db.set(
          key,
          fixtures.db.get(key)!.map((c) =>
            c.id === params?.conversationId
              ? {
                  ...c,
                  pinned_at: params.pinned ? "2026-10-13T00:00:00Z" : null,
                }
              : c
          )
        )
      if (command === "list_repository_project_identities")
        return [{ folder_id: 1, path: "/repo", status: "resolved", identity }]
      if (command === "list_all_conversations")
        return fixtures.db.get(key) ?? histories(key)
      if (command === "list_child_conversations")
        return [{ ...conversation(4, 1, `${key} child`), parent_id: 1 }]
      if (command === "academic_library") return { items: [], collections: [] }
      if (command === "get_folder_conversation")
        return { conversation: { id: 1, title: "existing", turns: [] } }
      if (command === "get_or_create_chat_folder")
        return { folder: { ...root, id: 3, kind: "chat" }, path: "/chat" }
      if (command === "create_chat_dir") return { path: "/chat" }
      return undefined
    }
  )
  fixtures.calls.set(key, call)
  return {
    call,
    subscribe: vi.fn().mockResolvedValue(() => {}),
    isDesktop: () => true,
    destroy: vi.fn(),
  }
}
vi.mock("next-intl", async (original) => ({
  ...(await original<typeof import("next-intl")>()),
  useTranslations: (namespace: string) => (key: string) => {
    let value: unknown = messages
    for (const part of `${namespace}.${key}`.split("."))
      value = (value as Record<string, unknown>)?.[part]
    return typeof value === "string" ? value : key
  },
}))
vi.mock("@/lib/transport", async (original) => ({
  ...(await original<typeof import("@/lib/transport")>()),
  getShellTransport: () => transport("local"),
}))
vi.mock("@/lib/transport/remote-desktop-transport", () => ({
  RemoteDesktopTransport: class {
    constructor(config: RemoteTransportConfig) {
      return transport(`remote:${config.id}`)
    }
  },
}))
vi.mock("@/lib/remote-workspace", () => ({
  listRemoteWorkspaceConnections: async () =>
    [1, 2].map((id) => ({
      id,
      name: `Machine ${id}`,
      base_url: `http://machine-${id}`,
      token: "",
      headers: [],
      sort_order: id,
      created_at: "",
      updated_at: "",
    })),
}))
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => fixtures.workspaceActions,
  useWorkspaceFileTabs: () => ({ fileTabs: [], activeFileTabId: null }),
  useWorkspaceView: () => ({ activePane: "conversation" }),
}))
vi.mock("@/contexts/sidebar-context", () => ({
  useSidebarContext: () => ({ isOpen: true, toggle: fixtures.activate }),
}))
vi.mock("@/contexts/aux-panel-context", () => ({
  useAuxPanelContext: () => ({
    isOpen: false,
    toggle: fixtures.activate,
    openTab: fixtures.aux,
  }),
}))
vi.mock("@/contexts/terminal-context", () => ({
  useTerminalContext: () => ({
    isOpen: false,
    toggle: fixtures.terminal,
    createTerminalInDirectory: fixtures.createTerminal,
  }),
}))
vi.mock("@/contexts/search-dialog-context", () => ({
  useSearchDialog: () => ({
    setOpen: fixtures.search.get(useBackendClient().key)!,
  }),
}))
vi.mock("@/components/layout/window-controls", () => ({
  WindowControls: () => null,
}))
vi.mock("@/components/ui/app-toaster", () => ({ AppToaster: () => null }))
vi.mock("@/components/layout/remote-workspace-manage-dialog", () => ({
  RemoteWorkspaceManageDialog: () => null,
}))
vi.mock("@/components/layout/workspace-folder-dialog", () => ({
  WorkspaceFolderDialog: () => null,
}))
vi.mock("./host-worktree-dialog", () => ({ HostWorktreeDialog: () => null }))
vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpActions: () => ({ disconnectIfIdle: vi.fn() }),
}))

function Probe({ runtime }: { runtime: BackendRuntime }) {
  useEffect(() => {
    fixtures.runtimes.set(runtime.client.key, runtime)
    fixtures.db.set(
      runtime.client.key,
      runtime.client.key === "local" ? [] : histories(runtime.client.key)
    )
    fixtures.search.set(runtime.client.key, vi.fn())
    runtime.stores.tabs.setState({
      tabs: [],
      activeTabId: "",
      tabsHydrated: true,
    })
    runtime.stores.workspace.setState({
      folders: runtime.client.key === "local" ? [] : [root],
      allFolders:
        runtime.client.key === "local"
          ? []
          : [root, tree, { ...root, id: 3, kind: "chat" }],
      conversations: fixtures.db.get(runtime.client.key),
      foldersLoading: false,
      conversationsLoading: false,
    })
  }, [runtime])
  return (
    <WorkbenchRouteProvider>
      <RuntimeBridge runtime={runtime} />
      <div data-testid={`runtime-${runtime.client.key}`} />
    </WorkbenchRouteProvider>
  )
}
async function mount() {
  render(
    <MultiHostWorkspace
      renderWorkspace={(runtime) => <Probe runtime={runtime} />}
    />
  )
  await waitFor(() =>
    expect(
      document.querySelectorAll(
        'section[data-project-key="github:owner/repo"] [data-session-key]'
      )
    ).toHaveLength(4)
  )
  return document.querySelector(
    'section[data-project-key="github:owner/repo"]'
  )! as HTMLElement
}
function row(project: HTMLElement, key: BackendKey, title: string) {
  return [...project.querySelectorAll<HTMLElement>("[data-session-key]")].find(
    (row) => row.dataset.sessionOwner === key && within(row).queryByText(title)
  )!
}
beforeEach(() => {
  localStorage.clear()
  fixtures.runtimes.clear()
  fixtures.db.clear()
  fixtures.calls.clear()
  fixtures.search.clear()
  vi.clearAllMocks()
})

it("shows colliding root/worktree IDs directly in one project, opens their fixed owner, and requires a target for New Session", async () => {
  const project = await mount()
  expect(document.querySelectorAll("section[data-project-key]")).toHaveLength(1)
  expect(within(project).queryByRole("button", { name: /History/ })).toBeNull()
  const a = fixtures.runtimes.get("remote:1")!,
    b = fixtures.runtimes.get("remote:2")!
  const draftA = vi.spyOn(a.stores.tabs.getState(), "openNewConversationTab")
  const draftB = vi.spyOn(b.stores.tabs.getState(), "openNewConversationTab")
  expect(
    within(project).getByRole("button", { name: "New Session" })
  ).toBeDisabled()
  fireEvent.click(
    within(row(project, "remote:2", "remote:2 worktree")).getByText(
      "remote:2 worktree"
    )
  )
  expect(b.stores.tabs.getState().tabs[0]).toMatchObject({
    conversationId: 2,
    folderId: 2,
  })
  expect(a.stores.tabs.getState().tabs).toHaveLength(0)
  expect(draftA).not.toHaveBeenCalled()
  expect(draftB).not.toHaveBeenCalled()
  expect(row(project, "remote:2", "remote:2 worktree")).toHaveTextContent(
    "Machine 2 · feature · /worktree"
  )
  const select = within(project).getByRole("combobox", {
    name: "Execution location",
  })
  const option = [...select.querySelectorAll("option")].find(
    (option) =>
      option.value.includes("remote:1") && option.value.includes("/repo")
  )!
  fireEvent.change(select, { target: { value: option.value } })
  fireEvent.click(within(project).getByRole("button", { name: "New Session" }))
  expect(draftA).toHaveBeenCalledWith(1, "/repo")
  expect(draftB).not.toHaveBeenCalled()
  const draft = a.stores.tabs
    .getState()
    .tabs.find((tab) => tab.conversationId === null)!
  const node = screen.getByTestId("runtime-remote:1")
  fireEvent.click(
    screen.getByRole("button", { name: "Machines", pressed: false })
  )
  fireEvent.click(
    screen.getByRole("button", { name: "Projects", pressed: false })
  )
  expect(screen.getByTestId("runtime-remote:1")).toBe(node)
  expect(
    a.stores.tabs.getState().tabs.find((tab) => tab.id === draft.id)
  ).toEqual(draft)
})

it("keeps existing folderless chats and focused New Chat/search/navigation reachable", async () => {
  const project = await mount()
  const a = fixtures.runtimes.get("remote:1")!
  const draft = vi.spyOn(a.stores.tabs.getState(), "openNewConversationTab")
  const chatDraft = vi.spyOn(a.stores.tabs.getState(), "openChatModeTab")
  const chats = document.querySelector(
    '[data-history-section="chats"]'
  )! as HTMLElement
  fireEvent.click(within(chats).getByText("remote:1 chat"))
  expect(a.stores.tabs.getState().tabs[0]).toMatchObject({
    conversationId: 3,
    folderId: 3,
  })
  expect(chatDraft).not.toHaveBeenCalled()
  expect(draft).not.toHaveBeenCalled()
  const aside = document.querySelector("aside")!
  const navigation = aside.querySelector("nav")!
  fireEvent.click(within(aside).getByRole("button", { name: "New chat" }))
  expect(chatDraft).toHaveBeenCalledOnce()
  act(() => a.stores.workspace.getState().setActiveFolderId(1))
  fireEvent.click(within(aside).getByRole("button", { name: "New chat" }))
  expect(draft).toHaveBeenCalledWith(1, "/repo")
  expect(within(navigation).getByTitle("Machine 1 · /repo")).toBeVisible()
  fireEvent.click(
    within(aside).getByRole("button", {
      name: messages.Folder.folderTitleBar.search,
    })
  )
  expect(fixtures.search.get("remote:1")).toHaveBeenCalledWith(true)
  for (const name of [
    messages.Folder.sidebar.automations,
    messages.Folder.sidebar.tasks,
    messages.Folder.sidebar.forge,
    messages.Folder.sidebar.canvas,
    messages.Academic.title,
    messages.Folder.sidebar.machines,
  ])
    expect(within(navigation).getByRole("button", { name })).toBeVisible()
  fireEvent.click(
    within(aside).getByRole("button", { name: messages.Folder.sidebar.canvas })
  )
  const close = vi.spyOn(a.stores.canvasBoards.getState(), "closeBoard")
  fireEvent.click(
    within(aside).getByRole("button", { name: messages.Folder.sidebar.canvas })
  )
  expect(close).toHaveBeenCalledOnce()
  expect(within(project).getByText("remote:1 root")).toBeInTheDocument()
})

it("pins, renames and deletes A's colliding ID while B is focused, using the original card menus", async () => {
  const project = await mount()
  const a = fixtures.runtimes.get("remote:1")!,
    b = fixtures.runtimes.get("remote:2")!
  fireEvent.click(
    within(row(project, "remote:2", "remote:2 root")).getByText("remote:2 root")
  )
  const target = row(project, "remote:1", "remote:1 root")
  fireEvent.click(within(target).getByRole("button", { name: "Pin" }))
  await waitFor(() =>
    expect(fixtures.calls.get("remote:1")).toHaveBeenCalledWith(
      "update_conversation_pinned",
      { conversationId: 1, pinned: true },
      undefined
    )
  )
  expect(b.stores.workspace.getState().conversations[0].pinned_at).toBeNull()
  fireEvent.contextMenu(within(target).getByText("remote:1 root"))
  await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }))
  await userEvent.clear(screen.getByRole("textbox"))
  await userEvent.type(screen.getByRole("textbox"), "Renamed on A")
  await userEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() =>
    expect(fixtures.calls.get("remote:1")).toHaveBeenCalledWith(
      "update_conversation_title",
      { conversationId: 1, title: "Renamed on A" },
      undefined
    )
  )
  const renamed = await within(project).findByText("Renamed on A")
  fireEvent.contextMenu(renamed)
  await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }))
  const dialog = screen.getByRole("alertdialog")
  await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }))
  await waitFor(() =>
    expect(fixtures.calls.get("remote:1")).toHaveBeenCalledWith(
      "delete_conversation",
      { conversationId: 1 },
      undefined
    )
  )
  expect(
    fixtures.calls
      .get("remote:2")!
      .mock.calls.filter(
        ([command]) =>
          command.startsWith("update_conversation") ||
          command === "delete_conversation"
      )
  ).toHaveLength(0)
  expect(a.stores.tabs.getState().tabs).toHaveLength(0)
  await waitFor(() =>
    expect(within(project).queryByText("Renamed on A")).toBeNull()
  )
})

it("loads and opens delegation children only on their original owner", async () => {
  const project = await mount()
  const a = fixtures.runtimes.get("remote:1")!,
    b = fixtures.runtimes.get("remote:2")!
  act(() =>
    a.stores.workspace.setState({
      conversations: a.stores.workspace
        .getState()
        .conversations.map((c) => (c.id === 1 ? { ...c, child_count: 1 } : c)),
    })
  )
  fireEvent.click(
    within(row(project, "remote:1", "remote:1 root")).getByRole("button", {
      name: messages.Folder.conversationCard.expandSubsessions,
    })
  )
  const child = await within(project).findByText("remote:1 child")
  fireEvent.click(child)
  expect(a.stores.tabs.getState().tabs[0]).toMatchObject({ conversationId: 4 })
  expect(b.stores.tabs.getState().tabs).toHaveLength(0)
})

it("runs file, Git and terminal actions at the explicitly selected machine and worktree", async () => {
  const project = await mount()
  const select = within(project).getByRole("combobox", {
    name: messages.MultiHost.executionLocation,
  })
  const option = [...select.querySelectorAll("option")].find(
    (option) =>
      option.value.includes("remote:1") && option.value.includes("/worktree")
  )!
  fireEvent.change(select, { target: { value: option.value } })
  fireEvent.click(
    within(row(project, "remote:2", "remote:2 root")).getByText("remote:2 root")
  )
  for (const [label, tab] of [
    [messages.MultiHost.files, "file_tree"],
    [messages.MultiHost.git, "changes"],
  ]) {
    await userEvent.click(
      within(project).getByRole("button", {
        name: messages.MultiHost.locationActions,
      })
    )
    await userEvent.click(screen.getByRole("menuitem", { name: label }))
    expect(fixtures.aux).toHaveBeenLastCalledWith(tab)
    expect(
      fixtures.runtimes.get("remote:1")!.stores.workspace.getState()
        .activeFolderId
    ).toBe(2)
  }
  await userEvent.click(
    within(project).getByRole("button", {
      name: messages.MultiHost.locationActions,
    })
  )
  await userEvent.click(
    screen.getByRole("menuitem", { name: messages.MultiHost.terminal })
  )
  expect(fixtures.createTerminal).toHaveBeenCalledWith(
    "/worktree",
    "repo",
    undefined,
    2
  )
  expect(
    fixtures.runtimes.get("remote:2")!.stores.workspace.getState()
      .activeFolderId
  ).toBe(1)
})

it("keeps pinned completed history visible while filtering completed sessions, and locates a session through collapsed groups", async () => {
  const project = await mount()
  const a = fixtures.runtimes.get("remote:1")!
  fireEvent.click(
    within(row(project, "remote:1", "remote:1 root")).getByRole("button", {
      name: "Pin",
    })
  )
  expect(project.querySelector("[data-session-key]")).toHaveTextContent(
    "remote:1 root"
  )
  await userEvent.click(
    screen.getByRole("button", { name: messages.Folder.sidebar.viewOptions })
  )
  await userEvent.click(
    screen.getByRole("menuitemcheckbox", {
      name: messages.Folder.sidebar.showCompleted,
    })
  )
  await userEvent.keyboard("{Escape}")
  expect(within(project).getByText("remote:1 root")).toBeVisible()
  expect(within(project).queryByText("remote:2 root")).toBeNull()
  fireEvent.click(
    within(row(project, "remote:1", "remote:1 root")).getByText("remote:1 root")
  )
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.Folder.sidebar.collapseAllGroups,
    })
  )
  expect(within(project).queryByText("remote:1 root")).toBeNull()
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.Folder.sidebar.locateActiveConversation,
    })
  )
  expect(within(project).getByText("remote:1 root")).toBeVisible()
  expect(a.stores.tabs.getState().tabs[0]).toMatchObject({ conversationId: 1 })
})
