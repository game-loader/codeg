import type { RemoteWorkspaceConnection } from "@/lib/types"
import type { BackendKey } from "./types"

export type BackendConnectionStatus =
  | "connecting"
  | "connected"
  | "offline"
  | "unauthorized"

export interface BackendDescriptor {
  key: BackendKey
  name: string
  baseUrl: string | null
  generation: number
  status: BackendConnectionStatus
  error: string | null
}

export type BackendTarget =
  | { key: "local"; name: string; connection: null }
  | {
      key: `remote:${number}`
      name: string
      connection: RemoteWorkspaceConnection
    }

export interface BackendLifetime {
  readonly generation: number
  isCurrent(): boolean
  setStatus(status: BackendConnectionStatus, error?: string | null): void
}

export interface BackendRegistryResource {
  dispose(): void
}

export type BackendRuntimeFactory<T extends BackendRegistryResource> = (
  target: BackendTarget,
  lifetime: BackendLifetime
) => T

interface Entry<T extends BackendRegistryResource> {
  target: BackendTarget
  descriptor: BackendDescriptor
  resource: T
  retired: boolean
}

function effectiveHeaders(connection: RemoteWorkspaceConnection): string {
  const headers = new Map<string, string[]>()
  for (const header of connection.headers) {
    const name = header.name.toLowerCase()
    headers.set(name, [...(headers.get(name) ?? []), header.value])
  }
  return JSON.stringify([...headers].sort(([a], [b]) => a.localeCompare(b)))
}

function sameDestination(left: BackendTarget, right: BackendTarget): boolean {
  if (left.key !== right.key) return false
  if (!left.connection || !right.connection) {
    return left.connection === right.connection
  }
  return (
    left.connection.base_url === right.connection.base_url &&
    left.connection.token === right.connection.token &&
    effectiveHeaders(left.connection) === effectiveHeaders(right.connection)
  )
}

/**
 * Owns the fixed runtimes of a window. The public snapshot deliberately omits
 * connection credentials; layout persistence stores keys and resource IDs.
 */
export class BackendRegistry<T extends BackendRegistryResource> {
  private entries = new Map<BackendKey, Entry<T>>()
  private listeners = new Set<() => void>()
  private snapshot: readonly BackendDescriptor[] = []
  private nextGeneration = 0
  private disposed = false

  constructor(private readonly factory: BackendRuntimeFactory<T>) {}

  readonly getSnapshot = (): readonly BackendDescriptor[] => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get(key: BackendKey): T | undefined {
    return this.entries.get(key)?.resource
  }

  descriptor(key: BackendKey): BackendDescriptor | undefined {
    return this.entries.get(key)?.descriptor
  }

  upsert(target: BackendTarget): T {
    if (this.disposed) throw new Error("Backend registry is closed")
    if (target.connection && target.key !== `remote:${target.connection.id}`) {
      throw new Error("Backend identity does not match its connection")
    }
    const previous = this.entries.get(target.key)
    if (previous && sameDestination(previous.target, target)) {
      previous.target = target
      if (previous.descriptor.name !== target.name) {
        previous.descriptor = { ...previous.descriptor, name: target.name }
        this.publish()
      }
      return previous.resource
    }

    // Retire before constructing the replacement. A synchronous callback from
    // dispose must not mutate the next generation or report it as offline.
    if (previous) {
      previous.retired = true
      this.entries.delete(target.key)
      previous.resource.dispose()
    }

    const generation = ++this.nextGeneration
    const descriptor: BackendDescriptor = {
      key: target.key,
      name: target.name,
      baseUrl: target.connection?.base_url ?? null,
      generation,
      status: target.connection ? "connecting" : "connected",
      error: null,
    }
    let retired = false
    const isCurrent = () => {
      if (this.disposed || retired) return false
      const entry = this.entries.get(target.key)
      return entry?.descriptor.generation === generation && !entry.retired
    }
    const lifetime: BackendLifetime = {
      generation,
      isCurrent,
      setStatus: (status, error = null) => {
        if (!isCurrent()) return
        const entry = this.entries.get(target.key)!
        if (
          entry.descriptor.status === status &&
          entry.descriptor.error === error
        ) {
          return
        }
        entry.descriptor = { ...entry.descriptor, status, error }
        this.publish()
      },
    }
    let resource: T
    try {
      resource = this.factory(target, lifetime)
    } catch (error) {
      retired = true
      this.publish()
      throw error
    }
    this.entries.set(target.key, {
      target,
      descriptor,
      resource,
      retired: false,
    })
    this.publish()
    return resource
  }

  remove(key: BackendKey): void {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.retired = true
    this.entries.delete(key)
    entry.resource.dispose()
    this.publish()
  }

  /** Reconcile saved connections without disturbing unchanged active runtimes. */
  syncRemoteConnections(
    connections: readonly RemoteWorkspaceConnection[]
  ): void {
    const wanted = new Set<BackendKey>()
    for (const connection of connections) {
      const key = `remote:${connection.id}` as const
      wanted.add(key)
      this.upsert({ key, name: connection.name, connection })
    }
    for (const key of this.entries.keys()) {
      if (key !== "local" && !wanted.has(key)) this.remove(key)
    }
    const ordered = new Map<BackendKey, Entry<T>>()
    const local = this.entries.get("local")
    if (local) ordered.set("local", local)
    for (const key of wanted) {
      const entry = this.entries.get(key)
      if (entry) ordered.set(key, entry)
    }
    if (
      JSON.stringify([...ordered.keys()]) !==
      JSON.stringify([...this.entries.keys()])
    ) {
      this.entries = ordered
      this.publish()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const entries = [...this.entries.values()]
    this.entries.clear()
    for (const entry of entries) {
      entry.retired = true
      entry.resource.dispose()
    }
    this.publish()
    this.listeners.clear()
  }

  private publish(): void {
    this.snapshot = [...this.entries.values()].map((entry) => entry.descriptor)
    for (const listener of this.listeners) listener()
  }
}
