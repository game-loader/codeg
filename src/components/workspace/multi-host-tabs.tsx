"use client"

import { useEffect, useRef, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { File, Maximize2, Minimize2, SquarePen, X } from "lucide-react"
import { ConversationStatusDot } from "@/components/conversations/conversation-status-dot"
import { STRIP_ICON_BTN } from "@/components/tabs/strip-icon-button"
import { cn, handleMiddleClickClose } from "@/lib/utils"
import type { ConversationStatus } from "@/lib/types"
import {
  windowResourceKey,
  type WindowResourceRef,
} from "@/lib/backend/window-layout"

export interface WindowResourceTab {
  ref: WindowResourceRef
  title: string
  machineName: string
  dirty?: boolean
  running?: boolean
  status?: ConversationStatus
  isPinned?: boolean
}

export function MultiHostTabs({
  tabs,
  selected,
  onSelect,
  onClose,
  onPin,
  onNewConversation,
  renderTabMenu,
  onTabAddMenuHost,
  paneMaximized,
  onToggleMaximized,
}: {
  tabs: readonly WindowResourceTab[]
  selected: WindowResourceRef | null
  onSelect(ref: WindowResourceRef): void
  onClose(ref: WindowResourceRef): void
  onPin?(ref: WindowResourceRef): void
  onNewConversation?(): void
  renderTabMenu?(ref: WindowResourceRef, trigger: ReactNode): ReactNode
  onTabAddMenuHost?(host: HTMLDivElement | null): void
  paneMaximized?: boolean
  onToggleMaximized?(): void
}) {
  const t = useTranslations("MultiHost")
  const tTabs = useTranslations("Folder.conversationCard")
  const stripRef = useRef<HTMLDivElement>(null)
  const selectedKey = selected ? windowResourceKey(selected) : null
  const activeIndex = tabs.findIndex(
    (tab) => windowResourceKey(tab.ref) === selectedKey
  )
  useEffect(() => {
    const active = stripRef.current?.querySelector('[data-active="true"]')
    active?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
  }, [selectedKey])

  return (
    <div className="flex h-10 shrink-0 items-stretch bg-muted ws-transparent-bg">
      <div
        ref={stripRef}
        className="flex h-full min-w-0 flex-1 items-stretch gap-0 overflow-hidden pl-2 pt-1.5"
        role="tablist"
        aria-label={t("title")}
      >
        {tabs.map((tab, index) => {
          const key = windowResourceKey(tab.ref)
          const active = key === selectedKey
          const adjacentActive =
            activeIndex < 0
              ? undefined
              : index === activeIndex - 1
                ? "before"
                : index === activeIndex + 1
                  ? "after"
                  : undefined
          const trigger = (
            <div
              role="tab"
              aria-label={`${tab.title} ${tab.machineName}`}
              aria-selected={active}
              tabIndex={active || (activeIndex < 0 && index === 0) ? 0 : -1}
              title={`${tab.machineName} · ${tab.title}`}
              onClick={() => onSelect(tab.ref)}
              onDoubleClick={() => onPin?.(tab.ref)}
              onMouseDown={(event) =>
                handleMiddleClickClose(event, () => onClose(tab.ref))
              }
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  onSelect(tab.ref)
                } else if (
                  ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
                ) {
                  event.preventDefault()
                  const nextIndex =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? tabs.length - 1
                        : (index +
                            (event.key === "ArrowRight" ? 1 : -1) +
                            tabs.length) %
                          tabs.length
                  onSelect(tabs[nextIndex].ref)
                  stripRef.current
                    ?.querySelectorAll<HTMLElement>('[role="tab"]')
                    [nextIndex]?.focus()
                }
              }}
              className={cn(
                "browser-tab-content group/tab relative flex h-full w-full min-w-0 cursor-pointer select-none items-center gap-1.5 overflow-hidden rounded-t-lg px-2 pb-1.5 text-xs transition-colors",
                active
                  ? "bg-background ws-transparent-bg text-foreground"
                  : "isolate browser-tab-hover text-muted-foreground hover:text-foreground ws-strip-line"
              )}
            >
              {tab.ref.kind === "conversation" ? (
                <ConversationStatusDot
                  status={
                    tab.status ?? (tab.running ? "in_progress" : undefined)
                  }
                />
              ) : (
                <File className="size-3.5 shrink-0" />
              )}
              <span
                className={cn(
                  "browser-tab-label min-w-0 flex-1 overflow-hidden whitespace-nowrap",
                  tab.ref.kind === "conversation" &&
                    tab.isPinned === false &&
                    "[font-style:oblique]"
                )}
              >
                {tab.title}
                <span className="ml-1.5 rounded bg-muted-foreground/10 px-1 text-[10px] text-muted-foreground">
                  {tab.machineName}
                </span>
              </span>
              {tab.dirty && (
                <span className="size-1.5 shrink-0 rounded-full bg-primary mr-5" />
              )}
              <button
                type="button"
                aria-label={`${t("close")} · ${tab.title}`}
                className={cn(
                  "absolute bottom-1.5 right-2 top-0 my-auto flex size-4 items-center justify-center rounded-md hover:bg-foreground/10 focus-visible:opacity-100 focus-visible:pointer-events-auto",
                  active
                    ? "opacity-100"
                    : "opacity-0 pointer-events-none group-hover/tab:opacity-100 group-hover/tab:pointer-events-auto"
                )}
                onClick={(event) => {
                  event.stopPropagation()
                  onClose(tab.ref)
                }}
              >
                <X className="size-3" />
              </button>
            </div>
          )
          return (
            <div
              key={key}
              data-tab-item
              data-tab-id={key}
              data-active={active ? "true" : undefined}
              data-adjacent-active={adjacentActive}
              className="browser-tab-item min-w-0 grow-0 shrink basis-48 data-[active=true]:z-10"
            >
              <span aria-hidden className="browser-tab-seat" />
              {renderTabMenu ? renderTabMenu(tab.ref, trigger) : trigger}
            </div>
          )
        })}
        <div
          data-adjacent-active={
            activeIndex >= 0 && activeIndex === tabs.length - 1
              ? "after"
              : undefined
          }
          className="tab-strip-tail relative flex h-full flex-1 items-stretch ws-strip-line"
        >
          <button
            type="button"
            disabled={!onNewConversation}
            onClick={() => onNewConversation?.()}
            className={cn(STRIP_ICON_BTN, "ml-1.5 mr-0.5 disabled:opacity-50")}
            aria-label={tTabs("newConversation")}
            title={tTabs("newConversation")}
          >
            <SquarePen className="size-3.5" />
          </button>
          <div ref={onTabAddMenuHost} className="flex items-stretch" />
          <div data-tauri-drag-region className="h-full min-w-10 flex-1" />
          {onToggleMaximized && (
            <button
              type="button"
              onClick={onToggleMaximized}
              className={cn(
                STRIP_ICON_BTN,
                "mr-1.5",
                paneMaximized && "text-primary"
              )}
              aria-label={tTabs(paneMaximized ? "restore" : "maximize")}
              title={tTabs(paneMaximized ? "restore" : "maximize")}
            >
              {paneMaximized ? (
                <Minimize2 className="size-3.5" />
              ) : (
                <Maximize2 className="size-3.5" />
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
