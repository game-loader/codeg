import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  MultiHostSidebar,
  type HostFolderCatalog,
  type MultiHostSidebarProps,
} from "./multi-host-sidebar"
import { MultiHostTabs } from "./multi-host-tabs"
import type { BackendDescriptor } from "@/lib/backend/registry"
import type {
  ConversationTagDetail,
  DbConversationSummary,
  FolderDetail,
} from "@/lib/types"
import type { BackendKey } from "@/lib/backend/types"

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

const hosts: BackendDescriptor[] = [
  {
    key: "remote:1",
    name: "Machine A",
    baseUrl: "http://a",
    generation: 1,
    status: "connected",
    error: null,
  },
  {
    key: "remote:2",
    name: "Machine B",
    baseUrl: "http://b",
    generation: 2,
    status: "connected",
    error: null,
  },
]
const folder: FolderDetail = {
  id: 1,
  name: "same-repo",
  path: "/repo",
  git_branch: "main",
  default_agent_type: "codex",
  last_opened_at: "",
  sort_order: 0,
  color: "",
  parent_id: null,
  kind: "regular",
  alias: null,
  group_id: null,
}

beforeEach(() => localStorage.clear())

const tag = (id: number, name = `tag${id}`): ConversationTagDetail => ({
  id,
  name,
  folder_id: null,
  color: "#0969da",
  sort_order: id,
})
function tagCatalogs(): Map<BackendKey, HostFolderCatalog> {
  return new Map(
    hosts.map((host, index) => {
      const machine = index === 0 ? "A" : "B"
      const conversation = (
        id: number,
        title: string,
        tag_ids: number[],
        extra = {}
      ): DbConversationSummary => ({
        id,
        title: `${machine} ${title}`,
        tag_ids,
        folder_id: 1,
        title_locked: false,
        kind: "regular",
        agent_type: "codex",
        status: "completed",
        model: null,
        git_branch: null,
        external_id: null,
        message_count: 0,
        child_count: 0,
        created_at: "2026",
        updated_at: "2026",
        pinned_at: null,
        ...extra,
      })
      return [
        host.key,
        {
          generation: host.generation,
          folders: [
            folder,
            {
              ...folder,
              id: 2,
              path: "/wt",
              parent_id: 1,
              git_branch: "feature",
            },
          ],
          loading: false,
          tagsHydrated: true,
          tags: [tag(1), tag(2)],
          identities: new Map([
            [
              1,
              {
                folder_id: 1,
                path: folder.path,
                status: "resolved",
                identity: {
                  project_key: "github:owner/repo",
                  repository_path: "owner/repo",
                  provider: "github",
                  host: "github.com",
                  remote_name: "origin",
                },
              },
            ],
          ]),
          conversations: [
            conversation(1, "root both", [1, 2], { pinned_at: "2027" }),
            conversation(2, "root first", [1]),
            conversation(3, "worktree second", [2], { folder_id: 2 }),
            conversation(4, "chat first", [1], { kind: "chat", folder_id: 9 }),
            conversation(5, "untagged", []),
          ],
        },
      ]
    })
  )
}
function tagProps(catalogs = tagCatalogs()): MultiHostSidebarProps {
  return {
    hosts,
    catalogs,
    focusedHost: "remote:1",
    collapsed: [],
    onToggleHost: vi.fn(),
    onSelectHost: vi.fn(),
    onOpenFolder: vi.fn(),
    onWorktrees: vi.fn(),
    onAddRepository: vi.fn(),
    onOpenConversation: vi.fn(),
    onRefresh: vi.fn(),
    onManageConnections: vi.fn(),
  }
}
async function openTagFilter() {
  const user = userEvent.setup({ pointerEventsCheck: 0 })
  await user.click(screen.getByRole("button", { name: "filter.button" }))
  return { user, panel: screen.getByRole("dialog") }
}

