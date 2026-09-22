"use client"

import { useEffect } from "react"
import { getTransport, type Transport } from "@/lib/transport"
import { useAcademicStore } from "@/stores/academic-store"

interface Subscription {
  transport: Transport
  subscribers: number
  active: boolean
  stopEvents?: () => void
  stopReconnect?: () => void
}

/** The sidebar and workbench share one subscription to the active backend. */
let subscription: Subscription | null = null

function dispose(current: Subscription) {
  current.active = false
  current.stopEvents?.()
  current.stopReconnect?.()
}

export function useAcademicEvents() {
  useEffect(() => {
    const transport = getTransport()
    if (subscription?.transport !== transport) {
      if (subscription) dispose(subscription)
      subscription = null
    }
    if (!subscription) {
      const current: Subscription = {
        transport,
        subscribers: 0,
        active: true,
      }
      subscription = current
      const isCurrent = () =>
        current.active && current.transport === getTransport()
      current.stopReconnect = transport.onReconnect?.(() => {
        if (!isCurrent()) return
        void useAcademicStore.getState().loadSettings()
        // Library refresh also reconciles the selected paper: preparation can
        // finish while disconnected, and change events are not replayed.
        void useAcademicStore.getState().refreshLibrary()
      })
      void transport
        .subscribe<{ paper_id: string }>("academic://changed", (event) => {
          if (isCurrent())
            void useAcademicStore.getState().refreshPaper(event.paper_id)
        })
        .then((stop) => {
          if (!isCurrent()) stop()
          else {
            current.stopEvents = stop
            const paper = useAcademicStore.getState().selectedPaper
            if (paper) void useAcademicStore.getState().refreshPaper(paper.id)
          }
        })
        .catch((error: unknown) => {
          if (isCurrent()) {
            useAcademicStore.setState({
              error: error instanceof Error ? error.message : String(error),
            })
          }
        })
    }
    const current = subscription
    current.subscribers += 1
    return () => {
      current.subscribers -= 1
      if (current.subscribers === 0) {
        dispose(current)
        if (subscription === current) subscription = null
      }
    }
  }, [])
}
