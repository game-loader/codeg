"use client"

import { FileIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import type { PendingUpload } from "@/components/chat/composer/use-composer-attachments"

/** Integer percentage for a chip, or null while the total is unknown. */
function percentOf(upload: PendingUpload): number | null {
  const total = upload.total ?? 0
  if (total <= 0) return null
  // Hold at 99 while the request is in flight: the last bytes are followed by
  // the server writing the file and answering, which is still "not attached".
  return Math.min(99, Math.floor((upload.loaded / total) * 100))
}

/**
 * The composer's in-flight file uploads, shown next to the image thumbnails.
 *
 * A file gets its `file://` badge only after the server replies with the
 * uploaded path, so without these chips a large upload looks like nothing
 * happened. Each chip carries the byte-level percentage where the transport
 * reports one (web: XHR, remote desktop: the Rust proxy's progress events) and
 * falls back to an indeterminate bar when it doesn't (the base64 IPC leg).
 */
export function ComposerUploadProgress({
  uploads,
}: {
  uploads: PendingUpload[]
}) {
  const t = useTranslations("Folder.fileTreeTab.uploadDialog.status")

  if (uploads.length === 0) return null

  return (
    <>
      {uploads.map((upload) => {
        const percent = percentOf(upload)
        return (
          <div
            key={upload.id}
            className="relative flex h-14 w-44 shrink-0 items-center gap-2 rounded-md border border-border/70 bg-muted/30 px-2"
            data-testid="composer-upload-chip"
          >
            <FileIcon className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs" title={upload.name}>
                {upload.name}
              </div>
              {percent === null ? (
                <div
                  aria-hidden
                  className="mt-1 h-1 w-full animate-pulse rounded-full bg-primary/30"
                />
              ) : (
                // Plain bar (not the shared Progress wrapper, which drops
                // `value` before it reaches Radix and always renders as
                // indeterminate): this one carries a real `aria-valuenow`.
                <div
                  role="progressbar"
                  aria-label={`${t("uploading")} ${upload.name}`}
                  aria-valuenow={percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  dir="ltr"
                  className="mt-1 h-1 w-full overflow-hidden rounded-full bg-primary/20"
                >
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-150 ease-out"
                    style={{ width: `${percent}%` }}
                  />
                </div>
              )}
              <div className="mt-1 text-[10px] tabular-nums text-muted-foreground">
                {percent === null ? t("uploading") : `${percent}%`}
              </div>
            </div>
          </div>
        )
      })}
    </>
  )
}
