"use client"

import {
  Eye,
  Search,
  SquarePen,
  Zap,
  ListTodo,
  LayoutTemplate,
  Map,
  Server,
  MessagesSquare,
  ListChevronsDownUp,
  Crosshair,
  ChartNoAxesCombined,
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
import type { HistoryOptions } from "@/lib/backend/project-history"
import type { RuntimeView } from "@/lib/backend/runtime"
import type { WorkbenchRouteId } from "@/contexts/workbench-route-context"

const ICONS = {
  automations: Zap,
  tasks: ListTodo,
  forge: LayoutTemplate,
  canvas: Map,
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
}) {
  const t = useTranslations("Folder.sidebar")
  return (
    <div className="flex items-center justify-end border-b px-2 py-1">
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
