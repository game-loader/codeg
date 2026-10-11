import { vi } from "vitest"
import { createBackendClient } from "@/lib/backend/client"
import { createBackendStores } from "@/lib/backend/stores"
import type {
  AttachHandlers,
  AttachOptions,
  EventStream,
  Transport,
} from "@/lib/transport/types"
import type {
  AcpEvent,
  AcpAgentStatus,
  DbConversationSummary,
  FileEditContent,
  FolderDetail,
  GitHeadInfo,
  LiveSessionSnapshot,
  OpenedTabsSnapshot,
  SaveTabsOutcome,
  WorkspaceSnapshotResponse,
} from "@/lib/types"

export const ROOT = "/same/repo"
export const FILE = `${ROOT}/src/shared.ts`
export const CONNECTION_ID = "same-connection"
export const CONTEXT_KEY = "same-conversation-surface"
const DATE = "2026-10-11T00:00:00Z"

export function folder(host: string, id = 1): FolderDetail {
  return {
    id,
    path: id === 1 ? ROOT : "/same/other-repo",
    name: `${host} folder ${id}`,
    kind: "regular",
    git_branch: `${host}-main`,
    default_agent_type: "claude_code",
    last_opened_at: DATE,
    sort_order: id,
    color: "gray",
    parent_id: null,
    group_id: null,
    alias: null,
  }
}

export function conversation(host: string, id = 1): DbConversationSummary {
  return {
    id,
    folder_id: id,
    agent_type: "claude_code",
    title: `${host} conversation ${id}`,
    title_locked: false,
    status: "completed",
    kind: "regular",
    model: null,
    git_branch: `${host}-main`,
    external_id: `same-session-${id}`,
    message_count: 0,
    child_count: 0,
    created_at: DATE,
    updated_at: DATE,
    pinned_at: null,
  }
}

function sessionSnapshot(): LiveSessionSnapshot {
  return {
    connection_id: CONNECTION_ID,
    conversation_id: 1,
    folder_id: 1,
    status: "connected",
    external_id: "same-session-1",
    live_message: null,
    active_tool_calls: [],
    pending_permission: null,
    modes: null,
    current_mode: null,
    config_options: null,
    prompt_capabilities: null,
    usage: null,
    fork_supported: false,
    available_commands: [],
    selectors_ready: true,
    event_seq: 0,
  }
}

function workspaceSnapshot(rootPath: string): WorkspaceSnapshotResponse {
  return {
    root_path: rootPath,
    seq: 0,
    version: 1,
    full: true,
    tree_snapshot: [],
    git_snapshot: [],
    deltas: [],
    degraded: false,
    is_git_repo: true,
  }
}

/** The only backend boundary stub: APIs, stores, hooks and providers stay real. */
export class FakeProductionTransport implements Transport {
  readonly unexpectedCommands: string[] = []
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>()
  readonly reconnectListeners = new Set<() => void>()
  readonly attachments = new Map<string, AttachHandlers>()
  readonly files = new Map<string, FileEditContent>()
  private seq = 0
  private subscriptionSerial = 0
  private holds = new Map<string, { promise: Promise<void>; release(): void }>()
  private pendingReleases = new Set<() => void>()
  private tabs: OpenedTabsSnapshot = {
    version: 1,
    items: [1, 2].map((id) => ({
      id,
      folder_id: id,
      conversation_id: id,
      agent_type: "claude_code",
      position: id - 1,
      is_active: id === 1,
      is_pinned: true,
    })),
  }

  constructor(readonly host: "A" | "B") {
    this.files.set(FILE, {
      path: "shared.ts",
      content: `${host} disk contents`,
      etag: `${host}-etag-1`,
      mtime_ms: 1,
      readonly: false,
      line_ending: "lf",
    })
  }

  private readonly callSpy = vi.fn(
    async (
      command: string,
      args: Record<string, unknown> = {}
    ): Promise<unknown> => {
      const hold = this.holds.get(command)
      this.holds.delete(command)
      const response = this.respond(command, args)
      if (hold) await hold.promise
      return response
    }
  )

