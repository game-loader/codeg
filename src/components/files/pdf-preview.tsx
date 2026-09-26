"use client"

import { useEffect, useRef, useState } from "react"
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Maximize,
  Minus,
  Plus,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist"
import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import { toErrorMessage } from "@/lib/app-error"
import { downloadPdf, loadPdf, PDF_DATA_PREFIX } from "@/lib/pdf-preview"

const MIN_ZOOM = 0.25
const MAX_ZOOM = 4
const ZOOM_STEP = 0.25
const PAGE_PADDING = 32
// Keep a large page or high-DPI screen from allocating an unbounded canvas.
const MAX_CANVAS_PIXELS = 16_000_000

export function PdfPreview({ tab }: { tab: FileWorkspaceTab }) {
  const t = useTranslations("Folder.pdfPreview")
  const [loaded, setLoaded] = useState<{
    source: string
    document?: PDFDocumentProxy
    error?: string
  } | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [zoom, setZoom] = useState<number | "fit">("fit")
  const [fitScale, setFitScale] = useState(1)
  const [attempt, setAttempt] = useState(0)
  const [downloading, setDownloading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const content = tab.content
  const validData = content.startsWith(PDF_DATA_PREFIX)
  const document = loaded?.source === content ? loaded.document : undefined
  const error = loaded?.source === content ? loaded.error : undefined
  const currentPage = Math.min(pageNumber, document?.numPages ?? 1)

  useEffect(() => {
    const element = scrollRef.current
    if (element) {
      element.scrollTop = 0
      element.scrollLeft = 0
    }
  }, [currentPage])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!validData) return
    let disposed = false
    let task: PDFDocumentLoadingTask | undefined
    void (async () => {
      try {
        const next = await loadPdf(content)
        // Attach the rejection handler before destroying a task that completed
        // its dynamic import after this view was already closed/reloaded.
        const result = next.promise
        void result.catch(() => {})
        if (disposed) {
          await next.destroy()
          return
        }
        task = next
        const pdf = await result
        if (disposed) return
        setLoaded({ source: content, document: pdf })
        setPageNumber(1)
      } catch (error) {
        if (disposed) return
        const passwordRequired =
          error instanceof Error && error.name === "PasswordException"
        setLoaded({
          source: content,
          error: passwordRequired
            ? t("passwordRequired")
            : toErrorMessage(error),
        })
      }
    })()
    return () => {
      disposed = true
      void task?.destroy().catch(() => {})
    }
  }, [content, validData, attempt, t])

  const handleDownload = async () => {
    if (!tab.path || !validData || downloading) return
    setDownloading(true)
    try {
      await downloadPdf(tab.path, content, tab.title)
    } catch (error) {
      toast.error(t("downloadFailed"), { description: toErrorMessage(error) })
    } finally {
      setDownloading(false)
    }
  }

  const buttonClass =
    "flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-muted disabled:opacity-40 disabled:pointer-events-none"
  const failed =
    error || (!tab.loading && !validData ? tab.saveError || content : null)

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label={t("title")}>
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1 text-xs">
        <button
          type="button"
          className={buttonClass}
          aria-label={t("previousPage")}
          title={t("previousPage")}
          disabled={!document || currentPage <= 1}
          onClick={() => setPageNumber(currentPage - 1)}
        >
          <ChevronLeft className="size-4" />
        </button>
        <label className="flex items-center gap-1 tabular-nums">
          <span className="sr-only">{t("pageNumber")}</span>
          <input
            type="number"
            aria-label={t("pageNumber")}
            min={1}
            max={document?.numPages ?? 1}
            value={currentPage}
            disabled={!document}
            className="h-6 w-14 rounded border bg-background px-1 text-center"
            onChange={(event) => {
              const value = event.target.valueAsNumber
              if (Number.isInteger(value) && document) {
                setPageNumber(Math.max(1, Math.min(document.numPages, value)))
              }
            }}
          />
          <span>/ {document?.numPages ?? "—"}</span>
        </label>
        <button
          type="button"
          className={buttonClass}
          aria-label={t("nextPage")}
          title={t("nextPage")}
          disabled={!document || currentPage >= document.numPages}
          onClick={() => setPageNumber(currentPage + 1)}
        >
          <ChevronRight className="size-4" />
        </button>
        <span className="mx-1 h-4 border-l" />
        <button
          type="button"
          className={buttonClass}
          aria-label={t("zoomOut")}
          title={t("zoomOut")}
          disabled={!document || zoom === MIN_ZOOM}
          onClick={() =>
            setZoom(
              Math.max(
                MIN_ZOOM,
                Math.min(
                  MAX_ZOOM,
                  (zoom === "fit" ? fitScale : zoom) - ZOOM_STEP
                )
              )
            )
          }
        >
          <Minus className="size-4" />
        </button>
        <span className="min-w-10 text-center tabular-nums">
          {zoom === "fit" ? t("fitWidth") : `${Math.round(zoom * 100)}%`}
        </span>
        <button
          type="button"
          className={buttonClass}
          aria-label={t("zoomIn")}
          title={t("zoomIn")}
          disabled={!document || zoom === MAX_ZOOM}
          onClick={() =>
            setZoom(
              Math.min(
                MAX_ZOOM,
                Math.max(
                  MIN_ZOOM,
                  (zoom === "fit" ? fitScale : zoom) + ZOOM_STEP
                )
              )
            )
          }
        >
          <Plus className="size-4" />
        </button>
        <button
          type="button"
          className={buttonClass}
          aria-label={t("fitWidth")}
          title={t("fitWidth")}
          disabled={!document}
          onClick={() => setZoom("fit")}
        >
          <Maximize className="size-4" />
        </button>
        <button
          type="button"
          className={`${buttonClass} ml-auto`}
          aria-label={t("download")}
          title={t("download")}
          disabled={!validData || !tab.path || downloading}
          onClick={() => void handleDownload()}
        >
          <Download className="size-4" />
        </button>
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto bg-muted/30 p-4"
      >
        {failed ? (
          <div
            role="alert"
            className="flex h-full flex-col items-center justify-center gap-3 text-center text-sm"
          >
            <p>{t("loadFailed")}</p>
            <p className="max-w-lg break-words text-xs text-muted-foreground">
              {failed}
            </p>
            {validData && (
              <button
                type="button"
                className="rounded-md border px-3 py-1"
                onClick={() => {
                  setLoaded(null)
                  setAttempt((value) => value + 1)
                }}
              >
                {t("retry")}
              </button>
            )}
          </div>
        ) : document && width > 0 ? (
          <PdfPage
            document={document}
            pageNumber={currentPage}
            zoom={zoom}
            width={Math.max(1, width - PAGE_PADDING)}
            onFitScale={setFitScale}
          />
        ) : (
          <p
            role="status"
            className="p-6 text-center text-sm text-muted-foreground"
          >
            {t("loading")}
          </p>
        )}
      </div>
    </div>
  )
}

