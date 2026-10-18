"use client"

import { elementAcceptsDrop } from "@/components/chat/composer/attachment-files"

/**
 * Which mounted composers could own an OS drag.
 *
 * Tauri delivers a drag to every listener in the window with nothing but a
 * window-space point, so a composer decides ownership by hit-testing that
 * point against its own box ({@link pointWithinElement}). When the point cannot
 * route the drag — a platform hands us coordinates we can't map, or a drag
 * event arrives without one — a window with exactly one composer on screen has
 * no ambiguity to resolve. Routing it there beats showing no affordance and
 * silently dropping the file.
 *
 * The registry is module-scoped on purpose: the fallback has to see *every*
 * mounted composer (hidden conversation tabs included), not just this one's
 * React tree.
 */
const hosts = new Set<HTMLElement>()

/** Register a composer's drop-target element; returns the unsubscribe. */
export function registerComposerDropTarget(host: HTMLElement): () => void {
  hosts.add(host)
  return () => {
    hosts.delete(host)
  }
}

/**
 * Whether `host` is the only composer visible right now — in which case any OS
 * drag that reaches this window belongs to it.
 */
export function isSoleVisibleComposer(host: HTMLElement): boolean {
  if (!elementAcceptsDrop(host)) return false
  let visible = 0
  for (const candidate of hosts) {
    if (!elementAcceptsDrop(candidate)) continue
    visible += 1
    if (visible > 1) return false
  }
  return visible === 1
}

/** Test-only: drop every registration (setup files call this between cases). */
export function __resetComposerDropTargetsForTests(): void {
  hosts.clear()
}
