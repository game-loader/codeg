"use client"

import { useState, type ReactNode } from "react"
import {
  Check,
  Eye,
  Search,
  SquarePen,
  Zap,
  ListTodo,
  LayoutTemplate,
  Map as MapIcon,
  Server,
  MessagesSquare,
  ListChevronsDownUp,
  Crosshair,
  ChartNoAxesCombined,
  ListFilter,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { SidebarNavButton } from "@/components/layout/sidebar-nav-button"
import { AcademicSidebar } from "@/components/academic/academic-sidebar"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  isNavItemVisible,
  SIDEBAR_NAV_ITEM_IDS,
  type SidebarNavItemVisibility,
  type SidebarSectionOrder,
  type SidebarSectionId,
} from "@/lib/sidebar-view-mode-storage"
import { SidebarSectionOrderControl } from "@/components/layout/sidebar-section-order-control"
import type {
  HistoryOptions,
  OwnedTagFilter,
} from "@/lib/backend/project-history"
import type { BackendDescriptor } from "@/lib/backend/registry"
import type { BackendKey } from "@/lib/backend/types"
import type { HostFolderCatalog } from "./multi-host-sidebar"
import {
  EMPTY_TAG_FILTER,
  compareTags,
  isTagFilterActive,
  toggleTagInFilter,
  type TagFilter,
} from "@/lib/conversation-tags"
import type { ConversationTagDetail } from "@/lib/types"
import { ConversationTagChip } from "@/components/conversations/conversation-tag-chip"
import { formatFolderLabelWithAlias } from "@/lib/folder-display"
import { cn } from "@/lib/utils"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import type { RuntimeView } from "@/lib/backend/runtime"
import type { WorkbenchRouteId } from "@/contexts/workbench-route-context"

const ICONS = {
  automations: Zap,
  tasks: ListTodo,
  forge: LayoutTemplate,
  canvas: MapIcon,
  machines: Server,
}

export function UnifiedRuntimeNavigation({
  view,
  context,
  navItems,
  act,
}: {
  view: RuntimeView
  context: string
  navItems: SidebarNavItemVisibility
  act(action: (view: RuntimeView) => void): void
}) {
  const t = useTranslations("Folder.sidebar")
  const chrome = useTranslations("Folder.folderTitleBar")
  const tokens = useTranslations("Folder.statusBar.tokens")
  const navigate = (route: WorkbenchRouteId) =>
    act((owner) => owner.navigate(route))
  return (
    <nav aria-label={t("title")} className="border-b p-2">
      <p
        className="mb-1 truncate text-xs text-muted-foreground"
        title={context}
      >
        {context}
      </p>
      <SidebarNavButton
        icon={SquarePen}
        label={t("newChat")}
        onClick={() => act((owner) => owner.newChat?.())}
      />
      <SidebarNavButton
        icon={Search}
        label={chrome("search")}
        onClick={() => act((owner) => owner.search())}
      />
      <SidebarNavButton
        icon={MessagesSquare}
        label={t("title")}
        active={view.routeId === "conversations"}
        onClick={() => navigate("conversations")}
      />
      {SIDEBAR_NAV_ITEM_IDS.filter((id) => isNavItemVisible(navItems, id)).map(
        (id) => (
          <SidebarNavButton
            key={id}
            icon={ICONS[id]}
            label={t(id)}
            active={view.routeId === id}
            onClick={() => navigate(id)}
          />
        )
      )}
      <AcademicSidebar />
      <SidebarNavButton
        icon={ChartNoAxesCombined}
        label={tokens("tokenUsage")}
        active={view.routeId === "tokenUsage"}
        onClick={() => navigate("tokenUsage")}
      />
    </nav>
  )
}

