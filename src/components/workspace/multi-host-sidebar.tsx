"use client"

import { useTranslations } from "next-intl"
import {
  ChevronDown,
  ChevronRight,
  FolderGit2,
  GitBranch,
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
import type { FolderDetail } from "@/lib/types"

export interface HostFolderCatalog {
  folders: readonly FolderDetail[]
  loading: boolean
}

interface MultiHostSidebarProps {
  hosts: readonly BackendDescriptor[]
  catalogs: ReadonlyMap<BackendKey, HostFolderCatalog>
  focusedHost: BackendKey
  collapsed: readonly BackendKey[]
  onToggleHost(key: BackendKey): void
  onSelectHost(key: BackendKey): void
  onOpenFolder(key: BackendKey, folder: FolderDetail): void
  onAddRepository(key: BackendKey): void
  onWorktrees(key: BackendKey, folder: FolderDetail): void
  onRefresh(key: BackendKey): void
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
  onRefresh,
  onManageConnections,
}: MultiHostSidebarProps) {
  const t = useTranslations("MultiHost")
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex h-10 shrink-0 items-center justify-between border-b px-3">
        <span className="text-sm font-medium">{t("machines")}</span>
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
                  onClick={() => onAddRepository(host.key)}
                >
                  <Plus className="size-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  aria-label={t("refresh")}
                  onClick={() => onRefresh(host.key)}
                >
                  <RefreshCw
                    className={cn(
                      "size-3.5",
                      catalog?.loading && "animate-spin"
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
              {!isCollapsed && (
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
                    <div key={folder.id} className="mb-1">
                      <div className="group flex items-center rounded-md hover:bg-sidebar-accent">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-1.5 text-left text-sm"
                          title={folder.path}
                          onClick={() => onOpenFolder(host.key, folder)}
                        >
                          <FolderGit2 className="size-3.5 shrink-0" />
                          <span className="truncate">
                            {folder.alias ?? folder.name}
                          </span>
                        </button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-6"
                          aria-label={`${t("manageWorktrees")} · ${folder.name}`}
                          onClick={() => onWorktrees(host.key, folder)}
                        >
                          <GitBranch className="size-3.5" />
                        </Button>
                      </div>
                      {folders
                        .filter(
                          (child) =>
                            child.parent_id === folder.id &&
                            child.kind !== "chat"
                        )
                        .map((child) => (
                          <button
                            key={child.id}
                            type="button"
                            className="ml-3 flex w-[calc(100%-0.75rem)] items-center gap-1.5 rounded-md px-1 py-1.5 text-left text-xs hover:bg-sidebar-accent"
                            title={child.path}
                            onClick={() => onOpenFolder(host.key, child)}
                          >
                            <GitBranch className="size-3 shrink-0" />
                            <span className="truncate">
                              {child.git_branch ?? child.alias ?? child.name}
                            </span>
                          </button>
                        ))}
                    </div>
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
