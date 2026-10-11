"use client"

import { useAcademicStore as legacyAcademic } from "@/stores/academic-store"
import { useBackendStores } from "@/contexts/backend-stores-selection-context"
import { useBackendAcademicApi } from "@/contexts/backend-client-context"
import { useEffect, useState } from "react"
import { BookOpen } from "lucide-react"
import { useTranslations } from "next-intl"
import { useOptionalWorkbenchRoute } from "@/contexts/workbench-route-context"
import { type AcademicPaper } from "@/lib/academic"

export function AcademicContextBar({
  paperId,
  conversationId,
}: {
  paperId?: string | null
  conversationId?: number | null
}) {
  const backendStores = useBackendStores({ academic: legacyAcademic })
  const useAcademicStore = backendStores.academic

  const backendAcademic = useBackendAcademicApi()

  const t = useTranslations("Academic")
  const route = useOptionalWorkbenchRoute()
  const [result, setResult] = useState<{
    key: string
    paper: AcademicPaper
  } | null>(null)
  const [error, setError] = useState<{ key: string; message: string } | null>(
    null
  )
  const key = `${paperId ?? ""}:${conversationId ?? ""}`
  useEffect(() => {
    if (!paperId && !conversationId) return
    let active = true
    const load = paperId
      ? backendAcademic.academicPaperGet(paperId)
      : backendAcademic.academicConversationPaper(conversationId!)
    void load
      .then((paper) => {
        if (active && paper) setResult({ key, paper })
      })
      .catch((cause: unknown) => {
        // Ordinary conversations need no academic UI on a lookup failure.
        if (active && paperId)
          setError({
            key,
            message: cause instanceof Error ? cause.message : String(cause),
          })
      })
    return () => {
      active = false
    }
  }, [paperId, conversationId, key, backendAcademic])

  if (error?.key === key)
    return (
      <p role="alert" className="border-b px-4 py-2 text-xs text-destructive">
        {t("contextUnavailable", { message: error.message })}
      </p>
    )
  if (result?.key !== key) return null
  const paper = result.paper
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 border-b bg-primary/5 px-4 py-2 text-left text-xs"
      disabled={!route}
      title={t("viewPaper")}
      onClick={() => {
        useAcademicStore.getState().showPaper(paper)
        route?.setRoute("academic")
      }}
    >
      <BookOpen className="size-3.5 shrink-0 text-primary" />
      <span className="min-w-0 truncate">
        {t("currentPaper", { title: paper.title })}
      </span>
    </button>
  )
}
