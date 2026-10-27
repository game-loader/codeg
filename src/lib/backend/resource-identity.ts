import type { BackendClient, BackendKey } from "./types"

/** Panel lookups use document-wide IDs even when their React trees are scoped. */
export function scopePanelId(id: string, backendKey?: BackendKey): string {
  return backendKey ? `backend-${encodeURIComponent(backendKey)}:${id}` : id
}

const eventScopes = new WeakMap<BackendClient, string>()

/** Transient handoffs must not survive a connection's generation replacement. */
export function getBackendEventScope(
  client: BackendClient | null
): string | undefined {
  if (!client) return undefined
  let scope = eventScopes.get(client)
  if (!scope) {
    scope = `${client.key}:${globalThis.crypto.randomUUID()}`
    eventScopes.set(client, scope)
  }
  return scope
}
