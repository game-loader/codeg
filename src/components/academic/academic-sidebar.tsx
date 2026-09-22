"use client"

import { useState } from "react"
import { ChevronRight, GraduationCap } from "lucide-react"
import { useTranslations } from "next-intl"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useAcademicStore } from "@/stores/academic-store"
import { cn } from "@/lib/utils"
import { AcademicLibraryList } from "./academic-library-list"
import { useAcademicEvents } from "./use-academic-events"

export function AcademicSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const t = useTranslations("Academic")
  const { routeId, setRoute } = useWorkbenchRoute()
  const [expanded, setExpanded] = useState(false)
  useAcademicEvents()

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        aria-current={routeId === "academic" ? "page" : undefined}
        className={cn(
          "flex h-8 w-full items-center gap-[0.4375rem] rounded-full pl-[0.4375rem] pr-1.5 text-[0.875rem] hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring",
          routeId === "academic" && "bg-sidebar-primary/8"
        )}
        onClick={() => {
          setExpanded(!expanded)
          setRoute("academic")
          if (!expanded) void useAcademicStore.getState().refreshLibrary()
          onNavigate?.()
        }}
      >
        <GraduationCap className="size-[0.875rem] shrink-0 text-muted-foreground" />
        <span>{t("title")}</span>
        <ChevronRight
          className={cn(
            "ml-auto size-3 text-muted-foreground transition-transform",
            expanded && "rotate-90"
          )}
        />
      </button>
      {expanded && (
        <div className="px-1 pb-2 pt-1">
          <AcademicLibraryList
            compact
            onSelect={() => {
              setRoute("academic")
              onNavigate?.()
            }}
          />
        </div>
      )}
    </div>
  )
}