  async call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    return (await this.callSpy(command, args)) as T
  }

  /** Delay a response, without clocks or sleeps; requests still reach this host. */
  holdNext(command: string): () => void {
    if (this.holds.has(command)) throw new Error(`Already holding ${command}`)
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
      resolve = done
    })
    const release = () => {
      this.pendingReleases.delete(release)
      resolve()
    }
    this.pendingReleases.add(release)
    this.holds.set(command, { promise, release })
    return release
  }

  releasePending(): void {
    for (const release of [...this.pendingReleases]) release()
    this.holds.clear()
  }

  readonly attach = vi.fn(
    (
      connectionId: string,
      _options: AttachOptions,
      handlers: AttachHandlers
    ) => {
      if (connectionId !== CONNECTION_ID) {
        throw new Error(`Unexpected attach: ${connectionId}`)
      }
      const subscriptionId = `${this.host}-${++this.subscriptionSerial}`
      this.attachments.set(subscriptionId, handlers)
      // Exercise production snapshot denormalization as well as live routing.
      handlers.onSnapshot(sessionSnapshot(), 0)
      return {
        subscriptionId,
        detach: vi.fn(() => this.attachments.delete(subscriptionId)),
      }
    }
  )

  private readonly stream: EventStream = { attach: this.attach }
  eventStream(): EventStream {
    return this.stream
  }

  emitAcp(event: AcpEvent): void {
    if (this.attachments.size === 0) throw new Error("No live ACP subscription")
    const envelope = {
      ...event,
      seq: ++this.seq,
      connection_id: CONNECTION_ID,
    }
    for (const handlers of [...this.attachments.values()]) {
      handlers.onEvent(envelope)
    }
  }

  async subscribe<T>(event: string, handler: (payload: T) => void) {
    const listeners = this.listeners.get(event) ?? new Set()
    this.listeners.set(event, listeners)
    const listener = (payload: unknown) => handler(payload as T)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  emitBackend<T>(event: string, payload: T): void {
    const listeners = this.listeners.get(event)
    if (!listeners?.size) throw new Error(`No subscription to ${event}`)
    for (const listener of [...listeners]) listener(payload)
  }

  onReconnect(callback: () => void) {
    this.reconnectListeners.add(callback)
    return () => {
      this.reconnectListeners.delete(callback)
    }
  }

  isDesktop() {
    return false
  }

  requests(command: string) {
    return this.callSpy.mock.calls
      .filter(([name]) => name === command)
      .map(([, args]) => args)
  }

  private respond(command: string, args: Record<string, unknown>): unknown {
    switch (command) {
      case "list_open_folder_details":
      case "list_all_folder_details":
        return [folder(this.host), folder(this.host, 2)]
      case "list_folder_groups":
      case "list_child_conversations":
      case "acp_list_agents":
        return []
      case "list_all_conversations":
        return [conversation(this.host), conversation(this.host, 2)]
      case "list_opened_tabs":
        return this.tabs
      case "save_opened_tabs":
        this.tabs = {
          version: this.tabs.version + 1,
          items: args.items as OpenedTabsSnapshot["items"],
        }
        return {
          accepted: true,
          version: this.tabs.version,
          tabs: this.tabs.items,
        } satisfies SaveTabsOutcome
      case "get_git_head":
        return {
          is_repo: true,
          branch: `${this.host}-main`,
          detached: false,
          short_sha: null,
        } satisfies GitHeadInfo
      case "get_system_terminal_settings":
        return { default_shell: null }
      case "acp_get_agent_status":
        return {
          agent_type: "claude_code",
          enabled: true,
          available: true,
          installed_version: "fixture",
          is_acp_adapter: true,
        } satisfies AcpAgentStatus
      case "acp_find_connection_for_conversation":
        return null
      case "acp_connect":
        return CONNECTION_ID
      case "acp_prompt":
        this.emitAcp({ type: "status_changed", status: "prompting" })
        return undefined
      case "acp_touch_connection":
        return true
      case "acp_respond_permission":
      case "acp_cancel":
      case "acp_disconnect":
      case "terminal_kill":
      case "stop_workspace_state_stream":
        return undefined
      case "start_workspace_state_stream":
      case "get_workspace_snapshot":
        return workspaceSnapshot(String(args.rootPath))
      case "git_is_tracked":
        return false
      case "read_file_for_edit": {
        const path = `${args.rootPath}/${args.path}`
        const file = this.files.get(path)
        if (!file) throw new Error(`Unknown fixture file: ${path}`)
        return { ...file }
      }
      case "save_file_content": {
        const path = `${args.rootPath}/${args.path}`
        const file = this.files.get(path)
        if (!file || args.expectedEtag !== file.etag) {
          throw new Error(`Wrong host or etag for ${path}`)
        }
        const saved = {
          ...file,
          content: String(args.content),
          etag: `${this.host}-etag-saved`,
          mtime_ms: 2,
        }
        this.files.set(path, saved)
        return saved
      }
      default:
        this.unexpectedCommands.push(command)
        throw new Error(`Unexpected ${this.host} command: ${command}`)
    }
  }
}

export function createProductionHost(host: "A" | "B") {
  const remoteConnectionId = host === "A" ? 101 : 202
  const transport = new FakeProductionTransport(host)
  const client = createBackendClient({
    key: `remote:${remoteConnectionId}`,
    name: host,
    remoteConnectionId,
    transport,
    shellTransport: transport,
    desktop: false,
    baseUrl: `https://${host.toLowerCase()}.invalid`,
    windowInstanceId: "production-provider-tests",
  })
  return { host, transport, client, stores: createBackendStores(client) }
}
