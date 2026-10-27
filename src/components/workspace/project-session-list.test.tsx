import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ProjectSetupRows } from "./project-session-list"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"
import type { ProjectSetup } from "@/lib/backend/project-catalog"
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
const folder = (id = 1, parent_id: number | null = null): FolderDetail => ({
  id,
  parent_id,
  name: `repo${id}`,
  path: `/repo${id}`,
  kind: "regular",
  git_branch: `branch${id}`,
  default_agent_type: "codex",
  alias: null,
  group_id: null,
  color: "",
  last_opened_at: "",
  sort_order: 0,
})
const conv = (
  id: number,
  folder_id = 1,
  extra = {}
): DbConversationSummary => ({
  id,
  folder_id,
  title: `session${id}`,
  title_locked: false,
  agent_type: "codex",
  status: "completed",
  kind: "regular",
  model: null,
  git_branch: null,
  external_id: null,
  message_count: 1,
  child_count: 0,
  created_at: "",
  updated_at: "",
  pinned_at: null,
  ...extra,
})
const setup: ProjectSetup = {
  backendKey: "remote:1",
  generation: 7,
  folder: folder(),
  children: [folder(2, 1)],
}

describe("concrete repository history", () => {
  it("selects/expands without creating a draft and binds completed/pinned and worktree sessions to the captured owner", () => {
    const onOpenFolder = vi.fn(),
      onNewSession = vi.fn(),
      onOpenConversation = vi.fn()
    render(
      <ProjectSetupRows
        setup={setup}
        hostName="A"
        conversations={[
          conv(1, 1, { pinned_at: "2026" }),
          conv(2, 2),
          conv(3, 3),
          conv(4, 1, { parent_id: 1 }),
        ]}
        onOpenFolder={onOpenFolder}
        onNewSession={onNewSession}
        onOpenConversation={onOpenConversation}
        onWorktrees={vi.fn()}
        onRetry={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText("repo1"))
    expect(onOpenFolder).toHaveBeenCalledWith("remote:1", setup.folder, 7)
    expect(onNewSession).not.toHaveBeenCalled()
    expect(screen.getByText("session1")).toBeInTheDocument()
    expect(screen.queryByText("session3")).toBeNull()
    expect(screen.queryByText("session4")).toBeNull()
    fireEvent.click(screen.getByText("session1"))
    expect(onOpenConversation).toHaveBeenCalledWith(
      "remote:1",
      setup.folder,
      expect.objectContaining({ id: 1 }),
      7
    )
    fireEvent.click(screen.getByText("branch2"))
    fireEvent.click(screen.getByText("session2"))
    expect(onOpenConversation).toHaveBeenLastCalledWith(
      "remote:1",
      setup.children[0],
      expect.objectContaining({ id: 2 }),
      7
    )
    fireEvent.click(screen.getByRole("button", { name: "newSession · repo1" }))
    expect(onNewSession).toHaveBeenCalledWith("remote:1", setup.folder, 7)
  })
  it("bounds history and exposes show-more, host error/retry and loading", () => {
    const onRetry = vi.fn()
    render(
      <ProjectSetupRows
        setup={setup}
        hostName="A"
        conversations={Array.from({ length: 20 }, (_, i) => conv(i + 1))}
        historyLoading
        historyError="host A failed"
        onOpenFolder={vi.fn()}
        onNewSession={vi.fn()}
        onOpenConversation={vi.fn()}
        onWorktrees={vi.fn()}
        onRetry={onRetry}
      />
    )
    fireEvent.click(screen.getByText("repo1"))
    expect(screen.getByText("historyLoading")).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent("host A failed")
    const list = screen.getByTestId("history-remote:1-1")
    expect(
      within(list)
        .getAllByRole("button")
        .filter((b) => b.textContent?.includes("session"))
    ).toHaveLength(10)
    fireEvent.click(within(list).getByRole("button", { name: "showMore" }))
    expect(
      within(list)
        .getAllByRole("button")
        .filter((b) => b.textContent?.includes("session"))
    ).toHaveLength(20)
    fireEvent.click(screen.getByRole("button", { name: "retry" }))
    expect(onRetry).toHaveBeenCalledWith("remote:1", 7)
  })
})
