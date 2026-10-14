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
import { AuxPanel } from "@/components/layout/aux-panel"
import { AuxPanelProvider } from "@/contexts/aux-panel-context"
import { useActiveFolder } from "@/contexts/active-folder-context"
import type { SidebarConversationCard } from "@/components/conversations/sidebar-conversation-card"
import { useBackendClient } from "@/contexts/backend-client-context"
import { WorkbenchRouteProvider } from "@/contexts/workbench-route-context"
import type { BackendRuntime } from "@/lib/backend/runtime"
import type { BackendKey } from "@/lib/backend/types"
import type { RemoteTransportConfig } from "@/lib/transport"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"
import messages from "@/i18n/messages/en.json"
import {
  loadMessageInputDraftV2,
  saveMessageInputDraftV2,
} from "@/lib/message-input-draft"

const fixtures = vi.hoisted(() => ({
  runtimes: new Map<BackendKey, BackendRuntime>(),
  db: new Map<BackendKey, DbConversationSummary[]>(),
  calls: new Map<BackendKey, ReturnType<typeof vi.fn>>(),
  search: new Map<BackendKey, ReturnType<typeof vi.fn>>(),
  children: new Map<BackendKey, DbConversationSummary[]>(),
  cards: new Map<string, Parameters<typeof SidebarConversationCard>[0]>(),
  syncTabs: false,
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
        return (
          fixtures.children.get(key) ?? [
            { ...conversation(4, 1, `${key} child`), parent_id: 1 },
          ]
        )
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
vi.mock("@/hooks/use-appearance", () => ({
  useZoomLevel: () => ({ zoomLevel: 100 }),
}))
function FolderToolContent({ tool }: { tool: string }) {
  const { activeFolder } = useActiveFolder()
  const client = useBackendClient()
  return <p>{`${tool} ${client.key} ${activeFolder?.path}`}</p>
}
vi.mock("@/components/layout/aux-panel-session-details-tab", () => ({
  SessionDetailsTab: () => <p>Session Details content</p>,
}))
vi.mock("@/components/layout/aux-panel-file-tree-tab", () => ({
  FileTreeTab: () => <FolderToolContent tool="Files" />,
}))
vi.mock("@/components/layout/aux-panel-git-changes-tab", () => ({
  GitChangesTab: () => <FolderToolContent tool="Git" />,
}))
vi.mock("@/components/layout/aux-panel-git-log-tab", () => ({
  GitLogTab: () => <FolderToolContent tool="Commits" />,
}))
vi.mock(
  "@/components/conversations/sidebar-conversation-card",
  async (original) => {
    const actual =
      await original<
        typeof import("@/components/conversations/sidebar-conversation-card")
      >()
    return {
      ...actual,
      SidebarConversationCard: (
        props: Parameters<typeof SidebarConversationCard>[0]
      ) => {
        fixtures.cards.set(
          `${useBackendClient().key}:${props.conversation.id}`,
          props
        )
        return <actual.SidebarConversationCard {...props} />
      },
    }
  }
)
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

function TabFolderSync({ runtime }: { runtime: BackendRuntime }) {
  const rawTabs = runtime.stores.tabs((s) => s.rawTabs)
  const activeTabId = runtime.stores.tabs((s) => s.activeTabId)
  // Use the production TabProvider synchronization at the same lifecycle boundary.
  useEffect(() => {
    runtime.stores.tabs.getState().syncActiveFolderId()
  }, [runtime, rawTabs, activeTabId])
  return null
}
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
      {fixtures.syncTabs && <TabFolderSync runtime={runtime} />}
      <AuxPanelProvider>
        <RuntimeBridge runtime={runtime} />
        <AuxPanel />
      </AuxPanelProvider>
      <div data-testid={`runtime-${runtime.client.key}`} />
    </WorkbenchRouteProvider>
  )
}
async function mount(syncTabs = false) {
  fixtures.syncTabs = syncTabs
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
  fixtures.children.clear()
  fixtures.cards.clear()
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
  expect(row(project, "remote:2", "remote:2 worktree")).toHaveAttribute(
    "title",
    "Machine 2 · feature · /worktree"
  )
  expect(row(project, "remote:2", "remote:2 worktree")).not.toHaveTextContent(
    "/worktree"
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
  const b = fixtures.runtimes.get("remote:2")!
  const draft = vi.spyOn(a.stores.tabs.getState(), "openNewConversationTab")
  const chatDraft = vi.spyOn(a.stores.tabs.getState(), "openChatModeTab")
  const chats = document.querySelector(
    '[data-history-section="chats"]'
  )! as HTMLElement
  const groupA = chats.querySelector(
    '[data-chat-backend-key="remote:1"]'
  )! as HTMLElement
  const groupB = chats.querySelector(
    '[data-chat-backend-key="remote:2"]'
  )! as HTMLElement
  const toggleB = within(groupB).getByRole("button", { name: "Machine 2" })
  expect(
    within(groupA).getByRole("button", { name: "Machine 1" })
  ).toHaveAttribute("aria-expanded", "true")
  expect(within(groupA).getByText("remote:1 chat")).toBeVisible()
  expect(within(groupB).getByText("remote:2 chat")).toBeVisible()
  expect(within(chats).queryByText(/^Machine [12] ·/)).toBeNull()
  fireEvent.click(toggleB)
  expect(toggleB).toHaveAttribute("aria-expanded", "false")
  expect(within(groupB).queryByText("remote:2 chat")).toBeNull()
  expect(within(groupA).getByText("remote:1 chat")).toBeVisible()
  fireEvent.click(toggleB)
  fireEvent.click(within(groupB).getByText("remote:2 chat"))
  expect(b.stores.tabs.getState().tabs[0]).toMatchObject({
    conversationId: 3,
    folderId: 3,
  })
  expect(a.stores.tabs.getState().tabs).toHaveLength(0)
  fireEvent.click(toggleB)
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.Folder.sidebar.locateActiveConversation,
    })
  )
  expect(within(groupB).getByText("remote:2 chat")).toBeVisible()
  fireEvent.click(toggleB)
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.Folder.sidebar.collapseAllGroups,
    })
  )
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.Folder.sidebar.expandAllGroups,
    })
  )
  expect(within(chats).getByText("remote:2 chat")).toBeVisible()
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

