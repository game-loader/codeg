"use client"

import { useTranslations } from "next-intl"
import {
  ChevronDown,
  ChevronRight,
  Monitor,
  Plus,
  RefreshCw,
  Server,
  Settings2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { BackendDescriptor } from "@/lib/backend/registry"
import type { BackendKey } from "@/lib/backend/types"
import type {
  DbConversationSummary,
  FolderDetail,
  RepositoryProjectIdentityEntry,
} from "@/lib/types"
import {
  ProjectSetupRows,
  type CatalogRowActions,
} from "./project-session-list"
import { MultiHostProjects } from "./multi-host-projects"
import {
  readCatalogPreferences,
  saveCatalogPreferences,
  type CatalogPreferences,
} from "@/lib/backend/window-layout"
import { useEffect, useState } from "react"

export interface HostFolderCatalog {
  folders: readonly FolderDetail[]
  loading: boolean
  generation?: number
  identities?: ReadonlyMap<number, RepositoryProjectIdentityEntry>
  identityLoading?: boolean
  identityUnavailable?: boolean
  identityUnsupported?: boolean
  conversations?: readonly DbConversationSummary[]
  historyLoading?: boolean
  historyError?: string | null
}

export interface MultiHostSidebarProps extends CatalogRowActions {
  hosts: readonly BackendDescriptor[]
  catalogs: ReadonlyMap<BackendKey, HostFolderCatalog>
  focusedHost: BackendKey
  collapsed: readonly BackendKey[]
  onToggleHost(key: BackendKey): void
  onSelectHost(key: BackendKey): void
  onAddRepository(key: BackendKey, generation: number): void
  onRefresh(key: BackendKey, generation: number): void
  onManageConnections(): void
}

/** Numeric folder IDs only have meaning inside their containing machine. */
export function MultiHostSidebar({
  hosts,
  catalogs,
  focusedHost,
  collapsed,
  onToggleHost,
  onSelectHost,
  onOpenFolder,
  onAddRepository,
  onWorktrees,
  onNewSession,
  onOpenConversation,
  onRetry,
  onRefresh,
  onManageConnections,
}: MultiHostSidebarProps) {
  const t = useTranslations("MultiHost")
  const [preferences, setPreferences] = useState<CatalogPreferences>({
    mode: "projects",
    collapsedProjects: [],
  })
  const [preferencesLoaded, setPreferencesLoaded] = useState(false)
  useEffect(() => {
    // Match static-export markup before hydrating optional device preferences.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreferences(readCatalogPreferences())
    setPreferencesLoaded(true)
  }, [])
  useEffect(() => {
    if (preferencesLoaded) saveCatalogPreferences(preferences)
  }, [preferences, preferencesLoaded])
  const actions = {
    onOpenFolder,
    onWorktrees,
    onNewSession,
    onOpenConversation,
    onRetry,
  }
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex h-10 shrink-0 items-center justify-between border-b px-3">
        <div className="flex gap-1" role="group" aria-label={t("catalogView")}>
          {(["projects", "machines"] as const).map((mode) => (
            <Button
              key={mode}
              variant={preferences.mode === mode ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2 text-xs"
              aria-pressed={preferences.mode === mode}
              onClick={() => setPreferences((value) => ({ ...value, mode }))}
            >
              {t(mode)}
            </Button>
          ))}
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={t("manageConnections")}
          onClick={onManageConnections}
        >
          <Settings2 className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {preferences.mode === "projects" && (
          <MultiHostProjects
            hosts={hosts}
            catalogs={catalogs}
            collapsed={preferences.collapsedProjects}
            onToggle={(key) =>
              setPreferences((value) => ({
                ...value,
                collapsedProjects: value.collapsedProjects.includes(key)
                  ? value.collapsedProjects.filter((k) => k !== key)
                  : [...value.collapsedProjects, key],
              }))
            }
            {...actions}
          />
        )}
        {hosts.map((host) => {
          const catalog = catalogs.get(host.key)
          const folders = catalog?.folders ?? []
          const roots = folders.filter(
            (folder) =>
              folder.kind !== "chat" &&
              (!folder.parent_id ||
                !folders.some((parent) => parent.id === folder.parent_id))
          )
          const isCollapsed = collapsed.includes(host.key)
          return (
            <section
              key={host.key}
              className="mb-2"
              data-backend-key={host.key}
            >
              <div
                className={cn(
                  "flex items-center rounded-md px-1",
                  host.key === focusedHost && "bg-sidebar-accent"
                )}
              >
                <button
                  type="button"
                  className="p-1"
                  aria-expanded={!isCollapsed}
                  aria-label={host.name}
                  onClick={() => onToggleHost(host.key)}
                >
                  {isCollapsed ? (
                    <ChevronRight className="size-3.5" />
                  ) : (
                    <ChevronDown className="size-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-2 text-left"
                  onClick={() => onSelectHost(host.key)}
                >
                  {host.key === "local" ? (
                    <Monitor className="size-4 shrink-0" />
                  ) : (
                    <Server className="size-4 shrink-0" />
                  )}
                  <span className="truncate text-sm font-medium">
                    {host.name}
                  </span>
                </button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  aria-label={t("addRepository")}
                  onClick={() => onAddRepository(host.key, host.generation)}
                >
                  <Plus className="size-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  aria-label={t("refresh")}
                  onClick={() => onRefresh(host.key, host.generation)}
                >
                  <RefreshCw
                    className={cn(
                      "size-3.5",
                      (catalog?.loading || catalog?.identityLoading) &&
                        "animate-spin"
                    )}
                  />
                </Button>
              </div>
              <p
                className={cn(
                  "mb-1 ml-7 text-xs",
                  host.status === "unauthorized" || host.status === "offline"
                    ? "text-destructive"
                    : "text-muted-foreground"
                )}
                title={host.error ?? host.baseUrl ?? undefined}
              >
                {t(host.status)}
              </p>
              {catalog?.identityUnsupported && (
                <p className="ml-7 text-xs text-muted-foreground">
                  {t("identityUpgrade")}
                </p>
              )}
              {catalog?.identityUnavailable && !catalog.identityUnsupported && (
                <p className="ml-7 text-xs text-muted-foreground">
                  {t("identityUnavailable")}
                </p>
              )}
              {preferences.mode === "machines" && !isCollapsed && (
                <div className="ml-3 border-l pl-2">
                  {catalog?.loading && roots.length === 0 && (
                    <p className="p-2 text-xs text-muted-foreground">
                      {t("loading")}
                    </p>
                  )}
                  {!catalog?.loading && roots.length === 0 && (
                    <p className="p-2 text-xs text-muted-foreground">
                      {t("empty")}
                    </p>
                  )}
                  {roots.map((folder) => (
                    <ProjectSetupRows
                      key={`${host.generation}:${folder.id}:${folder.path}`}
                      setup={{
                        backendKey: host.key,
                        generation: host.generation,
                        folder,
                        children: folders.filter(
                          (child) =>
                            child.parent_id === folder.id &&
                            child.kind !== "chat"
                        ),
                      }}
                      hostName={host.name}
                      conversations={catalog?.conversations}
                      historyLoading={catalog?.historyLoading}
                      historyError={catalog?.historyError}
                      {...actions}
                    />
                  ))}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </aside>
  )
}
