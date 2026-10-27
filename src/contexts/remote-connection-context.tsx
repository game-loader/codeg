"use client"

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { Loader2, Monitor } from "lucide-react"
import { useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  clearRemoteDesktopTransport,
  configureRemoteDesktopTransport,
  getTransport,
  invalidateRemoteDesktopTransport,
} from "@/lib/transport"
import {
  isRemoteConfigurationChanged,
  REMOTE_CONFIGURATION_CHANGED_MESSAGE,
} from "@/lib/transport/remote-errors"
import type { RemoteDesktopTransport } from "@/lib/transport/remote-desktop-transport"
import { RemoteConnectionStatus } from "@/components/connection/remote-connection-status"
import { resetBackendScopedStores } from "@/stores/backend-scoped-store-reset"
import {
  getRemoteWorkspaceConnection,
  openLocalWorkspace,
} from "@/lib/remote-workspace"
import { toErrorMessage } from "@/lib/app-error"
import { isDesktop } from "@/lib/platform"
import type { RemoteWorkspaceConnection } from "@/lib/types"

interface RemoteConnectionContextValue {
  connection: RemoteWorkspaceConnection | null
  expired: boolean
  markExpired: () => void
}

interface RemoteConnectionState {
  connection: RemoteWorkspaceConnection | null
  loadedId: number | null
  loadedWindowId: string | null
  error: string | null
  expired: boolean
}

const RemoteConnectionContext =
  createContext<RemoteConnectionContextValue | null>(null)

