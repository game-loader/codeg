import { ProjectIdentityStore, catalogFolders } from "./project-catalog"
import { createBackendClient } from "./client"
import { FencedTransport } from "./fenced-transport"
import { createBackendStores, type BackendStores } from "./stores"
import type { BackendLifetime, BackendTarget } from "./registry"
import type { BackendClient } from "./types"
import type { Transport, RemoteTransportConfig } from "@/lib/transport"
import { RemoteDesktopTransport } from "@/lib/transport/remote-desktop-transport"
import {
  sanitizeWindowLayout,
  windowResourceKey,
  type WindowResourceRef,
} from "./window-layout"
import type { WindowResourceTab } from "@/components/workspace/multi-host-tabs"
import type { WorkbenchRouteId } from "@/contexts/workbench-route-context"
import {
  clearMessageInputDraftV2,
  hasMessageInputDraftContent,
  loadMessageInputDraftV2,
} from "@/lib/message-input-draft"
import { isBackendKey } from "./window-layout"

export interface RecoveryBuffer {
  kind: "file" | "composer"
  sourceId: string
  title: string
  path: string | null
  content: string
  language?: string
  saveError?: string | null
}

export interface RuntimeRecovery extends RecoveryBuffer {
  id: string
  backendKey: BackendClient["key"]
  machineName: string
  destination: string | null
  capturedAt: string
  persisted: boolean
}

const RECOVERY_PREFIX = "codeg:multi-host-recovery:v1:"

/** Append-only local recovery. Failed writes never evict the memory copy. */
export class RuntimeRecoveryStore {
  private snapshot: readonly RuntimeRecovery[] = []
  private listeners = new Set<() => void>()

  constructor(private readonly storage: () => Storage = () => localStorage) {}

  readonly getSnapshot = () => this.snapshot
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  reload(): void {
    const records = new Map(this.snapshot.map((record) => [record.id, record]))
    try {
      const storage = this.storage()
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index)
        if (!key?.startsWith(RECOVERY_PREFIX)) continue
        try {
          const value = JSON.parse(storage.getItem(key) ?? "null")
          if (
            !value ||
            typeof value.id !== "string" ||
            key !== RECOVERY_PREFIX + value.id ||
            !isBackendKey(value.backendKey) ||
            !["file", "composer"].includes(value.kind) ||
            typeof value.sourceId !== "string" ||
            typeof value.title !== "string" ||
            typeof value.content !== "string" ||
            typeof value.machineName !== "string" ||
            typeof value.capturedAt !== "string" ||
            !(value.path === null || typeof value.path === "string") ||
            !(
              value.destination === null ||
              typeof value.destination === "string"
            )
          )
            continue
          if (!records.has(value.id)) {
            records.set(value.id, {
              id: value.id,
              backendKey: value.backendKey,
              kind: value.kind,
              sourceId: value.sourceId,
              title: value.title,
              content: value.content,
              machineName: value.machineName,
              capturedAt: value.capturedAt,
              path: value.path,
              destination: recoveryDestination(value.destination),
              language:
                typeof value.language === "string" ? value.language : undefined,
              saveError:
                typeof value.saveError === "string" ? value.saveError : null,
              persisted: true,
            })
          }
        } catch {
          // One damaged record must not hide other recoverable buffers.
        }
      }
    } catch {
      // Existing memory records are still available when storage is denied.
    }
    if (records.size !== this.snapshot.length)
      this.publish([...records.values()])
  }

  retain(
    owner: Pick<RuntimeRecovery, "backendKey" | "machineName" | "destination">,
    buffer: RecoveryBuffer
  ): RuntimeRecovery {
    const destination = recoveryDestination(owner.destination)
    const existing = this.snapshot.find(
      (record) =>
        record.backendKey === owner.backendKey &&
        record.destination === destination &&
        record.kind === buffer.kind &&
        record.sourceId === buffer.sourceId &&
        record.path === buffer.path &&
        record.content === buffer.content
    )
    if (existing) return existing
    const record: RuntimeRecovery = {
      ...buffer,
      ...owner,
      language: buffer.language,
      saveError: buffer.saveError ?? null,
      destination,
      id: globalThis.crypto.randomUUID(),
      capturedAt: new Date().toISOString(),
      persisted: false,
    }
    // Keep the full text before attempting any fallible storage operation.
    this.snapshot = [...this.snapshot, record]
    try {
      this.storage().setItem(
        RECOVERY_PREFIX + record.id,
        JSON.stringify(record)
      )
      record.persisted = true
    } catch {
      // The UI explicitly offers this memory-only buffer for copy/export.
    }
    this.publish([...this.snapshot])
    return record
  }

  private publish(records: readonly RuntimeRecovery[]) {
    this.snapshot = records
    for (const listener of this.listeners) listener()
  }
}

function recoveryDestination(destination: string | null): string | null {
  if (destination === null) return null
  try {
    const url = new URL(destination)
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.href
  } catch {
    return null
  }
}