describe("outer sidebar tag filtering", () => {
  it("keeps equal tag IDs owner-qualified across project, machine, chat and recent histories", async () => {
    const props = tagProps()
    render(<MultiHostSidebar {...props} />)
    const { user, panel } = await openTagFilter()
    const machine = within(panel).getByRole("combobox", { name: "machines" })
    expect(machine).toHaveDisplayValue("Machine A")
    expect(
      within(panel).getByRole("button", { name: "filter.clear" })
    ).toBeDisabled()
    await user.click(within(panel).getByRole("option", { name: "tag1 3" }))
    expect(screen.queryByText("B root both")).toBeNull()
    expect(screen.queryByText("A untagged")).toBeNull()
    expect(screen.queryByText("A worktree second")).toBeNull()
    expect(screen.getByRole("status", { name: "active" })).toHaveTextContent(
      "Machine A"
    )
    const chats = document.querySelector('[data-history-section="chats"]')!
    expect(
      chats.querySelector('[data-chat-backend-key="remote:1"]')
    ).toHaveTextContent("A chat first")
    expect(chats.querySelector('[data-chat-backend-key="remote:2"]')).toBeNull()
    expect(
      chats.querySelector('[data-chat-backend-key="remote:1"]')
    ).toHaveAttribute("data-runtime-generation", "1")
    const recent = document.querySelector('[data-history-section="recent"]')!
    expect(recent).toHaveTextContent("A root both")
    expect(recent).not.toHaveTextContent("B root both")
    await user.click(within(panel).getByRole("option", { name: "tag2 2" }))
    expect(screen.getAllByText("A worktree second").length).toBeGreaterThan(0)
    await user.click(
      within(panel).getByRole("radio", { name: "filter.matchAll" })
    )
    expect(screen.queryByText("A root first")).toBeNull()
    expect(screen.queryByText("A worktree second")).toBeNull()
    expect(screen.queryByText("A chat first")).toBeNull()
    await user.click(screen.getByRole("button", { name: "filter.button" }))
    fireEvent.click(screen.getByRole("button", { name: "machines" }))
    fireEvent.click(
      screen.getAllByRole("button", { name: "history · same-repo" })[0]
    )
    const aHistory = screen.getByTestId("history-remote:1-1")
    expect(aHistory).toHaveTextContent("A root both")
    expect(aHistory).not.toHaveTextContent("A root first")
    fireEvent.click(
      within(aHistory).getByRole("button", { name: /A root both/ })
    )
    expect(props.onOpenConversation).toHaveBeenCalledWith(
      "remote:1",
      folder,
      expect.objectContaining({ id: 1 }),
      1
    )
    fireEvent.click(
      screen.getAllByRole("button", { name: "history · same-repo" })[1]
    )
    expect(screen.getByTestId("history-remote:2-1")).not.toHaveTextContent(
      "B root both"
    )
    fireEvent.click(screen.getByRole("button", { name: "clear" }))
    expect(screen.getByTestId("history-remote:2-1")).toHaveTextContent(
      "B root both"
    )
    expect(screen.getAllByText("A chat first").length).toBeGreaterThan(0)
    expect(screen.getAllByText("B chat first").length).toBeGreaterThan(0)
  })

  it("retains an explicit machine across focus changes and clears IDs when choosing another machine", async () => {
    const props = tagProps()
    const view = render(<MultiHostSidebar {...props} />)
    const { user, panel } = await openTagFilter()
    await user.click(within(panel).getByRole("option", { name: "tag1 3" }))
    view.rerender(<MultiHostSidebar {...props} focusedHost="remote:2" />)
    expect(
      within(panel).getByRole("combobox", { name: "machines" })
    ).toHaveDisplayValue("Machine A")
    expect(screen.queryByText("B root both")).toBeNull()
    fireEvent.change(
      within(panel).getByRole("combobox", { name: "machines" }),
      {
        target: { value: JSON.stringify(["remote:2", 2]) },
      }
    )
    expect(screen.getAllByText("B root both").length).toBeGreaterThan(0)
    expect(
      screen.getByRole("button", { name: "filter.button" })
    ).toHaveAttribute("aria-pressed", "false")
    await user.click(within(panel).getByRole("option", { name: "tag1 3" }))
    expect(screen.queryByText("A root both")).toBeNull()
    expect(screen.getByRole("status", { name: "active" })).toHaveTextContent(
      "Machine B"
    )
    await user.click(screen.getByRole("button", { name: "filter.button" }))
    fireEvent.click(
      screen.getByRole("button", { name: "locateActiveConversation" })
    )
    expect(screen.queryByRole("status", { name: "active" })).toBeNull()
    expect(screen.getAllByText("A root both").length).toBeGreaterThan(0)
  })

  it("disables unhydrated options, prunes deleted definitions and retires replaced generations", async () => {
    const catalogs = tagCatalogs()
    const a = catalogs.get("remote:1")!
    catalogs.set("remote:1", { ...a, tagsHydrated: false })
    const props = tagProps(catalogs)
    const view = render(<MultiHostSidebar {...props} />)
    const { user, panel } = await openTagFilter()
    expect(
      within(panel).getByRole("radio", { name: "filter.matchAll" })
    ).toBeDisabled()
    expect(
      within(panel).getByRole("option", { name: "tag1 3" })
    ).toHaveAttribute("aria-disabled", "true")
    const hydrated = new Map(catalogs).set("remote:1", a)
    view.rerender(<MultiHostSidebar {...props} catalogs={hydrated} />)
    await user.click(within(panel).getByRole("option", { name: "tag1 3" }))
    await user.click(within(panel).getByRole("option", { name: "tag2 2" }))
    await user.click(
      within(panel).getByRole("radio", { name: "filter.matchAll" })
    )
    const deleted = new Map(hydrated).set("remote:1", { ...a, tags: [tag(2)] })
    view.rerender(<MultiHostSidebar {...props} catalogs={deleted} />)
    expect(screen.getAllByText("A worktree second").length).toBeGreaterThan(0)
    expect(screen.queryByText("A root first")).toBeNull()
    expect(within(panel).queryByText("tag1")).toBeNull()
    const replaced = new Map(hydrated).set("remote:1", { ...a, generation: 3 })
    view.rerender(
      <MultiHostSidebar
        {...props}
        catalogs={replaced}
        hosts={[{ ...hosts[0], generation: 3 }, hosts[1]]}
      />
    )
    expect(screen.queryByRole("status", { name: "active" })).toBeNull()
    expect(screen.getAllByText("B root both").length).toBeGreaterThan(0)
    expect(screen.getAllByText("A root first").length).toBeGreaterThan(0)
  })

  it("clears after the last definition is deleted without another host's same ID keeping it alive", async () => {
    const props = tagProps()
    const view = render(<MultiHostSidebar {...props} />)
    const { user, panel } = await openTagFilter()
    await user.click(within(panel).getByRole("option", { name: "tag1 3" }))
    const deleted = new Map(props.catalogs).set("remote:1", {
      ...props.catalogs.get("remote:1")!,
      tags: [],
    })
    view.rerender(<MultiHostSidebar {...props} catalogs={deleted} />)
    expect(screen.queryByRole("status", { name: "active" })).toBeNull()
    expect(screen.getAllByText("B root both").length).toBeGreaterThan(0)
    expect(
      within(panel).getByRole("button", { name: "filter.clear" })
    ).toBeDisabled()
    expect(within(panel).getByText("filter.noTags")).toBeInTheDocument()
    view.rerender(<MultiHostSidebar {...props} />)
    expect(
      screen.getByRole("button", { name: "filter.button" })
    ).toHaveAttribute("aria-pressed", "false")
    view.unmount()
    render(<MultiHostSidebar {...props} />)
    expect(
      screen.getByRole("button", { name: "filter.button" })
    ).toHaveAttribute("aria-pressed", "false")
  })

  it("keeps stale machine catalogs out of a replacement generation's filter and histories", async () => {
    const props = tagProps()
    render(
      <MultiHostSidebar
        {...props}
        hosts={[{ ...hosts[0], generation: 3 }, hosts[1]]}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "machines" }))
    expect(
      document.querySelector('section[data-backend-key="remote:1"]')
    ).not.toHaveTextContent("same-repo")
    expect(screen.queryByText("A root both")).toBeNull()
    expect(screen.queryByText("A chat first")).toBeNull()
    const { panel } = await openTagFilter()
    expect(
      within(panel).getByRole("radio", { name: "filter.matchAll" })
    ).toBeDisabled()
    expect(within(panel).queryByText("tag1")).toBeNull()
  })
})