function createFallbackRemoteWindowId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `rw-${globalThis.crypto.randomUUID()}`
  }
  return `rw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function useRemoteConnection() {
  return useContext(RemoteConnectionContext)
}

/** Fixed runtime context; it never configures the realm's legacy transport. */
export function ScopedRemoteConnectionProvider({
  connection,
  expired = false,
  children,
}: {
  connection: RemoteWorkspaceConnection | null
  expired?: boolean
  children: ReactNode
}) {
  const [markedExpired, setMarkedExpired] = useState(false)
  const value = useMemo(
    () => ({
      connection,
      expired: expired || markedExpired,
      markExpired: () => setMarkedExpired(true),
    }),
    [connection, expired, markedExpired]
  )
  return (
    <RemoteConnectionContext.Provider value={value}>
      {children}
    </RemoteConnectionContext.Provider>
  )
}

/**
 * Best-effort reset of the backend-scoped module stores when the realm's backend
 * identity changes. A PASSIVE post-render effect (fires after commit, not a
 * render gate) that skips the initial mount, so today — where the identity is
 * immutable per realm (see the gate) — it never fires. Clears store STATE only;
 * it does NOT cancel in-flight backend fetches. Exported for tests; used only by
 * `RemoteConnectionGate`.
 */
export function useResetBackendScopedStoresOnIdentityChange(
  backendKey: string
): void {
  const prevKeyRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevKeyRef.current
    prevKeyRef.current = backendKey
    if (prev !== null && prev !== backendKey) {
      resetBackendScopedStores()
    }
  }, [backendKey])
}

/**
 * A remote window the gate cannot let through: the connection could not be
 * loaded, or its credentials expired. Nothing of the workspace is rendered —
 * no status bar, so no Quick actions — and Windows has no application menu,
 * so this screen carries the way back to the local workspace itself. The
 * expired notice also asks for the token to be updated, which is done from
 * another window.
 *
 * Desktop only: a web client has no local workspace window to bring up.
 */
function RemoteConnectionDeadEnd({ message }: { message: string }) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background p-6 text-center text-sm">
      <p className="text-destructive">{message}</p>
      {isDesktop() && <OpenLocalWorkspaceButton />}
    </div>
  )
}

function OpenLocalWorkspaceButton() {
  const t = useTranslations("RemoteWorkspace")
  // Said here rather than in a toast: the window's toaster belongs to the
  // workspace this screen replaces.
  const [failure, setFailure] = useState<string | null>(null)

  const handleClick = () => {
    setFailure(null)
    openLocalWorkspace().catch((err) => setFailure(toErrorMessage(err)))
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={handleClick}>
        <Monitor />
        {t("openLocalWorkspace")}
      </Button>
      {failure !== null && (
        <div role="alert" className="text-xs">
          <p className="text-destructive">{t("openLocalFailed")}</p>
          <p className="text-muted-foreground">{failure}</p>
        </div>
      )}
    </>
  )
}

export function RemoteConnectionGate({ children }: { children: ReactNode }) {
  const t = useTranslations("RemoteWorkspace")
  const searchParams = useSearchParams()
  const rawId = searchParams.get("remoteConnectionId")
  const remoteConnectionId = rawId !== null ? Number(rawId) : null
  const fallbackRemoteWindowId = useMemo(
    () => createFallbackRemoteWindowId(),
    []
  )
  const remoteWindowId =
    searchParams.get("remoteWindowId") || fallbackRemoteWindowId
  const expectedRevision = searchParams.get("remoteConfigRevision")
  const [initialIdentity] = useState(() => ({
    rawId,
    remoteWindowId,
    expectedRevision,
  }))
  const boundRevision = useRef<string | null>(null)
  const retired = useRef(false)
  const identityChanged =
    initialIdentity.rawId !== rawId ||
    initialIdentity.remoteWindowId !== remoteWindowId ||
    initialIdentity.expectedRevision !== expectedRevision
  const [invalidIdentity, setInvalidIdentity] = useState(false)
  if (identityChanged && !invalidIdentity) setInvalidIdentity(true)
  const [state, setState] = useState<RemoteConnectionState>({
    connection: null,
    loadedId: null,
    loadedWindowId: null,
    error: null,
    expired: false,
  })

  useEffect(() => {
    if (invalidIdentity || retired.current) {
      retired.current = true
      invalidateRemoteDesktopTransport()
      return
    }
    if (rawId === null) {
      clearRemoteDesktopTransport()
      return
    }

    let cancelled = false
    let unsubscribe: (() => void) | undefined
    // Block compatibility calls while loading or after an error; never make a
    // remote operation window fall back to the local shell API.
    invalidateRemoteDesktopTransport()
    const retire = () => {
      if (cancelled) return
      retired.current = true
      invalidateRemoteDesktopTransport()
      setState((prev) => ({
        ...prev,
        error: REMOTE_CONFIGURATION_CHANGED_MESSAGE,
      }))
    }

    const load = async () => {
      if (
        remoteConnectionId === null ||
        !Number.isInteger(remoteConnectionId) ||
        remoteConnectionId <= 0
      ) {
        throw new Error("Invalid remote connection ID")
      }
      const next = await getRemoteWorkspaceConnection(remoteConnectionId)
      if (cancelled) return
      const revision = expectedRevision ?? boundRevision.current
      if (
        next.id !== remoteConnectionId ||
        !next.config_revision ||
        (revision !== null && revision !== next.config_revision)
      ) {
        throw new Error(REMOTE_CONFIGURATION_CHANGED_MESSAGE)
      }
      // Older popup URLs have no revision. Bind their first lookup once, then
      // use the same fencing as upgraded launchers for every subsequent call.
      boundRevision.current = next.config_revision
      return next
    }

    load()
      .then((next) => {
        if (cancelled || !next) return
        configureRemoteDesktopTransport({
          id: next.id,
          name: next.name,
          baseUrl: next.base_url,
          token: next.token,
          windowInstanceId: remoteWindowId,
          configRevision: next.config_revision,
          // Network outages leave the workspace mounted while the proxy retries.
          onUnauthorized: () => {
            if (!cancelled) {
              setState((prev) => ({ ...prev, expired: true }))
            }
          },
          onConfigurationChanged: retire,
        })
        setState({
          connection: next,
          loadedId: remoteConnectionId,
          loadedWindowId: remoteWindowId,
          error: null,
          expired: false,
        })
        // Observe invalidation even when this form has no event consumers yet.
        void getTransport()
          .subscribe("__configuration_changed__", () => {})
          .then((unlisten) => {
            if (cancelled) unlisten()
            else unsubscribe = unlisten
          })
          .catch((err) => {
            if (cancelled) return
            if (isRemoteConfigurationChanged(err)) {
              retire()
              return
            }
            // The transport exposes a stopped IPC subscription through its
            // status pill and can retry it in place, preserving dirty forms.
            console.warn(
              "[RemoteConnectionGate] event subscription failed:",
              err
            )
          })
      })
      .catch((err) => {
        if (cancelled) return
        retired.current = true
        invalidateRemoteDesktopTransport()
        setState({
          connection: null,
          loadedId: remoteConnectionId,
          loadedWindowId: remoteWindowId,
          error: toErrorMessage(err),
          expired: false,
        })
      })

    return () => {
      cancelled = true
      unsubscribe?.()
      invalidateRemoteDesktopTransport()
    }
  }, [
    rawId,
    remoteConnectionId,
    remoteWindowId,
    expectedRevision,
    invalidIdentity,
  ])

  // This gate owns the legacy single-backend Web/URL-remote workspace only.
  // Its URL identity remains fixed for that realm's lifetime. The main desktop
  // multi-host shell bypasses this gate and supplies fixed scoped providers,
  // clients and stores instead of reconfiguring this compatibility transport.
  // The reset below remains a best-effort tripwire for unsupported identity
  // changes in legacy windows; it does not fence in-flight requests or implement
  // live backend switching.
  const backendKey = `${remoteConnectionId ?? "local"}::${remoteWindowId}`
  useResetBackendScopedStoresOnIdentityChange(backendKey)

  const value = useMemo(
    () => ({
      connection: state.connection,
      expired: state.expired,
      markExpired: () => setState((prev) => ({ ...prev, expired: true })),
    }),
    [state.connection, state.expired]
  )

  const hasRemoteConnection = rawId !== null
  const loadedCurrentRemoteWindow =
    Object.is(state.loadedId, remoteConnectionId) &&
    state.loadedWindowId === remoteWindowId
  const loading = hasRemoteConnection && !loadedCurrentRemoteWindow
  const error = invalidIdentity
    ? REMOTE_CONFIGURATION_CHANGED_MESSAGE
    : hasRemoteConnection && loadedCurrentRemoteWindow
      ? state.error
      : null
  const expired =
    hasRemoteConnection && loadedCurrentRemoteWindow ? state.expired : false
  const connection =
    hasRemoteConnection && loadedCurrentRemoteWindow ? state.connection : null

  if (loading && !error) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {t("loadingConnection")}
      </div>
    )
  }

  if (error) {
    return (
      <RemoteConnectionDeadEnd
        message={t("connectionLoadFailed", { message: error })}
      />
    )
  }

  if (expired) {
    return (
      <RemoteConnectionDeadEnd
        message={t("connectionExpired", { name: connection?.name ?? "" })}
      />
    )
  }

  return (
    <RemoteConnectionContext.Provider value={value}>
      {children}
      {hasRemoteConnection && (
        <RemoteConnectionStatus
          transport={getTransport() as RemoteDesktopTransport}
        />
      )}
    </RemoteConnectionContext.Provider>
  )
}