async function expandChild(project: HTMLElement, folderId: number) {
  const a = fixtures.runtimes.get("remote:1")!
  fixtures.children.set("remote:1", [
    { ...conversation(4, folderId, "remote:1 child"), parent_id: 1 },
  ])
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
  const title = await within(project).findByText("remote:1 child")
  return title.closest<HTMLElement>("[data-session-key]")!
}

it("renders and opens a delegation child's own worktree and creates a conversation there", async () => {
  const project = await mount()
  const a = fixtures.runtimes.get("remote:1")!
  const b = fixtures.runtimes.get("remote:2")!
  expect(
    fixtures.calls
      .get("remote:1")!
      .mock.calls.some(([command]) => command === "list_child_conversations")
  ).toBe(false)
  const child = await expandChild(project, 2)
  expect(child).toHaveAttribute("title", "Machine 1 · feature · /worktree")
  expect(child).not.toHaveTextContent("/worktree")
  expect(JSON.parse(child.dataset.sessionKey!)).toEqual([
    "remote:1",
    a.generation,
    2,
    "/worktree",
    "codex",
    4,
  ])
  fireEvent.click(within(child).getByText("remote:1 child"))
  expect(a.stores.workspace.getState().activeFolderId).toBe(2)
  expect(a.stores.tabs.getState().tabs[0]).toMatchObject({
    conversationId: 4,
    folderId: 2,
  })
  const draft = vi.spyOn(a.stores.tabs.getState(), "openNewConversationTab")
  fireEvent.contextMenu(within(child).getByText("remote:1 child"))
  await userEvent.click(
    screen.getByRole("menuitem", { name: "New Conversation" })
  )
  expect(draft).toHaveBeenCalledWith(2, "/worktree")
  expect(b.stores.tabs.getState().tabs).toHaveLength(0)
})

it("resolves a delegation child in another unopened root checkout from the owner's full catalog", async () => {
  const project = await mount()
  const a = fixtures.runtimes.get("remote:1")!
  act(() =>
    a.stores.workspace.setState({
      allFolders: [
        ...a.stores.workspace.getState().allFolders,
        { ...root, id: 5, path: "/other-checkout" },
      ],
    })
  )
  const child = await expandChild(project, 5)
  expect(child).toHaveAttribute("title", "Machine 1 · Root · /other-checkout")
  expect(child).not.toHaveTextContent("/other-checkout")
  fireEvent.click(within(child).getByText("remote:1 child"))
  expect(a.stores.workspace.getState().activeFolderId).toBe(5)
  expect(a.stores.tabs.getState().tabs[0]).toMatchObject({
    conversationId: 4,
    folderId: 5,
  })
  const draft = vi.spyOn(a.stores.tabs.getState(), "openNewConversationTab")
  fireEvent.contextMenu(within(child).getByText("remote:1 child"))
  await userEvent.click(
    screen.getByRole("menuitem", { name: "New Conversation" })
  )
  expect(draft).toHaveBeenCalledWith(5, "/other-checkout")
})

