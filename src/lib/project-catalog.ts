import type { BackendClient } from "@/lib/backend-client"
import {
  projectKeyFor,
  type BackendKey,
  type ProjectKey,
} from "@/lib/project-identity"
import type { FolderDetail, GitRemote } from "@/lib/types"

/** One folder on one machine, attributed to a logical project. */
export interface ProjectPlacement {
  backendKey: BackendKey
  folder: FolderDetail
  /** Worktree folders of this root on the same machine, sidebar order. */
  worktrees: FolderDetail[]
}

export interface CatalogProject {
  key: ProjectKey
  displayName: string
  /** Backend order first, then the folder's own sort order. */
  placements: ProjectPlacement[]
  /** Distinct machines this project is checked out on. */
  backendKeys: BackendKey[]
}

/** What one backend contributed to the catalog. */
export interface BackendCatalogSnapshot {
  backendKey: BackendKey
  folders: FolderDetail[]
  /** Root folder id → its remotes. Missing entries read as "no remote". */
  remotesByFolderId: ReadonlyMap<number, readonly GitRemote[]>
}

function folderLabel(folder: FolderDetail): string {
  return folder.alias?.trim() || folder.name
}

/**
 * Group every backend's open folders into logical projects.
 *
 * Pure: the caller decides what each backend's snapshot is, so an offline
 * machine can keep contributing its last known snapshot.
 */
export function buildProjectCatalog(
  snapshots: readonly BackendCatalogSnapshot[]
): CatalogProject[] {
  const projects = new Map<ProjectKey, CatalogProject>()

  for (const snapshot of snapshots) {
    const visible = snapshot.folders.filter((f) => f.kind !== "chat")
    const visibleIds = new Set(visible.map((f) => f.id))
    const byOrder = (a: FolderDetail, b: FolderDetail) =>
      a.sort_order - b.sort_order || a.id - b.id

    // A worktree whose root isn't open here is shown as its own root, so it
    // never disappears from the sidebar.
    const isChild = (f: FolderDetail) =>
      f.parent_id !== null && visibleIds.has(f.parent_id)
    const roots = visible.filter((f) => !isChild(f)).sort(byOrder)
    const childrenOf = new Map<number, FolderDetail[]>()
    for (const child of visible.filter(isChild).sort(byOrder)) {
      const list = childrenOf.get(child.parent_id!) ?? []
      list.push(child)
      childrenOf.set(child.parent_id!, list)
    }

    for (const root of roots) {
      const key = projectKeyFor(
        snapshot.backendKey,
        root.id,
        snapshot.remotesByFolderId.get(root.id) ?? []
      )
      let project = projects.get(key)
      if (!project) {
        project = {
          key,
          displayName: folderLabel(root),
          placements: [],
          backendKeys: [],
        }
        projects.set(key, project)
      }
      project.placements.push({
        backendKey: snapshot.backendKey,
        folder: root,
        worktrees: childrenOf.get(root.id) ?? [],
      })
      if (!project.backendKeys.includes(snapshot.backendKey)) {
        project.backendKeys.push(snapshot.backendKey)
      }
    }
  }

  return [...projects.values()]
}

/** Whether rows need a machine label: only when a project spans machines. */
export function needsMachineLabel(project: CatalogProject): boolean {
  return project.backendKeys.length > 1
}

/** What the sidebar of one window needs from the cross-machine catalog. */
export interface SidebarProjectView {
  /** This window's folder id → the other machines its project is also on. */
  otherMachinesByFolderId: ReadonlyMap<number, readonly BackendKey[]>
  /** Projects with no placement on this window's machine. */
  elsewhereProjects: readonly CatalogProject[]
}

/**
 * Project the catalog onto one window's sidebar: the window's own folders
 * stay as they are and learn which other machines share their project, and
 * projects that live only elsewhere become extra rows.
 */
export function sidebarProjectView(
  catalog: readonly CatalogProject[],
  ownKey: BackendKey
): SidebarProjectView {
  const otherMachinesByFolderId = new Map<number, BackendKey[]>()
  const elsewhereProjects: CatalogProject[] = []
  for (const project of catalog) {
    const own = project.placements.filter((p) => p.backendKey === ownKey)
    if (own.length === 0) {
      elsewhereProjects.push(project)
      continue
    }
    const others = project.backendKeys.filter((k) => k !== ownKey)
    if (others.length === 0) continue
    for (const placement of own) {
      otherMachinesByFolderId.set(placement.folder.id, others)
      for (const worktree of placement.worktrees) {
        otherMachinesByFolderId.set(worktree.id, others)
      }
    }
  }
  return { otherMachinesByFolderId, elsewhereProjects }
}

/** A machine in one refresh round: its key and the address it was read at. */
export interface CatalogBinding {
  backendKey: BackendKey
  /** Service address for remote machines; `null` for this machine. */
  baseUrl: string | null
}

export interface CatalogEntry {
  baseUrl: string | null
  snapshot: BackendCatalogSnapshot
}

/**
 * Fold one refresh round into the per-machine snapshots.
 *
 * A machine that answered replaces its entry. One that failed keeps its last
 * snapshot only while it is still bound to the same address: once a
 * connection points at another server, the old folders aren't that server's,
 * so they are dropped rather than shown under its name. Machines missing
 * from `bindings` (deleted connections) drop out.
 */
export function mergeCatalogRound(
  previous: ReadonlyMap<BackendKey, CatalogEntry>,
  bindings: readonly CatalogBinding[],
  results: readonly PromiseSettledResult<BackendCatalogSnapshot>[]
): Map<BackendKey, CatalogEntry> {
  const next = new Map<BackendKey, CatalogEntry>()
  bindings.forEach((binding, i) => {
    const result = results[i]
    if (result?.status === "fulfilled") {
      next.set(binding.backendKey, {
        baseUrl: binding.baseUrl,
        snapshot: result.value,
      })
      return
    }
    const old = previous.get(binding.backendKey)
    if (old && old.baseUrl === binding.baseUrl) {
      next.set(binding.backendKey, old)
    }
  })
  return next
}

/**
 * Read one backend's folders and their remotes. Remote lookups that fail
 * (missing directory, not a git repo, older server) degrade to "no remote"
 * for that folder only; a failed folder listing rejects so the caller can
 * keep this backend's previous snapshot.
 */
export async function loadBackendCatalogSnapshot(
  client: BackendClient
): Promise<BackendCatalogSnapshot> {
  const folders = await client.call<FolderDetail[]>("list_open_folder_details")
  // Same root rule as `buildProjectCatalog`: a worktree whose root isn't open
  // stands in for it, so it needs its own remotes.
  const visible = folders.filter((f) => f.kind !== "chat")
  const visibleIds = new Set(visible.map((f) => f.id))
  const roots = visible.filter(
    (f) => f.parent_id === null || !visibleIds.has(f.parent_id)
  )
  const entries = await Promise.all(
    roots.map(async (folder) => {
      try {
        const remotes = await client.call<GitRemote[]>("git_list_remotes", {
          path: folder.path,
        })
        return [folder.id, remotes] as const
      } catch {
        return [folder.id, [] as GitRemote[]] as const
      }
    })
  )
  return {
    backendKey: client.key,
    folders,
    remotesByFolderId: new Map(entries),
  }
}
