"use client"

import { useTranslations } from "next-intl"
import {
  ChevronDown,
  ChevronRight,
  Folder,
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
import type { ReactNode } from "react"
import { UnifiedHistoryControls } from "./unified-sidebar-controls"
import {
  DEFAULT_HISTORY_OPTIONS,
  ownedSession,
  projectHistory,
  sortOwnedSessions,
  type HistoryOptions,
} from "@/lib/backend/project-history"
import { projectCatalog } from "@/lib/backend/project-catalog"
import {
  loadNavItemVisibility,
  loadShowCompleted,
  loadShowRecent,
  loadShowWorktrees,
  loadSortMode,
  saveNavItemVisibility,
  saveShowCompleted,
  saveShowRecent,
  saveShowWorktrees,
  saveSortMode,
  type SidebarNavItemVisibility,
  type SidebarSectionOrder,
  DEFAULT_SECTION_ORDER,
  loadSectionOrder,
  moveSectionInOrder,
  saveSectionOrder,
} from "@/lib/sidebar-view-mode-storage"

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
  activeFolderId?: number | null
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
  renderNavigation?(items: SidebarNavItemVisibility): ReactNode
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
  renderNavigation,
  renderSession,
  onLocationTool,
}: MultiHostSidebarProps) {
  const t = useTranslations("MultiHost")
  const [preferences, setPreferences] = useState<CatalogPreferences>({
    mode: "projects",
    collapsedProjects: [],
  })
  const [preferencesLoaded, setPreferencesLoaded] = useState(false)
  const [options, setOptions] = useState<HistoryOptions>(
    DEFAULT_HISTORY_OPTIONS
  )
  const [navItems, setNavItems] = useState<SidebarNavItemVisibility>({})
  const [showRecent, setShowRecent] = useState(true)
  const [collapsedSections, setCollapsedSections] = useState<string[]>([])
  const [collapsedChatHosts, setCollapsedChatHosts] = useState<string[]>([])
  const [sectionOrder, setSectionOrder] = useState<SidebarSectionOrder>(
    DEFAULT_SECTION_ORDER
  )
  useEffect(() => {
    const hasPreference = (key: string) => {
      try {
        return localStorage.getItem(key) !== null
      } catch {
        return false
      }
    }
    // Match static-export markup before hydrating optional device preferences.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreferences(readCatalogPreferences())
    setOptions({
      showCompleted: !hasPreference("workspace:sidebar-show-completed")
        ? true
        : loadShowCompleted(),
      showWorktrees: loadShowWorktrees(),
      sortMode: !hasPreference("workspace:sidebar-sort-mode")
        ? "updated"
        : loadSortMode(),
    })
    setNavItems(loadNavItemVisibility())
    setShowRecent(loadShowRecent())
    setSectionOrder(loadSectionOrder())
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
    renderSession,
    onLocationTool,
  }
  const chats = sortOwnedSessions(
    hosts.flatMap((host) => {
      const catalog = catalogs.get(host.key)
      if (
        catalog?.generation !== undefined &&
        catalog.generation !== host.generation
      )
        return []
      return (catalog?.conversations ?? [])
        .filter((c) => c.kind === "chat" && c.parent_id == null)
        .map((c) => ownedSession(host.key, host.generation, null, null, c))
    }),
    options
  )
  const recent = sortOwnedSessions(
    [
      ...projectCatalog(hosts, catalogs).flatMap((project) =>
        projectHistory(project.setups, catalogs, options)
      ),
      ...chats,
    ],
    options
  ).slice(0, 10)
  const renderHistory = (sessions: typeof chats, showLocation = true) =>
    sessions.map((session) => (
      <div key={session.key}>
        {renderSession?.(session, { showLocation }) ?? (
          <button
            type="button"
            className="w-full text-left text-xs py-1"
            onClick={() =>
              onOpenConversation?.(
                session.backendKey,
                session.folder,
                session.conversation,
                session.generation
              )
            }
          >
            {session.conversation.title || t("untitledSession")}
            {showLocation && (
              <span className="block text-muted-foreground">
                {hosts.find((h) => h.key === session.backendKey)?.name}
              </span>
            )}
          </button>
        )}
      </div>
    ))
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
      {renderNavigation?.(navItems)}
      <UnifiedHistoryControls
        options={options}
        onOptions={(value) => {
          setOptions(value)
          saveShowCompleted(value.showCompleted)
          saveShowWorktrees(value.showWorktrees)
          saveSortMode(value.sortMode)
        }}
        navItems={navItems}
        onNavItems={(value) => {
          setNavItems(value)
          saveNavItemVisibility(value)
        }}
        showRecent={showRecent}
        onShowRecent={(value) => {
          setShowRecent(value)
          saveShowRecent(value)
        }}
        onCollapse={() => {
          const projects = projectCatalog(hosts, catalogs)
          const collapse =
            preferences.collapsedProjects.length < projects.length ||
            collapsedSections.length < 2
          setPreferences((value) => ({
            ...value,
            collapsedProjects: collapse ? projects.map((p) => p.key) : [],
          }))
          setCollapsedSections(collapse ? ["chats", "recent"] : [])
          if (preferences.mode === "machines")
            for (const host of hosts)
              if (collapsed.includes(host.key) !== collapse)
                onToggleHost(host.key)
        }}
        sectionOrder={sectionOrder}
        onMoveSection={(id, delta) => {
          const next = moveSectionInOrder(sectionOrder, id, delta)
          setSectionOrder(next)
          saveSectionOrder(next)
        }}
        allCollapsed={
          collapsedSections.length === 2 &&
          (preferences.mode === "machines"
            ? hosts.every((h) => collapsed.includes(h.key))
            : projectCatalog(hosts, catalogs).every((p) =>
                preferences.collapsedProjects.includes(p.key)
              ))
        }
        onLocate={() => {
          setPreferences((value) => ({
            ...value,
            mode: "projects",
            collapsedProjects: [],
          }))
          setCollapsedSections([])
          setCollapsedChatHosts([])
          requestAnimationFrame(() =>
            document
              .querySelector(
                `aside [data-session-owner="${focusedHost}"][data-session-selected="true"]`
              )
              ?.scrollIntoView?.({ block: "nearest" })
          )
        }}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-2 flex flex-col">
        <div style={{ order: sectionOrder.indexOf("folders") }}>
          {preferences.mode === "projects" && (
            <MultiHostProjects
              hosts={hosts}
              catalogs={catalogs}
              options={options}
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
        </div>
        {chats.length > 0 && (
          <section
            style={{ order: sectionOrder.indexOf("chats") }}
            data-history-section="chats"
          >
            <button
              type="button"
              className="py-2 text-sm font-medium"
              aria-expanded={!collapsedSections.includes("chats")}
              onClick={() =>
                setCollapsedSections((value) =>
                  value.includes("chats")
                    ? value.filter((v) => v !== "chats")
                    : [...value, "chats"]
                )
              }
            >
              {t("folderlessChats")}
            </button>
            {!collapsedSections.includes("chats") &&
              hosts.map((host) => {
                const sessions = chats.filter(
                  (session) => session.backendKey === host.key
                )
                if (sessions.length === 0) return null
                const groupKey = JSON.stringify([host.key, host.generation])
                const expanded = !collapsedChatHosts.includes(groupKey)
                return (
                  <div
                    key={groupKey}
                    data-chat-backend-key={host.key}
                    data-runtime-generation={host.generation}
                  >
                    <button
                      type="button"
                      className="flex w-full items-center gap-1.5 rounded-md py-1.5 text-left text-sm hover:bg-sidebar-accent"
                      aria-expanded={expanded}
                      title={host.name}
                      onClick={() =>
                        setCollapsedChatHosts((value) =>
                          expanded
                            ? [...value, groupKey]
                            : value.filter((key) => key !== groupKey)
                        )
                      }
                    >
                      {expanded ? (
                        <ChevronDown className="size-3 shrink-0" />
                      ) : (
                        <ChevronRight className="size-3 shrink-0" />
                      )}
                      <Folder className="size-3.5 shrink-0" />
                      <span className="truncate">{host.name}</span>
                    </button>
                    {expanded && (
                      <div className="ml-3 border-l pl-2">
                        {renderHistory(sessions, false)}
                      </div>
                    )}
                  </div>
                )
              })}
          </section>
        )}
        {showRecent && recent.length > 0 && (
          <section
            style={{ order: sectionOrder.indexOf("recent") }}
            data-history-section="recent"
          >
            <button
              type="button"
              className="py-2 text-sm font-medium"
              aria-expanded={!collapsedSections.includes("recent")}
              onClick={() =>
                setCollapsedSections((value) =>
                  value.includes("recent")
                    ? value.filter((v) => v !== "recent")
                    : [...value, "recent"]
                )
              }
            >
              {t("recentSessions")}
            </button>
            {!collapsedSections.includes("recent") && renderHistory(recent)}
          </section>
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
              style={{
                order:
                  preferences.mode === "machines"
                    ? sectionOrder.indexOf("folders")
                    : 3,
              }}
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
                      options={options}
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