export function UnifiedHistoryControls({
  options,
  onOptions,
  navItems,
  onNavItems,
  showRecent,
  onShowRecent,
  onCollapse,
  onLocate,
  sectionOrder,
  onMoveSection,
  allCollapsed,
  tagFilterControls,
}: {
  options: HistoryOptions
  onOptions(options: HistoryOptions): void
  navItems: SidebarNavItemVisibility
  onNavItems(items: SidebarNavItemVisibility): void
  showRecent: boolean
  onShowRecent(value: boolean): void
  onCollapse(): void
  onLocate(): void
  sectionOrder: SidebarSectionOrder
  onMoveSection(id: SidebarSectionId, delta: number): void
  allCollapsed: boolean
  tagFilterControls?: ReactNode
}) {
  const t = useTranslations("Folder.sidebar")
  return (
    <div className="flex items-center justify-end border-b px-2 py-1">
      {tagFilterControls}
      <Button
        variant="ghost"
        size="icon"
        className="size-6"
        aria-label={t("locateActiveConversation")}
        onClick={onLocate}
      >
        <Crosshair className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-6"
        aria-label={t(allCollapsed ? "expandAllGroups" : "collapseAllGroups")}
        onClick={onCollapse}
      >
        <ListChevronsDownUp className="size-3.5" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={t("viewOptions")}
          >
            <Eye className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>{t("listOptions")}</DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={options.showCompleted}
            onCheckedChange={(showCompleted) =>
              onOptions({ ...options, showCompleted })
            }
            onSelect={(e) => e.preventDefault()}
          >
            {t("showCompleted")}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={options.showWorktrees}
            onCheckedChange={(showWorktrees) =>
              onOptions({ ...options, showWorktrees })
            }
            onSelect={(e) => e.preventDefault()}
          >
            {t("showWorktrees")}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={showRecent}
            onCheckedChange={onShowRecent}
            onSelect={(e) => e.preventDefault()}
          >
            {t("showRecent")}
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t("navigationItems")}</DropdownMenuLabel>
          {SIDEBAR_NAV_ITEM_IDS.map((id) => (
            <DropdownMenuCheckboxItem
              key={id}
              checked={isNavItemVisible(navItems, id)}
              onCheckedChange={(visible) =>
                onNavItems({ ...navItems, [id]: visible })
              }
              onSelect={(e) => e.preventDefault()}
            >
              {t(id)}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t("sortBy")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={options.sortMode}
            onValueChange={(value) =>
              onOptions({
                ...options,
                sortMode: value === "created" ? "created" : "updated",
              })
            }
          >
            <DropdownMenuRadioItem value="created">
              {t("sortByCreatedAt")}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="updated">
              {t("sortByUpdatedAt")}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t("sectionOrder")}</DropdownMenuLabel>
          <SidebarSectionOrderControl
            order={sectionOrder}
            onMove={onMoveSection}
            hiddenSections={showRecent ? undefined : new Set(["recent"])}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

interface UnifiedTagFilterProps {
  hosts: readonly BackendDescriptor[]
  catalogs: ReadonlyMap<BackendKey, HostFolderCatalog>
  selection: OwnedTagFilter | null
  onChange(selection: OwnedTagFilter): void
}

/** One explicit machine owns every numeric ID offered by this filter. */
export function UnifiedTagFilterButton({
  hosts,
  catalogs,
  focusedHost,
  selection,
  onChange,
}: UnifiedTagFilterProps & { focusedHost: BackendKey }) {
  const t = useTranslations("ConversationTags")
  const machines = useTranslations("MultiHost")
  const [query, setQuery] = useState("")
  const owner =
    hosts.find((host) => host.key === selection?.backendKey) ??
    hosts.find((host) => host.key === focusedHost) ??
    hosts[0]
  const candidate = owner && catalogs.get(owner.key)
  const catalog =
    candidate?.generation === owner?.generation ? candidate : undefined
  const ready = !!catalog?.tagsHydrated
  const filter = selection?.filter ?? EMPTY_TAG_FILTER
  const active = isTagFilterActive(filter)
  const change = (next: TagFilter) => {
    if (owner)
      onChange({
        backendKey: owner.key,
        generation: owner.generation,
        filter: next,
      })
  }
  const folders = catalog?.folders ?? []
  const reachable = (catalog?.conversations ?? []).filter(
    (conversation) =>
      conversation.parent_id == null &&
      (conversation.kind === "chat" ||
        folders.some((folder) => folder.id === conversation.folder_id))
  )
  const counts = new Map<number, number>()
  for (const conversation of reachable)
    for (const id of conversation.tag_ids ?? [])
      counts.set(id, (counts.get(id) ?? 0) + 1)
  const groups = new Map<number | null, ConversationTagDetail[]>()
  for (const tag of [...(catalog?.tags ?? [])].sort(compareTags)) {
    if (
      tag.folder_id !== null &&
      !folders.some(
        (folder) =>
          folder.kind !== "chat" &&
          (folder.id === tag.folder_id || folder.parent_id === tag.folder_id)
      ) &&
      !counts.has(tag.id) &&
      !filter.tagIds.includes(tag.id)
    )
      continue
    const group = groups.get(tag.folder_id) ?? []
    group.push(tag)
    groups.set(tag.folder_id, group)
  }
  const needle = query.trim().toLowerCase()
  const visible = [...groups]
    .map(([scope, tags]) => ({
      scope,
      tags: tags.filter((tag) => tag.name.toLowerCase().includes(needle)),
    }))
    .filter((group) => group.tags.length > 0)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("relative size-6", active && "bg-accent")}
          aria-label={t("filter.button")}
          title={`${t("filter.button")} · ${owner?.name ?? machines("machines")}`}
          aria-pressed={active}
          disabled={!owner}
        >
          <ListFilter className="size-3.5" />
          {active && (
            <span className="absolute -right-1 -top-1 rounded-full bg-primary px-1 text-[0.5625rem] text-primary-foreground">
              {filter.tagIds.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="gap-0 overflow-hidden p-0">
        <label className="flex items-center gap-2 border-b p-2 text-xs">
          {machines("machines")}
          <select
            className="min-w-0 flex-1 rounded border bg-background p-1"
            value={owner ? JSON.stringify([owner.key, owner.generation]) : ""}
            onChange={(event) => {
              const next = hosts.find(
                (host) =>
                  JSON.stringify([host.key, host.generation]) ===
                  event.target.value
              )
              if (next) {
                setQuery("")
                onChange({
                  backendKey: next.key,
                  generation: next.generation,
                  filter: { ...filter, tagIds: [] },
                })
              }
            }}
          >
            {hosts.map((host) => (
              <option
                key={host.key}
                value={JSON.stringify([host.key, host.generation])}
              >
                {host.name}
              </option>
            ))}
          </select>
        </label>
        <div
          role="radiogroup"
          aria-label={t("filter.match")}
          className="flex items-center gap-2 px-3 py-2"
        >
          <span className="text-xs text-muted-foreground">
            {t("filter.match")}
          </span>
          {(["any", "all"] as const).map((mode) => (
            <Button
              key={mode}
              size="sm"
              variant={filter.mode === mode ? "secondary" : "ghost"}
              className="h-6 px-2 text-xs"
              role="radio"
              aria-checked={filter.mode === mode}
              disabled={!ready}
              title={t(
                mode === "all" ? "filter.matchAllHint" : "filter.matchAnyHint"
              )}
              onClick={() => change({ ...filter, mode })}
            >
              {t(mode === "all" ? "filter.matchAll" : "filter.matchAny")}
            </Button>
          ))}
        </div>
        <Command shouldFilter={false} className="rounded-none">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={t("filter.searchPlaceholder")}
            disabled={!ready}
          />
          <CommandList>
            {visible.length === 0 && (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {!ready
                  ? machines("loading")
                  : t(groups.size === 0 ? "filter.noTags" : "filter.noResults")}
              </p>
            )}
            {visible.map(({ scope, tags }) => {
              const folder = folders.find((folder) => folder.id === scope)
              return (
                <CommandGroup
                  key={scope ?? "global"}
                  heading={
                    scope === null
                      ? t("global")
                      : folder
                        ? formatFolderLabelWithAlias(folder)
                        : `#${scope}`
                  }
                >
                  {tags.map((tag) => (
                    <CommandItem
                      key={tag.id}
                      value={`tag-${tag.id}`}
                      disabled={!ready}
                      data-checked={filter.tagIds.includes(tag.id)}
                      onSelect={() => change(toggleTagInFilter(filter, tag.id))}
                    >
                      <Check
                        className={cn(
                          "size-3.5",
                          !filter.tagIds.includes(tag.id) && "opacity-0"
                        )}
                      />
                      <ConversationTagChip tag={tag} />
                      <span className="ml-auto text-xs text-muted-foreground">
                        {counts.get(tag.id) ?? 0}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )
            })}
          </CommandList>
        </Command>
        <Button
          variant="ghost"
          className="justify-start rounded-none border-t text-xs"
          disabled={!active}
          onClick={() => change({ ...filter, tagIds: [] })}
        >
          <X className="size-3.5" />
          {t("filter.clear")}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

export function UnifiedTagFilterBar({
  hosts,
  catalogs,
  selection,
  onChange,
}: UnifiedTagFilterProps) {
  const t = useTranslations("ConversationTags.filter")
  if (!selection || !isTagFilterActive(selection.filter)) return null
  const owner = hosts.find((host) => host.key === selection.backendKey)
  const catalog = catalogs.get(selection.backendKey)
  const tags =
    catalog?.generation === selection.generation ? (catalog.tags ?? []) : []
  return (
    <div
      role="status"
      aria-label={t("active")}
      className="flex items-center gap-1 border-b p-2 text-xs"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        <span className="max-w-full truncate" title={owner?.name}>
          {owner?.name}
        </span>
        {selection.filter.tagIds.map((id) => {
          const tag = tags.find((tag) => tag.id === id)
          return tag ? (
            <button
              key={id}
              type="button"
              aria-label={t("remove", { name: tag.name })}
              onClick={() =>
                onChange({
                  ...selection,
                  filter: toggleTagInFilter(selection.filter, id),
                })
              }
            >
              <ConversationTagChip tag={tag} />
            </button>
          ) : null
        })}
        {selection.filter.tagIds.length > 1 && (
          <span className="text-muted-foreground">
            {t(selection.filter.mode === "all" ? "modeAll" : "modeAny")}
          </span>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="size-5 shrink-0"
        aria-label={t("clear")}
        onClick={() =>
          onChange({
            ...selection,
            filter: { ...selection.filter, tagIds: [] },
          })
        }
      >
        <X className="size-3" />
      </Button>
    </div>
  )
}
