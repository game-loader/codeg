import type { BackendApi } from "@/lib/api"
import type { AcademicApi } from "@/lib/academic"
import type { BackendPlatform } from "@/lib/platform"
import type { Transport } from "@/lib/transport"
import type { UnauthorizedSource } from "@/lib/transport/web-auth"
import type { RemoteWorkspaceConnection } from "@/lib/types"

export type BackendKey = "local" | `remote:${number}`

/** Values belong to one backend generation; never derive them from selection. */
export interface BackendApiBinding {
  readonly transport: Transport
  readonly shellTransport?: Transport
  readonly remoteConnectionId?: number | null
  readonly baseUrl?: string
  readonly token?: string
  readonly desktop?: boolean
  readonly windowInstanceId?: string
  readonly configRevision?: string
  readonly onUnauthorized?: (source?: UnauthorizedSource) => void
  readonly onConfigurationChanged?: () => void
  readonly onRepositoryRemotesChanged?: (path: string) => void
}

export interface BackendClient {
  readonly key: BackendKey
  readonly name: string
  readonly transport: Transport
  readonly api: BackendApi
  readonly academic: AcademicApi
  readonly platform: BackendPlatform
  readonly remoteConnection: RemoteWorkspaceConnection | null
}

export type { BackendApi, BackendPlatform, AcademicApi }
