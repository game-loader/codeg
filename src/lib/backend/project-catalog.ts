import type { FolderDetail, RepositoryProjectIdentityEntry } from "@/lib/types"
import type { BackendDescriptor } from "./registry"
import type { BackendKey } from "./types"

export interface ProjectSetup {
  backendKey: BackendKey
  generation: number
  folder: FolderDetail
  children: readonly FolderDetail[]
}

export interface LogicalProject {
  key: string
  name: string
  setups: ProjectSetup[]
}

/** Open folders plus known ancestors, always inside one runtime. */
export function catalogFolders(
  opened: readonly FolderDetail[],
  all: readonly FolderDetail[]
): FolderDetail[] {
  const known = new Map(all.map((f) => [f.id, f]))
  for (const folder of opened) {
    if (!known.has(folder.id)) known.set(folder.id, folder)
  }
  const ids = new Set<number>()
  for (const folder of opened) {
    let current: FolderDetail | undefined = folder
    while (current && !ids.has(current.id)) {
      ids.add(current.id)
      current = current.parent_id ? known.get(current.parent_id) : undefined
    }
  }
  return [...known.values()].filter((f) => ids.has(f.id) && f.kind !== "chat")
}

/** Include unopened working copies that still own historical sessions. */
export function historyCatalogFolders(
  opened: readonly FolderDetail[],
  all: readonly FolderDetail[],
  conversations: readonly import("@/lib/types").DbConversationSummary[]
): FolderDetail[] {
  const historyIds = new Set(conversations.map((c) => c.folder_id))
  return catalogFolders(
    [...opened, ...all.filter((f) => historyIds.has(f.id))],
    all
  )
}

export function projectCatalog(
  hosts: readonly BackendDescriptor[],
  catalogs: ReadonlyMap<
    BackendKey,
    {
      folders: readonly FolderDetail[]
      generation?: number
      identities?: ReadonlyMap<number, RepositoryProjectIdentityEntry>
    }
  >
): LogicalProject[] {
  const projects = new Map<string, LogicalProject>()
  for (const host of hosts) {
    const catalog = catalogs.get(host.key)
    if (
      !catalog ||
      (catalog.generation !== undefined &&
        catalog.generation !== host.generation)
    )
      continue
    const folders = catalog.folders.filter((f) => f.kind !== "chat")
    for (const folder of folders) {
      if (folder.parent_id && folders.some((p) => p.id === folder.parent_id))
        continue
      const entry = catalog.identities?.get(folder.id)
      const identity = entry?.path === folder.path ? entry.identity : null
      const key =
        identity?.project_key ??
        JSON.stringify([
          "local",
          host.key,
          host.generation,
          folder.id,
          folder.path,
        ])
      let project = projects.get(key)
      if (!project) {
        project = {
          key,
          name: identity?.repository_path ?? folder.alias ?? folder.name,
          setups: [],
        }
        projects.set(key, project)
      }
      project.setups.push({
        backendKey: host.key,
        generation: host.generation,
        folder,
        children: folders.filter((child) => child.parent_id === folder.id),
      })
    }
  }
  return [...projects.values()]
}

export interface ProjectIdentitySnapshot {
  entries: ReadonlyMap<number, RepositoryProjectIdentityEntry>
  loading: boolean
  unavailable: boolean
  capability: "unknown" | "supported" | "unsupported"
}

export function isProjectIdentityUnsupported(error: unknown): boolean {
  if (error && typeof error === "object") {
    const e = error as {
      status?: number
      statusCode?: number
      message?: string
    }
    if ([404, 405, 501].includes(e.status ?? e.statusCode ?? 0)) return true
    return /\b(?:HTTP\s+)?(?:404|405|501)\b|command .*list_repository_project_identities.*not found/i.test(
      e.message ?? ""
    )
  }
  return (
    typeof error === "string" &&
    /\b(?:404|405|501)\b|command .*list_repository_project_identities.*not found/i.test(
      error
    )
  )
}

/** Retained only in memory. Errors never enter the new metadata cache. */
export class ProjectIdentityStore {
  private snapshot: ProjectIdentitySnapshot = {
    entries: new Map(),
    loading: false,
    unavailable: false,
    capability: "unknown",
  }
  private folders: readonly FolderDetail[] = []
  private signature = ""
  private sequence = 0
  private disposed = false
  private listeners = new Set<() => void>()
  private pending: Promise<void> | null = null

  constructor(
    private readonly fetch: (
      ids: number[]
    ) => Promise<RepositoryProjectIdentityEntry[]>,
    private readonly isCurrent: () => boolean
  ) {}

