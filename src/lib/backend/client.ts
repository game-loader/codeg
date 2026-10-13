import { createAcademicApi } from "@/lib/academic"
import { createBackendStoreStorage } from "@/stores/backend-store-storage"
import { createBackendApi } from "@/lib/api"
import { createBackendPlatform } from "@/lib/platform"
import type { BackendApiBinding, BackendClient, BackendKey } from "./types"
import type { RemoteWorkspaceConnection } from "@/lib/types"

export interface CreateBackendClientOptions extends BackendApiBinding {
  readonly key: BackendKey
  readonly name: string
  readonly remoteConnection?: RemoteWorkspaceConnection | null
}

/** The registry owns transport lifetime. Creating a client never selects it. */
export function createBackendClient(
  options: CreateBackendClientOptions
): BackendClient {
  const remoteConnection = options.remoteConnection ?? null
  const remoteConnectionId =
    options.remoteConnectionId ?? remoteConnection?.id ?? null
  const expectedKey: BackendKey =
    remoteConnectionId === null ? "local" : `remote:${remoteConnectionId}`
  if (options.key !== expectedKey) {
    throw new Error("Backend key does not match its connection")
  }
  const binding: BackendApiBinding = Object.freeze({
    transport: options.transport,
    shellTransport: options.shellTransport,
    remoteConnectionId,
    baseUrl: options.baseUrl ?? remoteConnection?.base_url,
    token: options.token ?? remoteConnection?.token,
    desktop: options.desktop,
    windowInstanceId: options.windowInstanceId,
    configRevision: options.configRevision ?? remoteConnection?.config_revision,
    onUnauthorized: options.onUnauthorized,
    onConfigurationChanged: options.onConfigurationChanged,
    onRepositoryRemotesChanged: options.onRepositoryRemotesChanged,
  })
  const preferences = createBackendStoreStorage(options.key).selectorPreferences
  const academic = Object.freeze(
    createAcademicApi(binding.transport, preferences.getSavedPrefsForConnect)
  )
  // Both public entry points must use the same scoped preference reader.
  const api = Object.freeze({ ...createBackendApi(binding), ...academic })
  return Object.freeze({
    key: options.key,
    name: options.name,
    transport: options.transport,
    api,
    academic,
    platform: Object.freeze(createBackendPlatform(binding)),
    remoteConnection,
  })
}
