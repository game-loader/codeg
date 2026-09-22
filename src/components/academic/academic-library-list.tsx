"use client"

import { useMemo, useState } from "react"
import {
  BookOpen,
  ChevronRight,
  FolderClosed,
  LoaderCircle,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { useAcademicStore } from "@/stores/academic-store"
import type { AcademicCollection, AcademicItem } from "@/lib/academic"
import { cn } from "@/lib/utils"

export function AcademicLibraryList({
  onSelect,
  compact = false,
}: {
  onSelect?: () => void
  compact?: boolean
}) {
  const t = useTranslations("Academic")
  const library = useAcademicStore((s) => s.library)
  const loading = useAcademicStore((s) => s.loadingLibrary)
  const selected = useAcademicStore((s) => s.selectedItemKey)
  const selectedPaper = useAcademicStore((s) => s.selectedPaper)
  const selectItem = useAcademicStore((s) => s.selectItem)
  const [query, setQuery] = useState("")
  const items = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return (
      library?.items.filter(
        (item) =>
          !needle ||
          `${item.title} ${item.authors.join(" ")} ${library.collections
            .filter((collection) => item.collections.includes(collection.key))
            .map((collection) => collection.name)
            .join(" ")}`
            .toLocaleLowerCase()
            .includes(needle)
      ) ?? []
    )
  }, [library, query])

  const renderItem = (item: AcademicItem) => (
    <button
      type="button"
      key={item.key}
      title={item.title}
      aria-current={selected === item.key ? "true" : undefined}
      className={cn(
        "flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
        selected === item.key && "bg-accent"
      )}
      onClick={() => {
        void selectItem(item.key)
        onSelect?.()
      }}
    >
      <BookOpen className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2">{item.title || t("untitled")}</span>
        {selected === item.key && selectedPaper && (
          <span className="mt-0.5 block text-[10px] text-muted-foreground">
            {t(`status.${selectedPaper.status}`)}
          </span>
        )}
      </span>
    </button>
  )

  const renderCollection = (
    collection: AcademicCollection,
    ancestors: Set<string>
  ) => {
    if (ancestors.has(collection.key)) return null
    const next = new Set(ancestors).add(collection.key)
    const children =
      library?.collections.filter((c) => c.parent_key === collection.key) ?? []
    return (
      <details
        key={collection.key}
        open={query ? true : undefined}
        className="group/collection"
      >
        <summary
          className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-1 py-1.5 text-xs hover:bg-accent"
          onClick={() =>
            useAcademicStore.setState({ selectedCollectionKey: collection.key })
          }
        >
          <ChevronRight className="size-3 shrink-0 transition-transform group-open/collection:rotate-90" />
          <FolderClosed className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{collection.name}</span>
        </summary>
        <div className="ml-3 border-l border-border/50 pl-1">
          {children.map((child) => renderCollection(child, next))}
          {items
            .filter((item) => item.collections.includes(collection.key))
            .map(renderItem)}
        </div>
      </details>
    )
  }

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("search")}
        aria-label={t("search")}
        className={compact ? "h-7 text-xs" : ""}
      />
      <div
        className={cn(
          "overflow-y-auto",
          compact ? "max-h-64" : "min-h-0 flex-1"
        )}
      >
        {loading && (
          <div className="flex items-center gap-2 p-2 text-xs text-muted-foreground">
            <LoaderCircle className="size-3 animate-spin" />
            {t("loading")}
          </div>
        )}
        {!library && !loading && (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            {t("connectHint")}
          </p>
        )}
        {library && items.length === 0 && !loading && (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            {t("emptyLibrary")}
          </p>
        )}
        {query ? (
          items.map(renderItem)
        ) : (
          <>
            {library?.collections
              .filter(
                (c) =>
                  !c.parent_key ||
                  !library.collections.some((p) => p.key === c.parent_key)
              )
              .map((c) => renderCollection(c, new Set()))}
            {items
              .filter(
                (item) =>
                  !item.collections.some((key) =>
                    library?.collections.some((c) => c.key === key)
                  )
              )
              .map(renderItem)}
          </>
        )}
      </div>
    </div>
  )
}
