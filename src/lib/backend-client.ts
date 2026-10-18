import { getShellTransport, isDesktop } from "@/lib/transport"
import type { CallOptions, CallTarget } from "@/lib/transport/types"
import type { BackendKey } from "@/lib/project-identity"
import { getRemoteWorkspaceConnection } from "@/lib/remote-workspace"
import { isNotFoundError } from "@/lib/app-error"

/**
 * A request client pinned to one backend. Unlike `getTransport()`, which
 * follows whatever backend the current window is bound to, a `BackendClient`
 * always talks to the machine named by `key` — so a request issued for
 * machine A still reaches A after the user switches to machine B.
 *
 * Read-oriented for now: no event subscriptions. Remote calls go through the
 * desktop proxy (`remote_http_call`), which routes by connection id and
 * works from any window.
 */
export interface BackendClient extends CallTarget {
  readonly key: BackendKey
}

export function remoteBackendKey(connectionId: number): BackendKey {
  return `remote:${connectionId}`
}

export function parseBackendKey(
  value: string
): { kind: "local" } | { kind: "remote"; connectionId: number } | null {
  if (value === "local") return { kind: "local" }
  const match = /^remote:(\d+)$/.exec(value)
  if (!match) return null
  const connectionId = Number(match[1])
  return Number.isSafeInteger(connectionId) && connectionId > 0
    ? { kind: "remote", connectionId }
    : null
}

/** The proxy builds `{base_url}/api/{command}` after trimming slashes. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "")
}

/**
 * The saved connection a pinned client was bound to now points somewhere
 * else, or is gone. Its folder and link ids belong to the old server, so the
 * request is refused instead of being sent to the new one.
 */
export class BackendBindingChangedError extends Error {
  readonly code = "backend_binding_changed"

  constructor(readonly key: BackendKey) {
    super(`The connection behind ${key} changed; pick the machine again`)
  }
}

export function isBackendBindingChangedError(
  err: unknown
): err is BackendBindingChangedError {
  return err instanceof BackendBindingChangedError
}

const clients = new Map<BackendKey, BackendClient>()

export function getBackendClient(key: BackendKey): BackendClient {
  const cached = clients.get(key)
  if (cached) return cached
  const parsed = parseBackendKey(key)
  if (!parsed) throw new Error(`Invalid backend key: ${key}`)

  let client: BackendClient
  if (parsed.kind === "local") {
    // The shell transport is this window's own backend: Tauri IPC on the
    // desktop, the serving codeg-server on the web.
    client = {
      key,
      call<T>(
        command: string,
        args?: Record<string, unknown>,
        options?: CallOptions
      ) {
        return getShellTransport().call<T>(command, args, options)
      },
    }
  } else {
    // Only the desktop app holds saved remote connections; a web page talks
    // to the one server that serves it.
    if (!isDesktop()) {
      throw new Error("Remote backends are only reachable from the desktop")
    }
    const { connectionId } = parsed
    client = {
      key,
      call<T>(
        command: string,
        args?: Record<string, unknown>,
        options?: CallOptions
      ) {
        return getShellTransport().call<T>("remote_http_call", {
          connectionId,
          command,
          args: args ?? {},
          timeoutMs: options?.timeoutMs,
        })
      },
    }
  }
  clients.set(key, client)
  return client
}

/**
 * A client for a multi-step flow on one remote machine: it remembers the
 * service address the connection had when the flow picked it, and refuses
 * every later request once the saved connection points elsewhere or is
 * deleted. Without that, ids read from the old server would be sent to the
 * new one.
 *
 * The check re-reads the connection before each request, so a narrow gap
 * remains between check and send; closing it needs the desktop proxy to
 * compare the binding itself.
 */
export function pinBackendClient(
  key: BackendKey,
  baseUrl: string
): BackendClient {
  const base = getBackendClient(key)
  const parsed = parseBackendKey(key)
  if (parsed?.kind !== "remote") return base
  const { connectionId } = parsed
  const expected = normalizeBaseUrl(baseUrl)

  const assertBinding = async () => {
    let current: string
    try {
      current = (await getRemoteWorkspaceConnection(connectionId)).base_url
    } catch (err) {
      if (isNotFoundError(err)) {
        throw new BackendBindingChangedError(key)
      }
      throw err
    }
    if (normalizeBaseUrl(current) !== expected) {
      throw new BackendBindingChangedError(key)
    }
  }

  return {
    key,
    async call<T>(
      command: string,
      args?: Record<string, unknown>,
      options?: CallOptions
    ) {
      await assertBinding()
      return base.call<T>(command, args, options)
    },
  }
}

/** Test-only: drop cached clients so mocks take effect. @internal */
export function __resetBackendClientsForTests(): void {
  if (process.env.NODE_ENV !== "test") return
  clients.clear()
}
