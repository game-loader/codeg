"use client"

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import type { useWorkspaceActions } from "@/contexts/workspace-context"
import type { BackendRuntime } from "@/lib/backend/runtime"
import type { WindowResourceRef } from "@/lib/backend/window-layout"
import { leafIds } from "@/lib/tab-group-layout"
import { groupOfTab } from "@/stores/tab-store"

/** The original tab-menu actions, bound to the resource's retained runtime. */
export function RuntimeTabMenu({
  runtime,
  resource,
  workspace,
  children,
}: {
  runtime: BackendRuntime
  resource: WindowResourceRef
  workspace: Pick<
    ReturnType<typeof useWorkspaceActions>,
    "closeFileTab" | "closeOtherFileTabs" | "closeAllFileTabs"
  >
  children: ReactNode
}) {
  const t = useTranslations("Folder.tabs")
  const tFiles = useTranslations("Folder.fileWorkspace")
  const store = runtime.stores.tabs
  const tabs = store((state) => state.tabs)
  const groupOf = store((state) => state.groupOf)
  const groupLayout = store((state) => state.groupLayout)
  const groupSelection = store((state) => state.groupSelection)
  const tileByGroup = store((state) => state.tileByGroup)
  const tab = tabs.find((tab) => tab.id === resource.id)
  const groupId = groupOfTab(groupOf, groupLayout, resource.id)
  const leaves = leafIds(groupLayout)
  const moveTargets = leaves
    .map((id, index) => ({
      groupId: id,
      index: index + 1,
      title: tabs.find((tab) => tab.id === groupSelection[id])?.title,
    }))
    .filter((target) => target.groupId !== groupId)
  const canMove = tab?.conversationId != null
  const canSplitMove =
    canMove &&
    tabs.filter((tab) => groupOfTab(groupOf, groupLayout, tab.id) === groupId)
      .length >= 2

  const isCurrent = () =>
    runtime.isCurrent() && resource.backendKey === runtime.client.key
  const act = (action: (state: ReturnType<typeof store.getState>) => void) => {
    if (!isCurrent()) return
    const state = store.getState()
    if (state.tabs.some((tab) => tab.id === resource.id)) action(state)
  }
  const actOnGroup = (
    action: (state: ReturnType<typeof store.getState>, id: string) => void
  ) =>
    act((state) =>
      action(state, groupOfTab(state.groupOf, state.groupLayout, resource.id))
    )
  const fileAction = (action: () => void) => {
    if (
      isCurrent() &&
      runtime
        .getSnapshot()
        ?.tabs.some(
          (tab) => tab.ref.kind === "file" && tab.ref.id === resource.id
        )
    )
      action()
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {resource.kind === "file" ? (
          <>
            <ContextMenuItem
              onSelect={() =>
                fileAction(() => workspace.closeFileTab(resource.id))
              }
            >
              {tFiles("close")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() =>
                fileAction(() => workspace.closeOtherFileTabs(resource.id))
              }
            >
              {tFiles("closeOthers")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() => fileAction(workspace.closeAllFileTabs)}
            >
              {tFiles("closeAll")}
            </ContextMenuItem>
          </>
        ) : (
          <>
            <ContextMenuItem
              onSelect={() => act((s) => s.closeTab(resource.id))}
            >
              {t("close")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => act((s) => s.closeOtherTabs(resource.id))}
            >
              {t("closeOthers")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() =>
                act((s) => s.splitTab(resource.id, "right", { move: false }))
              }
            >
              {t("splitRight")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() =>
                act((s) => s.splitTab(resource.id, "down", { move: false }))
              }
            >
              {t("splitDown")}
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!canSplitMove}
              onSelect={() =>
                act((s) => s.splitTab(resource.id, "right", { move: true }))
              }
            >
              {t("splitAndMoveRight")}
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!canSplitMove}
              onSelect={() =>
                act((s) => s.splitTab(resource.id, "down", { move: true }))
              }
            >
              {t("splitAndMoveDown")}
            </ContextMenuItem>
            {leaves.length > 1 && (
              <>
                {canMove &&
                  (moveTargets.length === 1 ? (
                    <ContextMenuItem
                      onSelect={() =>
                        act((s) =>
                          s.moveTabToGroup(resource.id, moveTargets[0].groupId)
                        )
                      }
                    >
                      {t("moveToOppositeGroup")}
                    </ContextMenuItem>
                  ) : (
                    <ContextMenuSub>
                      <ContextMenuSubTrigger>
                        {t("moveToGroup")}
                      </ContextMenuSubTrigger>
                      <ContextMenuSubContent>
                        {moveTargets.map((target) => (
                          <ContextMenuItem
                            key={target.groupId}
                            onSelect={() =>
                              act((s) =>
                                s.moveTabToGroup(resource.id, target.groupId)
                              )
                            }
                          >
                            <span className="shrink-0">
                              {t("groupLabel", { index: target.index })}
                            </span>
                            {target.title && (
                              <span className="max-w-40 truncate text-muted-foreground">
                                {target.title}
                              </span>
                            )}
                          </ContextMenuItem>
                        ))}
                      </ContextMenuSubContent>
                    </ContextMenuSub>
                  ))}
                <ContextMenuItem
                  onSelect={() =>
                    actOnGroup((s, id) => s.toggleGroupOrientation(id))
                  }
                >
                  {t("changeSplitterOrientation")}
                </ContextMenuItem>
                <ContextMenuItem
                  onSelect={() => actOnGroup((s, id) => s.dissolveGroup(id))}
                >
                  {t("unsplit")}
                </ContextMenuItem>
                {moveTargets.length >= 2 && (
                  <ContextMenuItem onSelect={() => act((s) => s.unsplitAll())}>
                    {t("unsplitAll")}
                  </ContextMenuItem>
                )}
              </>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() => actOnGroup((s, id) => s.toggleGroupTile(id))}
            >
              {tileByGroup[groupId] ? t("untileDisplay") : t("tileDisplay")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => act((s) => s.closeAllTabs())}>
              {t("closeAll")}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
