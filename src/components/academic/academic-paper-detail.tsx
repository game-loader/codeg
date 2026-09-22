"use client"

import { useState } from "react"
import {
  BookOpen,
  ExternalLink,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  Square,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { useTabActions } from "@/contexts/tab-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import {
  academicCancel,
  academicOpenTarget,
  academicPrepare,
  isAcademicBusy,
  type AcademicPaper,
} from "@/lib/academic"
import { openAcademicConversation } from "@/lib/academic-conversation"
import { isLocalDesktop, openPath, openUrl } from "@/lib/platform"
import { useAcademicStore } from "@/stores/academic-store"

export function AcademicPaperDetail({ paper }: { paper: AcademicPaper }) {
  const t = useTranslations("Academic")
  const { openTab } = useTabActions()
  const { openConversations } = useWorkbenchRoute()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busy = isAcademicBusy(paper.status)
  const analysisConversation = paper.conversations.find(
    (conversation) => conversation.id === paper.analysis_conversation_id
  )

  async function perform(action: () => Promise<unknown>) {
    setPending(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(
        message === "academicDraftConflict" ? t("draftConflict") : message
      )
    } finally {
      setPending(false)
    }
  }

  async function start(withoutCode: boolean) {
    const target = await academicOpenTarget(paper.id, withoutCode)
    await openAcademicConversation(target)
    openConversations()
  }

  async function prepare(arxivId?: string, repoUrl?: string) {
    await academicPrepare(paper.id, arxivId, repoUrl)
    await useAcademicStore.getState().refreshPaper(paper.id)
  }

  return (
    <article className="space-y-5">
      <div className="space-y-2">
        <div
          className="flex items-center gap-2 text-xs text-muted-foreground"
          role="status"
        >
          {busy ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <BookOpen className="size-3.5" />
          )}
          {t(`status.${paper.status}`)}
        </div>
        <h2 className="text-xl font-semibold leading-snug">{paper.title}</h2>
        <p className="text-sm text-muted-foreground">
          {paper.authors.join(", ")}
        </p>
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          {paper.doi && <span>DOI: {paper.doi}</span>}
          {paper.arxiv_id && <span>arXiv: {paper.arxiv_id}</span>}
        </div>
      </div>
      {paper.abstract_text && (
        <p className="whitespace-pre-wrap text-sm leading-relaxed">
          {paper.abstract_text}
        </p>
      )}
      {(error || paper.error) && (
        <p
          role="alert"
          className="rounded-lg bg-destructive/5 p-3 text-sm text-destructive"
        >
          {t("operationFailed", { message: error ?? paper.error ?? "" })}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={
            pending ||
            busy ||
            ["needs_match", "needs_repo"].includes(paper.status)
          }
          onClick={() => void perform(() => start(!paper.repo_path))}
        >
          <MessageSquare />
          {t("startChat")}
        </Button>
        {paper.repo_path && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void perform(() => start(true))}
          >
            {t("paperOnly")}
          </Button>
        )}
        {!paper.repo_path &&
          (busy || ["needs_match", "needs_repo"].includes(paper.status)) && (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => void perform(() => start(true))}
            >
              {t("paperOnly")}
            </Button>
          )}
        {busy ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              void perform(async () => {
                await academicCancel(paper.id)
                await useAcademicStore.getState().refreshPaper(paper.id)
              })
            }
          >
            <Square />
            {t("cancel")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void perform(() => prepare())}
          >
            <RefreshCw />
            {t("prepareAgain")}
          </Button>
        )}
        {paper.pdf_path && isLocalDesktop() && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void perform(() => openPath(paper.pdf_path!))}
          >
            <ExternalLink />
            {t("openPdf")}
          </Button>
        )}
      </div>
      {paper.pdf_path && !isLocalDesktop() && (
        <p className="break-all text-xs text-muted-foreground">
          {paper.pdf_path}
        </p>
      )}
      {!paper.text_path && (
        <p className="text-xs text-muted-foreground">{t("metadataOnlyHint")}</p>
      )}
      {paper.status === "needs_match" && (
        <section className="space-y-3 rounded-xl border p-4">
          <h3 className="text-sm font-semibold">{t("chooseArxiv")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("chooseArxivHint")}
          </p>
          {paper.candidates.map((candidate) => (
            <div key={candidate.id} className="space-y-2 rounded-lg border p-3">
              <h4 className="text-sm font-medium">{candidate.title}</h4>
              <p className="text-xs text-muted-foreground">
                {candidate.authors.join(", ")} · {candidate.id}
              </p>
              <p className="line-clamp-4 text-xs leading-relaxed">
                {candidate.summary}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => void perform(() => prepare(candidate.id))}
              >
                {t("useMatch")}
              </Button>
            </div>
          ))}
        </section>
      )}
      {paper.status === "needs_repo" && (
        <section className="space-y-3 rounded-xl border p-4">
          <h3 className="text-sm font-semibold">{t("chooseRepo")}</h3>
          {paper.repo_candidates.map((candidate) => (
            <div
              key={candidate.url}
              className="space-y-2 rounded-lg border p-3"
            >
              <button
                type="button"
                className="break-all text-left text-sm text-primary underline"
                onClick={() => void perform(() => openUrl(candidate.url))}
              >
                {candidate.url}
              </button>
              <blockquote className="border-l-2 pl-3 text-xs text-muted-foreground">
                {candidate.evidence_quote}
              </blockquote>
              {candidate.source_url && (
                <button
                  type="button"
                  className="block break-all text-left text-xs underline"
                  onClick={() =>
                    void perform(() => openUrl(candidate.source_url!))
                  }
                >
                  {candidate.source_url}
                </button>
              )}
              {candidate.license && (
                <p className="text-xs">{candidate.license}</p>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  void perform(() => prepare(undefined, candidate.url))
                }
              >
                {t("useRepo")}
              </Button>
            </div>
          ))}
        </section>
      )}
      {paper.repo_url && (
        <section className="space-y-2 rounded-xl border p-4">
          <h3 className="text-sm font-semibold">{t("repository")}</h3>
          <button
            type="button"
            className="break-all text-left text-sm text-primary underline"
            onClick={() => void perform(() => openUrl(paper.repo_url!))}
          >
            {paper.repo_url}
          </button>
          {paper.repo_path &&
            (isLocalDesktop() ? (
              <button
                type="button"
                className="block break-all text-left text-xs text-muted-foreground underline"
                onClick={() => void perform(() => openPath(paper.repo_path!))}
              >
                {paper.repo_path}
              </button>
            ) : (
              <p className="break-all text-xs text-muted-foreground">
                {paper.repo_path}
              </p>
            ))}
          <p className="text-xs text-muted-foreground">{t("licenseHint")}</p>
        </section>
      )}
      {paper.analysis && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t("analysis")}</h3>
          <pre className="whitespace-pre-wrap break-words rounded-xl bg-muted/40 p-4 font-sans text-sm leading-relaxed">
            {paper.analysis}
          </pre>
        </section>
      )}
      {analysisConversation != null && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            openTab(
              analysisConversation.folder_id,
              analysisConversation.id,
              analysisConversation.agent_type,
              true,
              t("analysis")
            )
            openConversations()
          }}
        >
          {t("viewAnalysis")}
        </Button>
      )}
      {paper.conversations.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t("conversations")}</h3>
          {paper.conversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              className="flex w-full items-center gap-2 rounded-lg border p-3 text-left text-sm hover:bg-accent"
              onClick={() => {
                openTab(
                  conversation.folder_id,
                  conversation.id,
                  conversation.agent_type,
                  true,
                  conversation.title ?? undefined
                )
                openConversations()
              }}
            >
              <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
              {conversation.title || t("untitled")}
            </button>
          ))}
        </section>
      )}
    </article>
  )
}
