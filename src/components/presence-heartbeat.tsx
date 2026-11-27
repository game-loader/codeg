"use client"

/**
 * Tells codeg whether the owner is here (6.2, 1.12): every window beats —
 * whether it has the focus, and how long since the last key or pointer
 * input in it. Input counts only while the window has the focus; a window
 * in the background is never "in use". Coming to the window — it gets the
 * focus, it opens with it, its tab is shown — is itself the owner at it.
 * A beat goes out at once on focus,
 * blur and visibility changes, at once on the first input after a while
 * without one, and every 30 s while the window has the focus. The backend
 * decides from that whether the owner is present, and (with their record
 * on) learns their usual hours.
 *
 * More rides along (1.13): how long since the owner last typed into
 * something editable here (a composer, an editor, a terminal) — typing is
 * focus, and normal news waits for them to stop — the assistant whose
 * conversation this window is showing them, which is not notified, and the
 * session its workspace has in front (6.7), which gets no "waiting" card.
 * A change of either goes out at once (typing: the first after a while).
 *
 * Some windows are not the owner at work — the login page, the desktop pet,
 * the computer-use overlays — and never beat. A failed beat is dropped
 * silently: the next one says the same.
 */

import { useEffect, useRef } from "react"
import { usePathname } from "next/navigation"

import {
  useBackendApi,
  useOptionalBackendClient,
} from "@/contexts/backend-client-context"
import { useBackendStores } from "@/contexts/backend-stores-context"
import { useOptionalWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useWorkspaceRuntimeVisibility } from "@/contexts/workspace-runtime-visibility-context"
import { personalAgentPresence } from "@/lib/api"
import type { BackendClient } from "@/lib/backend/types"
import { isWorkspacePath, skipsPresence } from "@/lib/personal-agent-presence"
import { onActiveTransportChange } from "@/lib/transport"
import {
  usePersonalAgentUi,
  usePersonalAgentUiStore,
} from "@/stores/personal-agent-ui-store"
import { useTabStore } from "@/stores/tab-store"
import { useWorkbenchRouteStore } from "@/stores/workbench-route-store"

/** How often a window with the focus beats. */
export const BEAT_EVERY_MS = 30_000
/** Input after this long without a beat that carried it is sent at once. */
export const FRESH_AFTER_MS = 60_000
/** Pointer moves are counted at most this often. */
const MOVE_EVERY_MS = 1_000

export { skipsPresence } from "@/lib/personal-agent-presence"

/** Report the assistant actually shown by this runtime. */
export function usePersonalAgentViewing(viewing: number | null) {
  const store = usePersonalAgentUiStore()
  useEffect(() => {
    store.setState({ viewing })
    return () => store.setState({ viewing: null })
  }, [store, viewing])
}

function newWindowId(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID()
    }
  } catch {
    // fall through
  }
  return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

const INPUTS = [
  "keydown",
  "pointerdown",
  "pointermove",
  "wheel",
  "touchstart",
] as const

/** The `<input>` types that take text. */
const TEXT_INPUTS = new Set([
  "",
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
])

/** Whether a key pressed on `target` is typing: into a text field, a text
 *  area (the composers, Monaco, xterm's hidden one) or editable content. */
export function isTyping(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) {
    return false
  }
  if (target.isContentEditable) return true
  if (target instanceof HTMLTextAreaElement) return !target.readOnly
  if (target instanceof HTMLInputElement) {
    return !target.readOnly && TEXT_INPUTS.has(target.type.toLowerCase())
  }
  return false
}

/** The session (conversation) this window's workspace has in front — only
 *  while the conversations are what it shows, not Today, the board or
 *  another page over them: a session waiting on the owner while they are in
 *  it gets no card (6.7). */
export function conversationInFront(
  tabStore = useTabStore,
  isConversations = useWorkbenchRouteStore.getState().route === "conversations"
): number | null {
  if (!isConversations) return null
  const { tabs, activeTabId } = tabStore.getState()
  if (activeTabId == null) return null
  return tabs.find((t) => t.id === activeTabId)?.conversationId ?? null
}

/** Start beating for this window; returns the stop. */
export function startPresenceHeartbeat(): () => void {
  return startHeartbeat().stop
}

