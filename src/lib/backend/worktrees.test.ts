import { describe, expect, it, vi } from "vitest"
import {
  BackendWorktrees,
  WorktreeRegistrationError,
  WorktreeRemovalError,
  type HostGitWorktree,
} from "./worktrees"
import type { BackendClient } from "./types"

function service(key: BackendClient["key"]) {
  const call = vi.fn()
  const client = { key, transport: { call } } as unknown as BackendClient
  return { client, call, service: new BackendWorktrees(client) }
}

describe("host worktree workflows", () => {
  it("binds two identical repositories to different machines", async () => {
    const a = service("remote:1")
    const b = service("remote:2")
    a.call.mockResolvedValue([])
    b.call.mockResolvedValue([])
    await Promise.all([
      a.service.list({ backendKey: "remote:1", folderId: 1, path: "/repo" }),
      b.service.list({ backendKey: "remote:2", folderId: 1, path: "/repo" }),
    ])
    expect(a.call).toHaveBeenCalledOnce()
    expect(b.call).toHaveBeenCalledOnce()
    expect(() =>
      a.service.list({ backendKey: "remote:2", folderId: 1, path: "/repo" })
    ).toThrow("another machine")
  })

  it("recovers registration without repeating successful Git creation", async () => {
    const a = service("remote:1")
    const repository = {
      backendKey: "remote:1" as const,
      folderId: 1,
      path: "/repo",
    }
    a.call
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("offline"))
    let partial!: WorktreeRegistrationError
    try {
      await a.service.create(repository, {
        branchName: "feature",
        worktreePath: "/repo-feature",
        base: "main",
      })
    } catch (error) {
      expect(error).toBeInstanceOf(WorktreeRegistrationError)
      partial = error as WorktreeRegistrationError
    }
    expect(partial.worktreePath).toBe("/repo-feature")
    a.call.mockResolvedValueOnce({ id: 2, path: "/repo-feature" })
    await a.service.register(partial.repository, partial.worktreePath)
    expect(
      a.call.mock.calls.filter(([command]) => command === "git_worktree_add")
    ).toHaveLength(1)
    expect(a.call).toHaveBeenLastCalledWith("open_worktree_folder", {
      path: "/repo-feature",
      sourceFolderId: 1,
    })
  })

  it("removes detached worktrees by path and rejects the main checkout", async () => {
    const a = service("remote:1")
    const repository = {
      backendKey: "remote:1" as const,
      folderId: 1,
      path: "/repo",
    }
    const worktree: HostGitWorktree = {
      path: "/detached",
      branch: null,
      head: "123",
      is_main: false,
      detached: true,
      bare: false,
      locked: null,
      prunable: null,
    }
    a.call.mockResolvedValue({ worktree_path: "/detached" })
    await a.service.remove(repository, worktree, {
      force: false,
      deleteBranch: true,
    })
    expect(a.call).toHaveBeenCalledWith("git_remove_worktree_path", {
      path: "/repo",
      worktreePath: "/detached",
      sourceFolderId: 1,
      deleteBranch: false,
      force: false,
    })
    expect(() =>
      a.service.remove(
        repository,
        { ...worktree, is_main: true },
        { force: true, deleteBranch: true }
      )
    ).toThrow("main working tree")
  })
  it("recovers branch cleanup after partial removal without repeating checkout removal", async () => {
    const a = service("remote:1")
    const repository = {
      backendKey: "remote:1" as const,
      folderId: 1,
      path: "/repo",
    }
    const worktree: HostGitWorktree = {
      path: "/feature",
      branch: "feature",
      head: "abc",
      is_main: false,
      bare: false,
      detached: false,
      locked: null,
      prunable: null,
    }
    a.call
      .mockRejectedValueOnce(new Error("unmerged branch"))
      .mockResolvedValueOnce([])
    await expect(
      a.service.remove(repository, worktree, {
        deleteBranch: true,
        force: false,
      })
    ).rejects.toBeInstanceOf(WorktreeRemovalError)
    a.call.mockResolvedValueOnce("deleted")
    await a.service.finishBranchRemoval(repository, "feature", true)
    expect(a.call).toHaveBeenLastCalledWith("git_delete_branch", {
      path: "/repo",
      branchName: "feature",
      force: true,
    })
    expect(
      a.call.mock.calls.filter(
        ([command]) => command === "git_remove_worktree_path"
      )
    ).toHaveLength(1)
  })

  it("does not mistake an unavailable inventory for successful removal", async () => {
    const a = service("remote:1")
    const error = new Error("offline")
    a.call.mockRejectedValue(error)
    await expect(
      a.service.remove(
        { backendKey: "remote:1", folderId: 1, path: "/repo" },
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
        { deleteBranch: true, force: false }
      )
    ).rejects.toBe(error)
    expect(
      a.call.mock.calls.some(([command]) => command === "git_delete_branch")
    ).toBe(false)
  })
})
