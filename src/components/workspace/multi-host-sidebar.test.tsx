import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { MultiHostSidebar } from "./multi-host-sidebar"
import { MultiHostTabs } from "./multi-host-tabs"
import type { BackendDescriptor } from "@/lib/backend/registry"
import type { FolderDetail } from "@/lib/types"

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
