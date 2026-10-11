import type { BackendClient, BackendKey } from "./types"
import type { FolderDetail, GitWorktreeRemoval } from "@/lib/types"

export interface HostGitWorktree {
  path: string
  head: string | null
  branch: string | null
  is_main: boolean
  detached: boolean
  bare: boolean
  locked: string | null
  prunable: string | null
}

export interface HostRepositoryRef {
  backendKey: BackendKey
  folderId: number
  path: string
}

export interface CreateHostWorktree {
  branchName: string
  worktreePath: string
  base?: string
}

export class WorktreeRegistrationError extends Error {
  constructor(
    readonly repository: HostRepositoryRef,
    readonly worktreePath: string,
    readonly cause: unknown
  ) {
    super("Git created the worktree, but adding it to the workspace failed")
    this.name = "WorktreeRegistrationError"
  }
}

export class WorktreeRemovalError extends Error {
  constructor(
    readonly repository: HostRepositoryRef,
    readonly branchName: string,
    readonly cause: unknown
  ) {
    super("The checkout was removed, but branch cleanup did not finish")
    this.name = "WorktreeRemovalError"
  }
}

/** Every stage uses this service's client, including recovery after partial success. */
export class BackendWorktrees {
  constructor(private readonly client: BackendClient) {}

  private assertRepository(repository: HostRepositoryRef): void {
    if (repository.backendKey !== this.client.key) {
      throw new Error("Repository belongs to another machine")
    }
  }

  list(repository: HostRepositoryRef): Promise<HostGitWorktree[]> {
    this.assertRepository(repository)
    return this.client.transport.call("git_list_worktrees", {
      path: repository.path,
    })
  }

  async create(
    repository: HostRepositoryRef,
    input: CreateHostWorktree
  ): Promise<FolderDetail> {
    this.assertRepository(repository)
    await this.client.transport.call("git_worktree_add", {
      path: repository.path,
      branchName: input.branchName,
      worktreePath: input.worktreePath,
      base: input.base?.trim() || null,
    })
    try {
      return await this.register(repository, input.worktreePath)
    } catch (cause) {
      throw new WorktreeRegistrationError(repository, input.worktreePath, cause)
    }
  }

  register(
    repository: HostRepositoryRef,
    worktreePath: string
  ): Promise<FolderDetail> {
    this.assertRepository(repository)
    return this.client.transport.call("open_worktree_folder", {
      path: worktreePath,
      sourceFolderId: repository.folderId,
    })
  }

  remove(
    repository: HostRepositoryRef,
    worktree: HostGitWorktree,
    options: { deleteBranch: boolean; force: boolean }
  ): Promise<GitWorktreeRemoval> {
    this.assertRepository(repository)
    if (worktree.is_main || worktree.bare) {
      throw new Error("The main working tree cannot be removed")
    }
    return this.client.transport
      .call<GitWorktreeRemoval>("git_remove_worktree_path", {
        path: repository.path,
        worktreePath: worktree.path,
        sourceFolderId: repository.folderId,
        deleteBranch: worktree.branch ? options.deleteBranch : false,
        force: options.force,
      })
      .catch(async (cause: unknown) => {
        if (options.deleteBranch && worktree.branch) {
          try {
            const current = await this.list(repository)
            if (!current.some((entry) => entry.path === worktree.path)) {
              throw new WorktreeRemovalError(repository, worktree.branch, cause)
            }
          } catch (error) {
            if (error instanceof WorktreeRemovalError) throw error
            // An unavailable inventory is not proof that removal succeeded.
          }
        }
        throw cause
      })
  }

  finishBranchRemoval(
    repository: HostRepositoryRef,
    branchName: string,
    force: boolean
  ): Promise<void> {
    this.assertRepository(repository)
    return this.client.transport.call("git_delete_branch", {
      path: repository.path,
      branchName,
      force,
    })
  }
}
