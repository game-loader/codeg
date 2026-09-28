"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"
import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import { toErrorMessage } from "@/lib/app-error"
import { openVideoPreview } from "@/lib/video-preview"

export function VideoPreview({ tab }: { tab: FileWorkspaceTab }) {
  return (
    <VideoPlayer
      key={`${tab.path}:${tab.previewRevision ?? 0}`}
      path={tab.path ?? ""}
      title={tab.title}
    />
  )
}

function VideoPlayer({ path, title }: { path: string; title: string }) {
  const t = useTranslations("Folder.videoPreview")
  const videoRef = useRef<HTMLVideoElement>(null)
  const [src, setSrc] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    let release: (() => Promise<void>) | undefined
    const video = videoRef.current
    openVideoPreview(path)
      .then((session) => {
        if (cancelled) {
          void session.release()
          return
        }
        release = session.release
        setSrc(session.url)
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        setError(toErrorMessage(reason))
        setLoading(false)
      })
    return () => {
      cancelled = true
      // Stop audio and pending range requests when switching tabs or closing
      // the mobile drawer. Revoking the capability also blocks future reads.
      if (video) {
        video.pause()
        video.removeAttribute("src")
        video.load()
      }
      void release?.()
    }
  }, [path, attempt])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-none truncate border-b border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        {title}
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black p-2 sm:p-4">
        <video
          ref={videoRef}
          src={src}
          controls
          playsInline
          preload="metadata"
          aria-label={t("player", { name: title })}
          className="max-h-full w-full object-contain"
          onLoadedMetadata={() => setLoading(false)}
          onError={(event) => {
            // Removing src during cleanup can dispatch an abort; only an
            // actual media error should replace the preview with a notice.
            const mediaError = event.currentTarget.error
            if (!mediaError) return
            setLoading(false)
            setError(
              t(
                mediaError.code === 3 || mediaError.code === 4
                  ? "unsupported"
                  : "networkError"
              )
            )
          }}
        />
        {loading && !error && (
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-sm text-white"
            role="status"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("loading")}
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center">
            <div role="alert" className="max-w-lg space-y-2">
              <p className="text-sm font-medium">{t("loadFailed")}</p>
              <p className="break-words text-xs text-muted-foreground">
                {error}
              </p>
            </div>
            <button
              type="button"
              className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
              onClick={() => {
                setSrc(undefined)
                setError(null)
                setLoading(true)
                setAttempt((value) => value + 1)
              }}
            >
              {t("retry")}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
