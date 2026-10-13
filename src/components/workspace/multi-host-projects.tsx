"use client"
import { useTranslations } from "next-intl"
import { ChevronDown, ChevronRight } from "lucide-react"
import type { BackendDescriptor } from "@/lib/backend/registry"
import type { BackendKey } from "@/lib/backend/types"
import { projectCatalog } from "@/lib/backend/project-catalog"
import {
  ProjectSetupRows,
  type CatalogRowActions,
} from "./project-session-list"
import type { HostFolderCatalog } from "./multi-host-sidebar"

export function MultiHostProjects({
  hosts,
  catalogs,
  collapsed,
  onToggle,
  ...actions
}: CatalogRowActions & {
  hosts: readonly BackendDescriptor[]
  catalogs: ReadonlyMap<BackendKey, HostFolderCatalog>
  collapsed: readonly string[]
  onToggle(key: string): void
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
          {!collapsed.includes(project.key) &&
            project.setups.map((setup) => {
              const host = hosts.find((h) => h.key === setup.backendKey)!
              const catalog = catalogs.get(setup.backendKey)
              return (
                <ProjectSetupRows
                  key={JSON.stringify([
                    setup.backendKey,
                    setup.generation,
                    setup.folder.id,
                    setup.folder.path,
                  ])}
                  setup={setup}
                  hostName={host.name}
                  conversations={catalog?.conversations}
                  historyLoading={catalog?.historyLoading}
                  historyError={catalog?.historyError}
                  {...actions}
                />
              )
            })}
        </section>
      ))}
    </div>
  )
}