describe("multi-host workspace navigation", () => {
  it("routes equal folder IDs and paths to their containing machine", () => {
    const onOpenFolder = vi.fn()
    const onWorktrees = vi.fn()
    render(
      <MultiHostSidebar
        hosts={hosts}
        catalogs={
          new Map(
            hosts.map((host) => [
              host.key,
              { folders: [folder], loading: false },
            ])
          )
        }
        focusedHost="remote:1"
        collapsed={[]}
        onToggleHost={vi.fn()}
        onSelectHost={vi.fn()}
        onOpenFolder={onOpenFolder}
        onAddRepository={vi.fn()}
        onWorktrees={onWorktrees}
        onRefresh={vi.fn()}
        onManageConnections={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "machines" }))
    fireEvent.click(screen.getAllByTitle("/repo")[1])
    expect(onOpenFolder).toHaveBeenCalledWith("remote:2", folder, 2)
    fireEvent.click(
      screen.getAllByRole("button", { name: "manageWorktrees · same-repo" })[0]
    )
    expect(onWorktrees).toHaveBeenCalledWith("remote:1", folder, 1)
  })

  it("opens and closes equal tab IDs on the selected machine", () => {
    const a = {
      backendKey: "remote:1" as const,
      kind: "conversation" as const,
      id: "1",
      folderId: 1,
    }
    const b = { ...a, backendKey: "remote:2" as const }
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(
      <MultiHostTabs
        tabs={[
          { ref: a, title: "Same conversation", machineName: "Machine A" },
          { ref: b, title: "Same conversation", machineName: "Machine B" },
        ]}
        selected={a}
        onSelect={onSelect}
        onClose={onClose}
      />
    )
    const tabs = screen.getAllByRole("tab")
    expect(tabs[0]).toHaveAttribute("aria-selected", "true")
    expect(tabs[1]).toHaveAttribute("aria-selected", "false")
    fireEvent.click(tabs[1])
    expect(onSelect).toHaveBeenCalledWith(b)
    fireEvent.click(
      screen.getAllByRole("button", { name: "close · Same conversation" })[1]
    )
    expect(onClose).toHaveBeenCalledWith(b)
  })
})