  readonly getSnapshot = () => this.snapshot
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(snapshot: ProjectIdentitySnapshot) {
    if (this.disposed || !this.isCurrent()) return
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }

  setFolders(folders: readonly FolderDetail[]): Promise<void> {
    if (this.disposed || !this.isCurrent()) return Promise.resolve()
    const roots = folders.filter(
      (f) => !f.parent_id || !folders.some((p) => p.id === f.parent_id)
    )
    const signature = JSON.stringify(
      roots
        .map((f) => [f.id, f.path])
        .sort((a, b) => Number(a[0]) - Number(b[0]))
    )
    if (signature === this.signature) return this.pending ?? Promise.resolve()
    this.signature = signature
    this.folders = roots
    ++this.sequence
    this.pending = null
    const entries = new Map(
      [...this.snapshot.entries].filter(([id, entry]) =>
        roots.some((f) => f.id === id && f.path === entry.path)
      )
    )
    this.publish({ ...this.snapshot, entries, loading: false })
    return this.load(false)
  }

  /** Explicit refresh bypasses an old server's cached capability result. */
  refresh(reprobeCapability = true): Promise<void> {
    if (!reprobeCapability && this.snapshot.capability === "unsupported")
      return Promise.resolve()
    return this.load(true)
  }

  private load(explicit: boolean): Promise<void> {
    if (
      this.disposed ||
      !this.isCurrent() ||
      (!explicit && this.snapshot.capability === "unsupported")
    )
      return Promise.resolve()
    if (!explicit && this.pending) return this.pending
    const sequence = ++this.sequence
    const current = () =>
      !this.disposed && this.isCurrent() && sequence === this.sequence
    const folders = this.folders.slice()
    this.publish({ ...this.snapshot, loading: folders.length > 0 })
    const pending = (async () => {
      const entries = new Map(this.snapshot.entries)
      let unavailable = false
      let capability = this.snapshot.capability
      for (let offset = 0; offset < folders.length; offset += 128) {
        const batch = folders.slice(offset, offset + 128)
        try {
          const result = await this.fetch(batch.map((f) => f.id))
          if (!current()) return
          if (!Array.isArray(result))
            throw new Error("Invalid identity response")
          capability = "supported"
          for (const folder of batch) {
            const rows = result.filter((e) => e?.folder_id === folder.id)
            const row = rows.length === 1 ? rows[0] : undefined
            if (
              row?.status === "resolved" &&
              row.path === folder.path &&
              (row.identity === null || validIdentity(row.identity))
            ) {
              // Copy the protocol whitelist, never extraneous response fields.
              entries.set(folder.id, {
                folder_id: folder.id,
                path: folder.path,
                status: "resolved",
                identity:
                  row.identity === null
                    ? null
                    : {
                        project_key: row.identity.project_key,
                        provider: row.identity.provider,
                        host: row.identity.host,
                        repository_path: row.identity.repository_path,
                        remote_name: row.identity.remote_name,
                      },
              })
            } else unavailable = true
          }
        } catch (error) {
          if (!current()) return
          unavailable = true
          if (isProjectIdentityUnsupported(error)) {
            capability = "unsupported"
            break
          }
        }
      }
      if (current())
        this.publish({ entries, loading: false, unavailable, capability })
    })()
    this.pending = pending
    void pending.finally(() => {
      if (current()) this.pending = null
    })
    return pending
  }

  dispose() {
    this.disposed = true
    ++this.sequence
    this.pending = null
    this.folders = []
    this.snapshot = {
      entries: new Map(),
      loading: false,
      unavailable: false,
      capability: "unknown",
    }
    for (const listener of this.listeners) listener()
    this.listeners.clear()
  }
}

function validIdentity(
  value: RepositoryProjectIdentityEntry["identity"]
): boolean {
  if (!value || typeof value !== "object") return false
  return (
    [
      value.project_key,
      value.provider,
      value.host,
      value.repository_path,
    ].every(
      (v) =>
        typeof v === "string" &&
        v.length > 0 &&
        v.length <= 8192 &&
        !/[\s@?#\\]|:\/\//.test(v)
    ) &&
    /^(github|git):/.test(value.project_key) &&
    // The upstream fetch-row contract treats the remote name as metadata,
    // allowing punctuation such as @. Colon is not valid in a Git ref name
    // and also marks SCP-style raw URLs; reject it alongside controls/schemes.
    typeof value.remote_name === "string" &&
    value.remote_name.length > 0 &&
    value.remote_name.length <= 8192 &&
    !/[\u0000-\u001f\u007f-\u009f:]|:\/\//.test(value.remote_name)
  )
}