/** One page at a time bounds memory for long papers. Each render gets its own
 * canvas so a cancelled render can never paint over a newer page or zoom. */
function PdfPage({
  document: pdf,
  pageNumber,
  zoom,
  width,
  onFitScale,
}: {
  document: PDFDocumentProxy
  pageNumber: number
  zoom: number | "fit"
  width: number
  onFitScale: (scale: number) => void
}) {
  const t = useTranslations("Folder.pdfPreview")
  const container = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    let rendering: RenderTask | undefined
    const canvas = window.document.createElement("canvas")
    canvas.className = "mx-auto bg-white shadow-sm"
    canvas.setAttribute("role", "img")
    canvas.setAttribute("aria-label", t("page", { page: pageNumber }))
    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber)
        if (disposed) return
        setError(null)
        const natural = page.getViewport({ scale: 1 })
        onFitScale(width / natural.width)
        const scale = zoom === "fit" ? width / natural.width : zoom
        const viewport = page.getViewport({ scale })
        const pixelRatio = Math.min(
          window.devicePixelRatio || 1,
          Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height))
        )
        canvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio))
        canvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio))
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        container.current?.append(canvas)
        rendering = page.render({
          canvas,
          viewport,
          transform: [pixelRatio, 0, 0, pixelRatio, 0, 0],
        })
        await rendering.promise
        page.cleanup()
      } catch (error) {
        if (!disposed) setError(toErrorMessage(error))
      }
    })()
    return () => {
      disposed = true
      rendering?.cancel()
      canvas.remove()
      // Release the backing buffer when a page is replaced.
      canvas.width = 0
      canvas.height = 0
    }
  }, [pdf, pageNumber, zoom, width, t, onFitScale])

  return (
    <div>
      {error && (
        <p role="alert" className="p-4 text-center text-sm">
          {t("loadFailed")}: {error}
        </p>
      )}
      <div ref={container} />
    </div>
  )
}