it.each(["refolder", "remove"])(
  "rejects captured child actions after child folder %s while the parent stays current",
  async (change) => {
    const project = await mount()
    const a = fixtures.runtimes.get("remote:1")!
    await expandChild(project, 2)
    const captured = fixtures.cards.get("remote:1:4")!
    const draft = vi.spyOn(a.stores.tabs.getState(), "openNewConversationTab")
    act(() =>
      a.stores.workspace.setState({
        allFolders: a.stores.workspace
          .getState()
          .allFolders.flatMap((f) =>
            f.id !== 2
              ? [f]
              : change === "remove"
                ? []
                : [{ ...f, path: "/replacement-worktree" }]
          ),
      })
    )
    act(() => {
      captured.onSelect(4, "codex", 2)
      captured.onDoubleClick?.(4, "codex", 2)
      captured.onNewConversation?.(2)
      captured.onTogglePin?.(4, true)
    })
    await act(async () => {
      await captured.onRename(4, "stale rename")
      await captured.onStatusChange(4, "in_progress")
      await captured.onDelete(4, "codex", 2)
    })
    expect(a.stores.tabs.getState().tabs).toHaveLength(0)
    expect(draft).not.toHaveBeenCalled()
    expect(
      fixtures.calls
        .get("remote:1")!
        .mock.calls.filter(
          ([command]) =>
            command.startsWith("update_conversation") ||
            command === "delete_conversation"
        )
    ).toHaveLength(0)
    fireEvent.click(
      within(row(project, "remote:1", "remote:1 root")).getByText(
        "remote:1 root"
      )
    )
    expect(a.stores.workspace.getState().activeFolderId).toBe(1)
    expect(a.stores.tabs.getState().tabs[0]).toMatchObject({
      conversationId: 1,
      folderId: 1,
    })
  }
)

it("never uses the parent destination for an unresolved delegation child folder", async () => {
  const project = await mount()
  const a = fixtures.runtimes.get("remote:1")!
  const child = await expandChild(project, 99)
  expect(child).not.toHaveTextContent("/repo")
  const captured = fixtures.cards.get("remote:1:4")!
  const draft = vi.spyOn(a.stores.tabs.getState(), "openNewConversationTab")
  const chat = vi.spyOn(a.stores.tabs.getState(), "openChatModeTab")
  act(() => {
    captured.onSelect(4, "codex", 99)
    captured.onNewConversation?.(99)
    captured.onTogglePin?.(4, true)
  })
  expect(a.stores.tabs.getState().tabs).toHaveLength(0)
  expect(draft).not.toHaveBeenCalled()
  expect(chat).not.toHaveBeenCalled()
  expect(
    fixtures.calls
      .get("remote:1")!
      .mock.calls.some(([command]) => command === "update_conversation_pinned")
  ).toBe(false)
})