export const runtimeRecoveryStore = new RuntimeRecoveryStore()

/** Snapshots contain metadata; text is read only at a recovery checkpoint. */
export interface RuntimeView {
  hydrated: boolean
  tabs: readonly WindowResourceTab[]
  selected: WindowResourceRef | null
  routeId: WorkbenchRouteId
  sidebarOpen: boolean
  terminalOpen: boolean
  auxOpen: boolean
  select(ref: WindowResourceRef): void
  close(ref: WindowResourceRef): void
  restoreFile(ref: Extract<WindowResourceRef, { kind: "file" }>): Promise<void>
  navigate(route: WorkbenchRouteId): void
  search(): void
  toggleSidebar(): void
  toggleTerminal(): void
  toggleAux(): void
  captureDirtyFiles?(): readonly RecoveryBuffer[]
  captureComposerDrafts?(): readonly RecoveryBuffer[]
}

export interface BackendRuntimeOptions {
  shellTransport: Transport
  windowInstanceId: string
  onConfigurationChanged?: () => void
  createRemoteTransport?: (config: RemoteTransportConfig) => Transport
  createStores?: (client: BackendClient) => BackendStores
  /** Set only when the saved endpoint changes, never on focus changes. */
  resetDestinationState?: boolean
  previousDestination?: string
  recoveryStore?: RuntimeRecoveryStore
}

export class BackendRuntime {
  readonly client: BackendClient
  readonly stores: BackendStores
  readonly generation: number
  readonly projectIdentities: ProjectIdentityStore
  private stopCatalogObservation: (() => void) | null = null
  private disposed = false
  private listeners = new Set<() => void>()
  private view: RuntimeView | null = null
  private readonly recoveryStore: RuntimeRecoveryStore

  constructor(
    target: BackendTarget,
    private readonly lifetime: BackendLifetime,
    options: BackendRuntimeOptions
  ) {
    this.generation = lifetime.generation
    this.recoveryStore = options.recoveryStore ?? runtimeRecoveryStore
    const connection = target.connection
    const inner = connection
      ? (
          options.createRemoteTransport ??
          ((config) => new RemoteDesktopTransport(config))
        )({
          id: connection.id,
          name: connection.name,
          baseUrl: connection.base_url,
          token: connection.token,
          configRevision: connection.config_revision,
          windowInstanceId: options.windowInstanceId,
          onUnauthorized: () => lifetime.setStatus("unauthorized"),
          onDisconnected: () => lifetime.setStatus("offline"),
          onConfigurationChanged: () => {
            if (lifetime.isCurrent()) options.onConfigurationChanged?.()
          },
        })
      : options.shellTransport
    const transport = new FencedTransport(inner, lifetime, !!connection)
    this.client = createBackendClient({
      key: target.key,
      name: target.name,
      transport,
      shellTransport: options.shellTransport,
      remoteConnection: connection,
      desktop: true,
      windowInstanceId: options.windowInstanceId,
      onUnauthorized: () => lifetime.setStatus("unauthorized"),
      onRepositoryRemotesChanged: (path) => {
        if (!lifetime.isCurrent() || this.disposed) return
        const state = this.stores.workspace.getState()
        if (
          catalogFolders(state.folders, state.allFolders).some(
            (folder) => folder.path === path
          )
        ) {
          void this.projectIdentities.refresh(false)
        }
      },
      onConfigurationChanged: () => {
        if (lifetime.isCurrent()) options.onConfigurationChanged?.()
      },
    })
    if (options.resetDestinationState) {
      const draftKeys = this.preserveComposerDrafts(
        options.previousDestination ?? null
      )
      // A reopened window may have no live old runtime, but its draft cache or
      // persisted drafts still belong to the previous destination.
      for (const record of this.recoveryStore.getSnapshot()) {
        if (
          record.backendKey === target.key &&
          record.kind === "composer" &&
          (record.sourceId.startsWith(
            `backend:${encodeURIComponent(target.key)}:draft:`
          ) ||
            record.sourceId.endsWith(`:backend:${target.key}`))
        )
          draftKeys.add(record.sourceId)
      }
      for (const draftKey of draftKeys) clearMessageInputDraftV2(draftKey)
      // Clear before factories hydrate cached IDs belonging to the old endpoint.
      try {
        const keys = Object.keys(localStorage).filter(
          (key) =>
            key.endsWith(`:backend:${target.key}`) &&
            !key.startsWith("codeg:message-input-draft:")
        )
        for (const key of keys) localStorage.removeItem(key)
      } catch {
        /* Storage may be denied. The new stores still fence requests. */
      }
    }
    try {
      this.stores = (options.createStores ?? createBackendStores)(this.client)
    } catch (error) {
      transport.destroy()
      throw error
    }
    this.projectIdentities = new ProjectIdentityStore(
      (ids) => this.client.api.listRepositoryProjectIdentities(ids),
      () => !this.disposed && lifetime.isCurrent()
    )
    const updateCatalog = () => {
      const state = this.stores.workspace.getState()
      void this.projectIdentities.setFolders(
        catalogFolders(state.folders, state.allFolders)
      )
    }
    this.stopCatalogObservation = this.stores.workspace.subscribe(updateCatalog)
    updateCatalog()
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): RuntimeView | null => this.view

