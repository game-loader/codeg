"use client"

import { useEffect, useRef } from "react"
import { useAcpEvent } from "@/contexts/acp-connections-context"
import type { QueuedMessage } from "@/hooks/use-message-queue"

interface Options {
  enabled: boolean
  connectionId: string | null
  getQueueItems: () => readonly QueuedMessage[]
  editingItemId: string | null
  /** True only once the item was delivered and removed from the queue. */
  onSteer: (id: string) => Promise<boolean>
}

/** Deliver the queue at a tool boundary; ordinary idle flushing remains the
 * fallback when the turn ends first. The model need not call a feedback tool. */
export function useToolBoundarySteering(options: Options) {
  const latest = useRef(options)
  latest.current = options
  const busy = useRef(false)
  const generation = useRef(Symbol())
  const completed = useRef(new Set<string>())
  useEffect(() => {
    generation.current = Symbol()
    completed.current.clear()
    return () => {
      generation.current = Symbol()
    }
  }, [options.connectionId])

  useAcpEvent((event) => {
    const current = latest.current
    if (event.connection_id !== current.connectionId) return
    if (event.type === "user_message" || event.type === "turn_complete") {
      generation.current = Symbol()
      completed.current.clear()
      return
    }
    if (
      !current.enabled ||
      (event.type !== "tool_call" && event.type !== "tool_call_update") ||
      (event.status !== "completed" && event.status !== "failed") ||
      completed.current.has(event.tool_call_id)
    ) {
      return
    }
    completed.current.add(event.tool_call_id)
    if (busy.current) return
    // Capture only messages already waiting at this boundary. Messages typed
    // during the round-trip wait for a later boundary; edits remain user-owned.
    const ids = current.getQueueItems().map((item) => item.id)
    if (ids.length === 0) return
    const admittedGeneration = generation.current
    busy.current = true
    void (async () => {
      try {
        for (const id of ids) {
          const next = latest.current
          if (!next.enabled || generation.current !== admittedGeneration) break
          if (next.editingItemId === id) break
          if (!next.getQueueItems().some((item) => item.id === id)) continue
          if (!(await next.onSteer(id))) break
        }
      } finally {
        busy.current = false
      }
    })().catch(() => {
      // The delivery owner presents failures and preserves the queued item.
    })
  })
}
