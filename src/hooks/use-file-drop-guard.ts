"use client"

import { useEffect } from "react"

import {
  dragCarriesFiles,
  dragMayCarryFiles,
} from "@/components/chat/composer/attachment-files"

/**
 * Keep an OS file drop from navigating the webview.
 *
 * A drop that lands outside the composer (or outside any explicit drop target)
 * is otherwise the browser's default: navigate the whole window to the dropped
 * file. That reaches the page whenever WebKit — not Tauri's native handler —
 * owns the drag, i.e. the web build, and any desktop window where the native
 * handler never claimed it.
 *
 * Only file drags are accepted here, and nothing is stopped: the composer's own
 * `dragover`/`drop` handlers still run and attach what they get. `dragover` is
 * deliberately generous (a protected WebKit drag may expose no type while it
 * hovers) — without it the browser would never deliver the `drop` that follows.
 */
export function useFileDropGuard(): void {
  useEffect(() => {
    const acceptHover = (event: DragEvent) => {
      if (!dragMayCarryFiles(event.dataTransfer)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
    }
    const acceptDrop = (event: DragEvent) => {
      if (!dragCarriesFiles(event.dataTransfer)) return
      event.preventDefault()
    }
    window.addEventListener("dragover", acceptHover)
    window.addEventListener("drop", acceptDrop)
    return () => {
      window.removeEventListener("dragover", acceptHover)
      window.removeEventListener("drop", acceptDrop)
    }
  }, [])
}