it.each([messages.MultiHost.files, messages.MultiHost.git])(
  "shows explicit %s worktree content beside a retained unsent folderless draft and restores ordinary chat tabs",
  async (label) => {
    const project = await mount(true)
    const a = fixtures.runtimes.get("remote:1")!
    await act(async () => {
      a.stores.tabs.getState().openChatModeTab()
    })
    const draft = a.stores.tabs.getState().tabs[0]
    const draftKey =
      a.stores.storage.drafts.buildNewConversationDraftStorageKey(draft.id)
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Unsent folderless request" }],
        },
      ],
    }
    saveMessageInputDraftV2(draftKey, doc)
    const newDraft = vi.spyOn(
      a.stores.tabs.getState(),
      "openNewConversationTab"
    )
    const newChat = vi.spyOn(a.stores.tabs.getState(), "openChatModeTab")
    const select = within(project).getByRole("combobox", {
      name: "Execution location",
    })
    const option = [...select.querySelectorAll("option")].find(
      (o) => o.value.includes("remote:1") && o.value.includes("/worktree")
    )!
    fireEvent.change(select, { target: { value: option.value } })
    await userEvent.click(
      within(project).getByRole("button", {
        name: messages.MultiHost.locationActions,
      })
    )
    await userEvent.click(screen.getByRole("menuitem", { name: label }))
    const runtimeNode = screen.getByTestId("runtime-remote:1").parentElement!
    const panel = () =>
      runtimeNode.querySelector(
        '[data-slot="tabs-content"][data-state="active"]'
      )!
    expect(panel()).toHaveTextContent(
      label === messages.MultiHost.files
        ? "Files remote:1 /worktree"
        : "Git remote:1 /worktree"
    )
    expect(a.stores.tabs.getState().tabs).toEqual([draft])
    expect(a.stores.tabs.getState().activeTabId).toBe(draft.id)
    expect(a.stores.tabs.getState().draftRetargetRequests).toHaveLength(0)
    expect(loadMessageInputDraftV2(draftKey)).toEqual({ kind: "doc", doc })
    expect(newDraft).not.toHaveBeenCalled()
    expect(newChat).not.toHaveBeenCalled()
    // Open an ordinary existing chat, then return to the unsent chat composer.
    fireEvent.click(screen.getAllByText("remote:1 chat")[0])
    expect(
      a.stores.tabs
        .getState()
        .tabs.find((tab) => tab.id === a.stores.tabs.getState().activeTabId)
    ).toMatchObject({ conversationId: 3 })
    expect(panel()).toHaveTextContent("Session Details content")
    expect(
      runtimeNode.querySelectorAll('[data-slot="tabs-trigger"]')
    ).toHaveLength(1)
    act(() => a.stores.tabs.getState().switchTab(draft.id))
    expect(panel()).toHaveTextContent("Session Details content")
    expect(
      a.stores.tabs.getState().tabs.find((t) => t.id === draft.id)
    ).toEqual(draft)
    expect(loadMessageInputDraftV2(draftKey)).toEqual({ kind: "doc", doc })
  }
)

it.each(["refolder", "remove"])(
  "expires explicit folder tools on composer reselection and folder %s without reviving the destination",
  async (change) => {
    const project = await mount(true)
    const a = fixtures.runtimes.get("remote:1")!
    await act(async () => {
      a.stores.tabs.getState().openChatModeTab()
    })
    const draft = a.stores.tabs.getState().tabs[0]
    const select = within(project).getByRole("combobox", {
      name: "Execution location",
    })
    const option = [...select.querySelectorAll("option")].find(
      (o) => o.value.includes("remote:1") && o.value.includes("/worktree")
    )!
    fireEvent.change(select, { target: { value: option.value } })
    const openFiles = async () => {
      await userEvent.click(
        within(project).getByRole("button", {
          name: messages.MultiHost.locationActions,
        })
      )
      await userEvent.click(
        screen.getByRole("menuitem", { name: messages.MultiHost.files })
      )
    }
    const runtimeNode = screen.getByTestId("runtime-remote:1").parentElement!
    const panel = () =>
      runtimeNode.querySelector(
        '[data-slot="tabs-content"][data-state="active"]'
      )!
    await openFiles()
    expect(panel()).toHaveTextContent("Files remote:1 /worktree")
    fireEvent.click(screen.getByTitle(`Machine 1 · ${draft.title}`))
    expect(panel()).toHaveTextContent("Session Details content")
    expect(a.stores.tabs.getState().activeTabId).toBe(draft.id)
    await openFiles()
    expect(panel()).toHaveTextContent("Files remote:1 /worktree")
    const folders = a.stores.workspace.getState().allFolders
    act(() =>
      a.stores.workspace.setState({
        allFolders: folders.flatMap((f) =>
          f.id !== 2
            ? [f]
            : change === "remove"
              ? []
              : [{ ...f, path: "/replacement-worktree" }]
        ),
      })
    )
    expect(panel()).toHaveTextContent("Session Details content")
    act(() => a.stores.workspace.setState({ allFolders: folders }))
    expect(panel()).toHaveTextContent("Session Details content")
    expect(a.stores.tabs.getState().tabs).toEqual([draft])
  }
)

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
    expect(
      screen
        .getByTestId("runtime-remote:1")
        .parentElement!.querySelector(
          `[data-slot="tabs-content"][data-state="active"]`
        )
    ).toHaveTextContent(
      tab === "file_tree"
        ? "Files remote:1 /worktree"
        : "Git remote:1 /worktree"
    )
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