  publishView(view: RuntimeView): void {
    if (this.disposed || !this.lifetime.isCurrent()) return
    this.view = view
    for (const listener of this.listeners) listener()
  }

  clearView(view: RuntimeView): void {
    if (this.view !== view) return
    this.captureRecovery()
    this.view = null
    for (const listener of this.listeners) listener()
  }

  /** Closing a host releases subscriptions, never cancels backend work. */
  dispose(): void {
    if (this.disposed) return
    this.captureRecovery()
    this.disposed = true
    this.stopCatalogObservation?.()
    this.projectIdentities.dispose()
    this.client.transport.destroy?.()
    this.stores.dispose()
    this.view = null
    this.listeners.clear()
  }

  captureRecovery(): void {
    const owner = {
      backendKey: this.client.key,
      machineName: this.client.name,
      destination: this.client.remoteConnection?.base_url ?? null,
    }
    for (const buffer of this.view?.captureDirtyFiles?.() ?? [])
      this.recoveryStore.retain(owner, buffer)
    // A scoped composer can have a live document even when its debounced
    // storage write failed. Retain the rendered document independently too.
    for (const buffer of this.view?.captureComposerDrafts?.() ?? [])
      this.recoveryStore.retain(owner, buffer)
    this.preserveComposerDrafts(owner.destination)
  }

  private preserveComposerDrafts(destination: string | null): Set<string> {
    const backendKey = this.client.key
    const draftPrefix = `backend:${encodeURIComponent(backendKey)}:draft:`
    const suffix = `:backend:${backendKey}`
    const keys = new Set<string>()
    // Read live readers first: they flush a pending composer debounce without
    // sending a prompt or publishing text on each keystroke.
    if (this.stores) {
      for (const tab of this.stores.tabs.getState().tabs) {
        keys.add(
          tab.conversationId != null
            ? `conv:${tab.conversationId}${suffix}`
            : `${draftPrefix}${tab.id}`
        )
      }
    }
    const rawDrafts = new Map<string, string>()
    try {
      for (const storedKey of Object.keys(localStorage)) {
        const match = /^codeg:message-input-draft:v[12]:(.*)$/.exec(storedKey)
        const draftKey = match?.[1]
        if (
          !draftKey ||
          !(draftKey.startsWith(draftPrefix) || draftKey.endsWith(suffix))
        )
          continue
        keys.add(draftKey)
        const raw = localStorage.getItem(storedKey)
        if (raw !== null) rawDrafts.set(draftKey, raw)
      }
    } catch {
      // Known live tabs still provide their in-memory composer draft.
    }
    const retained = new Set<string>()
    for (const draftKey of keys) {
      hasMessageInputDraftContent(draftKey)
      const loaded = loadMessageInputDraftV2(draftKey)
      const content = loaded
        ? loaded.kind === "doc"
          ? JSON.stringify(loaded.doc, null, 2)
          : loaded.markdown
        : rawDrafts.get(draftKey)
      if (content === undefined) continue
      this.recoveryStore.retain(
        { backendKey, machineName: this.client.name, destination },
        {
          kind: "composer",
          sourceId: draftKey,
          title: draftKey,
          path: null,
          content,
        }
      )
      retained.add(draftKey)
    }
    return retained
  }
}

export function createWindowInstanceId(): string {
  return `multi-host-${globalThis.crypto.randomUUID()}`
}

const WINDOW_TABS_KEY = "codeg:multi-host-tabs:v1"

/** Companion metadata preserves order and offline conversation placeholders. */
export function readWindowTabs(): WindowResourceTab[] {
  try {
    const raw: unknown = JSON.parse(
      localStorage.getItem(WINDOW_TABS_KEY) ?? "[]"
    )
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    return raw.slice(0, 400).flatMap((entry) => {
      if (!entry || typeof entry !== "object") return []
      const ref = sanitizeWindowLayout({
        version: 1,
        selected: entry.ref,
      }).selected
      if (!ref || typeof entry.title !== "string") return []
      const key = windowResourceKey(ref)
      if (seen.has(key)) return []
      seen.add(key)
      return [
        { ref, title: entry.title.slice(0, 8192), machineName: ref.backendKey },
      ]
    })
  } catch {
    return []
  }
}

export function saveWindowTabs(tabs: readonly WindowResourceTab[]): void {
  try {
    localStorage.setItem(
      WINDOW_TABS_KEY,
      JSON.stringify(
        tabs.slice(0, 400).flatMap(({ ref, title }) => {
          const safe = sanitizeWindowLayout({
            version: 1,
            selected: ref,
          }).selected
          return safe ? [{ ref: safe, title: title.slice(0, 8192) }] : []
        })
      )
    )
  } catch {
    /* Device storage is optional. */
  }
}
