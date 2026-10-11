import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { HostWorktreeDialog } from "./host-worktree-dialog"
import type { BackendClient } from "@/lib/backend/types"
import type { FolderDetail } from "@/lib/types"

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const repository: FolderDetail = {
  id: 1,
  name: "repo",
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

describe("worktree management on a fixed machine", () => {
  it("retries registration after partial creation without repeating Git", async () => {
    let registrations = 0
    const call = vi.fn(async (command: string) => {
      if (command === "git_list_worktrees") return []
      if (command === "git_worktree_add") return undefined
      if (command === "open_worktree_folder") {
        if (++registrations === 1) throw new Error("offline")
        return { ...repository, id: 2, path: "/repo-feature", parent_id: 1 }
      }
      throw new Error(`Unexpected command ${command}`)
    })
    const client = {
      key: "remote:1",
      name: "Machine A",
      transport: { call },
    } as unknown as BackendClient
    const onRegistered = vi.fn()
    render(
      <HostWorktreeDialog
        client={client}
        repository={repository}
        open
        onOpenChange={vi.fn()}
        onChanged={vi.fn()}
        onRegistered={onRegistered}
      />
    )
    await screen.findByText("noWorktrees")
    fireEvent.click(screen.getByRole("button", { name: "newWorktree" }))
    fireEvent.change(screen.getByLabelText("branch"), {
      target: { value: "feature" },
    })
    fireEvent.click(screen.getByRole("button", { name: "create" }))
    await screen.findByText("partialCreate")
    expect(onRegistered).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "retryRegistration" }))
    await waitFor(() =>
      expect(onRegistered).toHaveBeenCalledWith(
        expect.objectContaining({ id: 2, path: "/repo-feature" })
      )
    )
    expect(
      call.mock.calls.filter(([command]) => command === "git_worktree_add")
    ).toHaveLength(1)
  })

  it("opens the main checkout without parenting it to itself", async () => {
    const call = vi.fn().mockResolvedValue([
      {
        path: "/repo",
        head: "abc",
        branch: "main",
        is_main: true,
        detached: false,
        bare: false,
        locked: null,
        prunable: null,
      },
    ])
    const client = {
      key: "remote:2",
      name: "Machine B",
      transport: { call },
    } as unknown as BackendClient
    const onRegistered = vi.fn()
    render(
      <HostWorktreeDialog
        client={client}
        repository={repository}
        open
        onOpenChange={vi.fn()}
        onChanged={vi.fn()}
        onRegistered={onRegistered}
      />
    )
    fireEvent.click(await screen.findByRole("button", { name: "open" }))
    expect(onRegistered).toHaveBeenCalledWith(repository)
    expect(
      call.mock.calls.every(([command]) => command === "git_list_worktrees")
    ).toBe(true)
  })
  it("refreshes partial removal and retries only the surviving branch after explicit force", async () => {
    let removed = false
    const call = vi.fn(async (command: string) => {
      if (command === "git_list_worktrees")
        return removed
          ? []
          : [
              {
                path: "/feature",
                branch: "feature",
                head: "abc",
                is_main: false,
                bare: false,
                detached: false,
                locked: null,
                prunable: null,
              },
            ]
      if (command === "git_remove_worktree_path") {
        removed = true
        throw new Error("unmerged branch")
      }
      if (command === "git_delete_branch") return "deleted"
      throw new Error(command)
    })
    render(
      <HostWorktreeDialog
        client={
          {
            key: "remote:1",
            name: "A",
            transport: { call },
          } as unknown as BackendClient
        }
        repository={repository}
        open
        onOpenChange={vi.fn()}
        onChanged={vi.fn()}
        onRegistered={vi.fn()}
      />
    )
    fireEvent.click(await screen.findByRole("button", { name: "remove" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "deleteBranch" }))
    const removeButtons = screen.getAllByRole("button", { name: "remove" })
    fireEvent.click(removeButtons[removeButtons.length - 1])
    await screen.findByText("partialRemove")
    await screen.findByText("noWorktrees")
    expect(
      call.mock.calls.filter(([command]) => command === "git_delete_branch")
    ).toHaveLength(0)
    fireEvent.click(screen.getByRole("checkbox", { name: "forceBranchDelete" }))
    fireEvent.click(screen.getByRole("button", { name: "retryBranchDelete" }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("git_delete_branch", {
        path: "/repo",
        branchName: "feature",
        force: true,
      })
    )
    expect(
      call.mock.calls.filter(
        ([command]) => command === "git_remove_worktree_path"
      )
    ).toHaveLength(1)
  })
})
