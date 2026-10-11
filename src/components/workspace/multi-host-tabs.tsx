"use client"

import { useTranslations } from "next-intl"
import { File, MessageSquare, X } from "lucide-react"
import { cn } from "@/lib/utils"
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
}

export function MultiHostTabs({
  tabs,
  selected,
  onSelect,
  onClose,
}: {
  tabs: readonly WindowResourceTab[]
  selected: WindowResourceRef | null
  onSelect(ref: WindowResourceRef): void
  onClose(ref: WindowResourceRef): void
}) {
  const t = useTranslations("MultiHost")
  const selectedKey = selected ? windowResourceKey(selected) : null
  return (
    <div
      className="flex h-9 shrink-0 overflow-x-auto border-b bg-background"
      role="tablist"
      aria-label={t("title")}
    >
      {tabs.map((tab) => {
        const key = windowResourceKey(tab.ref)
        return (
          <div
            key={key}
            className={cn(
              "flex max-w-64 shrink-0 items-center border-r",
              key === selectedKey && "bg-muted"
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={key === selectedKey}
              title={`${tab.machineName} · ${tab.title}`}
              className="flex min-w-0 items-center gap-1.5 px-2 py-1.5 text-xs"
              onClick={() => onSelect(tab.ref)}
            >
              {tab.ref.kind === "conversation" ? (
                <MessageSquare className="size-3 shrink-0" />
              ) : (
                <File className="size-3 shrink-0" />
              )}
              <span className="truncate">{tab.title}</span>
              <span className="max-w-20 truncate rounded bg-muted-foreground/10 px-1 text-[10px] text-muted-foreground">
                {tab.machineName}
              </span>
              {(tab.dirty || tab.running) && (
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    tab.running
                      ? "animate-pulse bg-primary"
                      : "bg-muted-foreground"
                  )}
                />
              )}
            </button>
            <button
              type="button"
              aria-label={`${t("close")} · ${tab.title}`}
              className="mr-1 rounded p-1 hover:bg-muted-foreground/10"
              onClick={() => onClose(tab.ref)}
            >
              <X className="size-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
