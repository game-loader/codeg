"use client"

import { useEffect, useRef, useState } from "react"
import {
  GraduationCap,
  LoaderCircle,
  Plus,
  RefreshCw,
  Settings,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { WorkbenchPageTitle } from "@/components/workbench/workbench-page-title"
import { academicImport } from "@/lib/academic"
import { getTransport } from "@/lib/transport"
import { useAcademicStore } from "@/stores/academic-store"
import { AcademicLibraryList } from "./academic-library-list"
import { AcademicPaperDetail } from "./academic-paper-detail"
import { AcademicSettings } from "./academic-settings"
import { useAcademicEvents } from "./use-academic-events"

export function AcademicPageTitle() {
  const t = useTranslations("Academic")
  return <WorkbenchPageTitle title={t("title")} />
}

export function AcademicPage() {
  const t = useTranslations("Academic")
  const settings = useAcademicStore((s) => s.settings)
  const library = useAcademicStore((s) => s.library)
  const paper = useAcademicStore((s) => s.selectedPaper)
  const loadingPaper = useAcademicStore((s) => s.loadingPaper)
  const loadingLibrary = useAcademicStore((s) => s.loadingLibrary)
  const error = useAcademicStore((s) => s.error)
  const selectedCollection = useAcademicStore((s) => s.selectedCollectionKey)
  const [showSettings, setShowSettings] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [identifier, setIdentifier] = useState("")
  const [importing, setImporting] = useState(false)
  const mounted = useRef(false)
  useAcademicEvents()

  useEffect(() => {
    mounted.current = true
    const store = useAcademicStore.getState()
    void store.loadSettings()
    if (!store.loadingLibrary) void store.refreshLibrary()
    return () => {
      mounted.current = false
    }
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <h1 className="mr-auto flex items-center gap-2 text-sm font-semibold">
          <GraduationCap className="size-4" />
          {t("library")}
        </h1>
        <Button
          size="sm"
          variant="outline"
          disabled={loadingLibrary}
          onClick={() => void useAcademicStore.getState().refreshLibrary()}
        >
          <RefreshCw className={loadingLibrary ? "animate-spin" : ""} />
          {t("refresh")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!library?.collections.length}
          onClick={() => setShowImport(!showImport)}
        >
          <Plus />
          {t("addPaper")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={showSettings}
          onClick={() => setShowSettings(!showSettings)}
        >
          <Settings />
          {t("settings")}
        </Button>
      </div>
      {error && (
        <div
          role="alert"
          className="mx-4 mt-3 rounded-lg bg-destructive/5 p-3 text-xs text-destructive"
        >
          {t("operationFailed", { message: error })}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
        <aside className="border-b p-4 md:w-64 md:shrink-0 md:overflow-y-auto md:border-b-0 md:border-r">
          <AcademicLibraryList />
        </aside>
        <div className="min-w-0 flex-1 space-y-5 p-5 md:overflow-y-auto">
          {(showSettings || !settings?.paired) && (
            <AcademicSettings
              key={`${settings?.agent_type}-${settings?.bridge_port}-${settings?.paired}`}
              settings={
                settings ?? {
                  agent_type: "codex",
                  bridge_port: 23119,
                  paired: false,
                }
              }
            />
          )}
          {showImport && (
            <form
              className="space-y-3 rounded-xl border p-4"
              onSubmit={async (event) => {
                event.preventDefault()
                if (!selectedCollection || !identifier.trim()) return
                const transport = getTransport()
                const isCurrent = () =>
                  mounted.current && transport === getTransport()
                setImporting(true)
                useAcademicStore.setState({ error: null })
                try {
                  const imported = await academicImport(
                    identifier.trim(),
                    selectedCollection
                  )
                  if (!isCurrent()) return
                  setIdentifier("")
                  setShowImport(false)
                  await useAcademicStore.getState().refreshLibrary()
                  if (isCurrent())
                    await useAcademicStore.getState().selectItem(imported.key)
                } catch (cause) {
                  if (!isCurrent()) return
                  useAcademicStore.setState({
                    error:
                      cause instanceof Error ? cause.message : String(cause),
                  })
                } finally {
                  if (isCurrent()) setImporting(false)
                }
              }}
            >
              <h2 className="text-sm font-semibold">{t("addPaper")}</h2>
              <label className="block space-y-1 text-xs">
                <span>{t("identifier")}</span>
                <Input
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder="arXiv:2401.12345 / DOI"
                  required
                />
              </label>
              <label className="block space-y-1 text-xs">
                <span>{t("collection")}</span>
                <select
                  className="h-9 w-full rounded-lg border bg-background px-2"
                  value={selectedCollection ?? ""}
                  onChange={(e) =>
                    useAcademicStore.setState({
                      selectedCollectionKey: e.target.value,
                    })
                  }
                  required
                >
                  <option value="" disabled>
                    {t("chooseCollection")}
                  </option>
                  {library?.collections.map((collection) => (
                    <option key={collection.key} value={collection.key}>
                      {collection.name}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                type="submit"
                size="sm"
                disabled={importing || !selectedCollection}
              >
                {importing ? t("importing") : t("addPaper")}
              </Button>
            </form>
          )}
          {loadingPaper ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              {t("loading")}
            </p>
          ) : paper ? (
            <AcademicPaperDetail key={paper.id} paper={paper} />
          ) : (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
              <BookIllustration />
              <p className="max-w-md text-sm">{t("selectPaper")}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function BookIllustration() {
  return <GraduationCap className="size-10 opacity-40" aria-hidden="true" />
}
