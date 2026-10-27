"use client"
import { useTranslations } from "next-intl"
import { ChevronDown, ChevronRight } from "lucide-react"
import type { BackendDescriptor } from "@/lib/backend/registry"
import type { BackendKey } from "@/lib/backend/types"
import { projectCatalog } from "@/lib/backend/project-catalog"
import type { CatalogRowActions } from "./project-session-list"
import { ProjectLocationMenu } from "./project-location-menu"
import {
  projectHistory,
  DEFAULT_HISTORY_OPTIONS,
  type HistoryOptions,
} from "@/lib/backend/project-history"
import type { HostFolderCatalog } from "./multi-host-sidebar"

export function MultiHostProjects({
  hosts,
  catalogs,
  collapsed,
  onToggle,
  options = DEFAULT_HISTORY_OPTIONS,
  ...actions
}: CatalogRowActions & {
  hosts: readonly BackendDescriptor[]
  catalogs: ReadonlyMap<BackendKey, HostFolderCatalog>
  collapsed: readonly string[]
  onToggle(key: string): void
  options?: HistoryOptions
}) {
  const t = useTranslations("MultiHost")
  const projects = projectCatalog(hosts, catalogs)
  return (
    <div className="mb-3">
      {projects.length === 0 && (
        <p className="p-2 text-xs text-muted-foreground">
          {t(
            [...catalogs.values()].some((c) => c.loading) ? "loading" : "empty"
          )}
        </p>
      )}
      {projects.map((project) => (
        <section
          key={project.key}
          className="mb-2"
          data-project-key={project.key}
        >
          <button
            type="button"
            className="flex w-full items-center gap-1 rounded-md py-2 text-left text-sm font-medium hover:bg-sidebar-accent"
            aria-expanded={!collapsed.includes(project.key)}
            onClick={() => onToggle(project.key)}
          >
            {collapsed.includes(project.key) ? (
              <ChevronRight className="size-3.5" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
            <span className="truncate">{project.name}</span>
          </button>
          {!collapsed.includes(project.key) && (
            <>
              <ProjectLocationMenu
                setups={project.setups}
                hosts={hosts}
                {...actions}
              />
              {projectHistory(project.setups, catalogs, options).map(
                (session) => (
                  <div
                    key={session.key}
                    data-session-owner={session.backendKey}
                  >
                    {actions.renderSession?.(session) ?? (
                      <button
                        type="button"
                        className="w-full text-left text-xs py-1"
                        onClick={() =>
                          actions.onOpenConversation?.(
                            session.backendKey,
                            session.folder,
                            session.conversation,
                            session.generation
                          )
                        }
                      >
                        {session.conversation.title || t("untitledSession")}
                        <span className="block text-muted-foreground">
                          {
                            hosts.find((h) => h.key === session.backendKey)
                              ?.name
                          }{" "}
                          · {session.folder?.path}
                        </span>
                      </button>
                    )}
                  </div>
                )
              )}
              {project.setups.map((setup) => {
                const catalog = catalogs.get(setup.backendKey)
                return (
                  <div
                    key={`${setup.backendKey}:${setup.folder.id}`}
                    data-history-owner={setup.backendKey}
                  >
                    {catalog?.historyLoading && (
                      <p
                        role="status"
                        className="text-xs text-muted-foreground"
                      >
                        {hosts.find((h) => h.key === setup.backendKey)?.name} ·{" "}
                        {t("historyLoading")}
                      </p>
                    )}
                    {catalog?.historyError && (
                      <div role="alert">
                        <button
                          type="button"
                          className="text-xs text-destructive"
                          onClick={() =>
                            actions.onRetry?.(
                              setup.backendKey,
                              setup.generation
                            )
                          }
                        >
                          {catalog.historyError} · {t("retry")}
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </>
          )}
        </section>
      ))}
    </div>
  )
}