function startHeartbeat({
  send = personalAgentPresence,
  viewingStore = usePersonalAgentUi,
  tabStore = useTabStore,
  inFront = conversationInFront,
  isActive = () => true,
  routeChanges = useWorkbenchRouteStore,
  backendKey,
}: {
  send?: typeof personalAgentPresence
  viewingStore?: ReturnType<typeof usePersonalAgentUiStore>
  tabStore?: typeof useTabStore
  inFront?: () => number | null
  isActive?: () => boolean
  routeChanges?: Pick<typeof useWorkbenchRouteStore, "subscribe"> | null
  backendKey?: BackendClient["key"]
} = {}) {
  const id = newWindowId()
  let lastInput: number | null = null
  /** The input the last beat carried. */
  let sentInput: number | null = null
  let lastTyped: number | null = null
  /** The typing the last beat carried. */
  let sentTyped: number | null = null
  let lastMove = 0
  let stopped = false

  const focused = () =>
    isActive() && document.visibilityState !== "hidden" && document.hasFocus()

  const beat = (hasFocus = focused()) => {
    if (stopped || skipsPresence(window.location.pathname)) return
    const now = Date.now()
    const idleMs = lastInput == null ? null : Math.max(0, now - lastInput)
    const typedMs = lastTyped == null ? null : Math.max(0, now - lastTyped)
    const active = isActive()
    const viewing = active ? viewingStore.getState().viewing : null
    const conversation = active ? inFront() : null
    sentInput = lastInput
    sentTyped = lastTyped
    Promise.resolve()
      .then(() => {
        if (!stopped)
          return send(id, hasFocus, idleMs, typedMs, viewing, conversation)
      })
      .catch(() => {})
  }

  const onInput = (e: Event) => {
    if (!focused()) return
    if (backendKey && e.target instanceof Element) {
      const owner = e.target
        .closest("[data-backend-key]")
        ?.getAttribute("data-backend-key")
      if (owner && owner !== backendKey) return
    }
    const now = Date.now()
    if (e.type === "pointermove") {
      if (now - lastMove < MOVE_EVERY_MS) return
      lastMove = now
    }
    lastInput = now
    let fresh = sentInput == null || now - sentInput > FRESH_AFTER_MS
    if (e.type === "keydown" && isTyping(e.target)) {
      lastTyped = now
      if (sentTyped == null || now - sentTyped > FRESH_AFTER_MS) fresh = true
    }
    if (fresh) beat(true)
  }
  /** The owner came to this window: that is input too. */
  const arrived = () => {
    lastInput = Date.now()
  }
  const onFocus = () => {
    if (focused()) arrived()
    beat()
  }
  const onBlur = () => beat(false)
  const onVisibility = () => {
    if (focused()) arrived()
    beat()
  }
  const onHide = () => beat(false)

  const opts: AddEventListenerOptions = { capture: true, passive: true }
  for (const type of INPUTS) window.addEventListener(type, onInput, opts)
  window.addEventListener("focus", onFocus)
  window.addEventListener("blur", onBlur)
  window.addEventListener("pagehide", onHide)
  document.addEventListener("visibilitychange", onVisibility)
  const timer = window.setInterval(() => {
    if (focused()) beat(true)
  }, BEAT_EVERY_MS)
  // The assistant shown here changed: say so at once.
  let lastViewing = viewingStore.getState().viewing
  const offViewing = viewingStore.subscribe(() => {
    const viewing = viewingStore.getState().viewing
    if (viewing !== lastViewing) {
      lastViewing = viewing
      if (isActive()) beat()
    }
  })
  // So did the session in front (6.7): another tab, or another page over
  // the conversations.
  let lastInFront = inFront()
  const inFrontChanged = () => {
    const now = inFront()
    if (now !== lastInFront) {
      lastInFront = now
      if (isActive()) beat()
    }
  }
  const offTabs = tabStore.subscribe(inFrontChanged)
  const offRoute = routeChanges?.subscribe(inFrontChanged)
  if (focused()) arrived()
  beat()

  const stop = () => {
    stopped = true
    offViewing()
    offTabs()
    offRoute?.()
    window.clearInterval(timer)
    for (const type of INPUTS) window.removeEventListener(type, onInput, opts)
    window.removeEventListener("focus", onFocus)
    window.removeEventListener("blur", onBlur)
    window.removeEventListener("pagehide", onHide)
    document.removeEventListener("visibilitychange", onVisibility)
  }
  return { stop, beat, arrived, inFrontChanged }
}

export function PresenceHeartbeat({
  outsideWorkspace = false,
}: { outsideWorkspace?: boolean } = {}) {
  const client = useOptionalBackendClient()
  const viewingStore = usePersonalAgentUiStore()
  const { personalAgentPresence: send } = useBackendApi()
  const { tabs } = useBackendStores()
  const route = useOptionalWorkbenchRoute()
  const isConversations = route?.isConversations ?? false
  const hasRoute = route != null
  const { visible, focused } = useWorkspaceRuntimeVisibility()
  const active = visible && focused
  const pathname =
    usePathname() ??
    (typeof window === "undefined" ? "" : window.location.pathname)
  const skipped =
    skipsPresence(pathname) || (outsideWorkspace && isWorkspacePath(pathname))
  const state = useRef({ active, isConversations })
  const heartbeat = useRef<ReturnType<typeof startHeartbeat> | null>(null)

  useEffect(() => {
    const before = state.current
    state.current = { active, isConversations }
    if (active !== before.active) {
      if (active && document.hasFocus()) heartbeat.current?.arrived()
      heartbeat.current?.beat()
    } else {
      heartbeat.current?.inFrontChanged()
    }
  }, [active, isConversations])

  useEffect(() => {
    if (skipped) return
    const start = () =>
      startHeartbeat({
        send,
        viewingStore,
        tabStore: tabs,
        inFront: () =>
          hasRoute
            ? conversationInFront(tabs, state.current.isConversations)
            : client
              ? null
              : conversationInFront(),
        isActive: () => state.current.active,
        routeChanges: hasRoute || client ? null : useWorkbenchRouteStore,
        backendKey: client?.key,
      })
    heartbeat.current = start()
    const off = client
      ? undefined
      : onActiveTransportChange(() => {
          heartbeat.current?.stop()
          heartbeat.current = start()
        })
    return () => {
      off?.()
      heartbeat.current?.stop()
      heartbeat.current = null
    }
  }, [client, hasRoute, send, skipped, tabs, viewingStore])
  return null
}