it("defaults to Projects, keeps headers disclosure-only, restores Machines and scopes upgrade hints", () => {
  const onOpenFolder = vi.fn(),
    onWorktrees = vi.fn(),
    onAddRepository = vi.fn()
  const catalogs = new Map(
    hosts.map((h) => [
      h.key,
      {
        folders: [folder],
        loading: false,
        identityUnsupported: h.key === "remote:1",
        identities: new Map([
          [
            1,
            {
              folder_id: 1,
              path: "/repo",
              status: "resolved" as const,
              identity: {
                project_key: "github:o/r",
                repository_path: "o/r",
                provider: "github",
                host: "github.com",
                remote_name: "origin",
              },
            },
          ],
        ]),
      },
    ])
  )
  const props = {
    hosts,
    catalogs,
    focusedHost: "remote:2" as const,
    collapsed: [],
    onToggleHost: vi.fn(),
    onSelectHost: vi.fn(),
    onOpenFolder,
    onWorktrees,
    onAddRepository,
    onRefresh: vi.fn(),
    onManageConnections: vi.fn(),
  }
  const view = render(<MultiHostSidebar {...props} />)
  expect(screen.getByRole("button", { name: "projects" })).toHaveAttribute(
    "aria-pressed",
    "true"
  )
  fireEvent.click(screen.getByRole("button", { name: "o/r" }))
  expect(onOpenFolder).not.toHaveBeenCalled()
  expect(onWorktrees).not.toHaveBeenCalled()
  expect(
    document.querySelector('section[data-backend-key="remote:1"]')
  ).toHaveTextContent("identityUpgrade")
  expect(
    document.querySelector('section[data-backend-key="remote:2"]')
  ).not.toHaveTextContent("identityUpgrade")
  fireEvent.click(screen.getAllByRole("button", { name: "addRepository" })[1])
  expect(onAddRepository).toHaveBeenCalledWith("remote:2", 2)
  fireEvent.click(screen.getByRole("button", { name: "machines" }))
  fireEvent.click(screen.getAllByTitle("/repo")[1])
  expect(onOpenFolder).toHaveBeenCalledWith("remote:2", folder, 2)
  view.unmount()
  render(<MultiHostSidebar {...props} />)
  expect(screen.getByRole("button", { name: "machines" })).toHaveAttribute(
    "aria-pressed",
    "true"
  )
  fireEvent.click(screen.getByRole("button", { name: "projects" }))
  expect(screen.getByRole("button", { name: "o/r" })).toHaveAttribute(
    "aria-expanded",
    "false"
  )
})
