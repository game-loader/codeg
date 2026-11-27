"use client"

/**
 * Whether the hidden assistants are listed (D6): off by default, kept on
 * this device. The sidebar's assistants and the page title's popover read
 * the one setting, and a change in either shows in both at once.
 */

import { useSyncExternalStore } from "react"
import { usePersonalAgentStorageKey } from "@/stores/personal-agent-ui-store"

const SHOW_HIDDEN_KEY = "pa:roster:show-hidden:v1"

function createFilter(key: string) {
  let value: boolean | null = null
  const listeners = new Set<() => void>()
  return {
    get() {
      if (value == null && typeof window !== "undefined") {
        try {
          value = localStorage.getItem(key) === "1"
        } catch {
          value = false
        }
      }
      return value ?? false
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(on: boolean) {
      value = on
      try {
        if (on) localStorage.setItem(key, "1")
        else localStorage.removeItem(key)
      } catch {
        // Keep the in-memory choice.
      }
      for (const listener of listeners) listener()
    },
    reset() {
      value = null
    },
  }
}

const standalone = createFilter(SHOW_HIDDEN_KEY)
const filters = new Map([[SHOW_HIDDEN_KEY, standalone]])
export const setShowHiddenAssistants = standalone.set

/** Whether the hidden assistants are listed, and the way to change it. */
export function useShowHiddenAssistants(): [boolean, (on: boolean) => void] {
  const key = usePersonalAgentStorageKey(SHOW_HIDDEN_KEY)
  let filter = filters.get(key)
  if (!filter) {
    filter = createFilter(key)
    filters.set(key, filter)
  }
  const on = useSyncExternalStore(filter.subscribe, filter.get, () => false)
  return [on, filter.set]
}

/** For tests: forget what was read. */
export function resetShowHiddenAssistantsForTest(): void {
  for (const filter of filters.values()) filter.reset()
}
