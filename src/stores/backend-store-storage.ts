import * as legacyClosedTabs from "@/lib/closed-tab-stack"
import type { ClosedWorkspaceTab } from "@/lib/closed-tab-stack"
import * as legacyContext from "@/lib/last-active-context-storage"
import type { LastActiveContext } from "@/lib/last-active-context-storage"
import * as legacyDrafts from "@/lib/message-input-draft"
import * as legacySelection from "@/lib/ask-selection-handoff"
import type {
  AskSelectionDrainState,
  ParkedAskPrompt,
} from "@/lib/ask-selection-handoff"
import * as legacySelectorPreferences from "@/lib/selector-prefs-storage"
import type { SessionModeStateInfo } from "@/lib/types"

/** Device-local resource state; callers can reuse these keys during migration. */
export function createBackendStoreStorage(backendKey: string) {
  let disposed = false
  const key = (base: string) => `${base}:backend:${backendKey}`
  function read(base: string): string | null {
    if (disposed || typeof window === "undefined") return null
    try {
      return localStorage.getItem(key(base))
    } catch {
      return null
    }
  }
  function write(base: string, value: string | null) {
    if (disposed || typeof window === "undefined") return
    try {
      if (value === null) localStorage.removeItem(key(base))
      else localStorage.setItem(key(base), value)
    } catch {
      /* device storage may be unavailable */
    }
  }
  let stack: ClosedWorkspaceTab[] = []
  try {
    const parsed: unknown = JSON.parse(read("workspace:closed-tabs:v1") ?? "[]")
    if (Array.isArray(parsed))
      stack = parsed
        .filter(
          (entry): entry is ClosedWorkspaceTab =>
            entry &&
            typeof entry === "object" &&
            typeof entry.key === "string" &&
            ["conversation", "file", "browser"].includes(entry.kind)
        )
        .slice(-legacyClosedTabs.CLOSED_TAB_STACK_LIMIT)
  } catch {
    /* ignore damaged restoration data */
  }
  const persistStack = () =>
    write("workspace:closed-tabs:v1", JSON.stringify(stack))
  const closedTabs = {
    pushClosedTab(tab: ClosedWorkspaceTab) {
      if (disposed) return
      stack = stack.filter((entry) => entry.key !== tab.key)
      stack.push(tab)
      stack = stack.slice(-legacyClosedTabs.CLOSED_TAB_STACK_LIMIT)
      persistStack()
    },
    popClosedTab(): ClosedWorkspaceTab | null {
      if (disposed) return null
      const tab = stack.pop() ?? null
      persistStack()
      return tab
    },
    peekClosedTab(): ClosedWorkspaceTab | null {
      return stack[stack.length - 1] ?? null
    },
    forgetClosedConversation(id: number) {
      if (disposed) return
      stack = stack.filter(
        (entry) => entry.kind !== "conversation" || entry.conversationId !== id
      )
      persistStack()
    },
    forgetClosedTabsInFolder(id: number) {
      if (disposed) return
      stack = stack.filter((entry) => entry.folderId !== id)
      persistStack()
    },
    resetClosedTabStackForTests() {
      stack = []
      persistStack()
    },
  }
  const parked = new Map<string, ParkedAskPrompt[]>()
  const askSelection = {
    parkAskSelectionPrompt(tabId: string, entry: ParkedAskPrompt) {
      if (disposed) return
      parked.set(tabId, [...(parked.get(tabId) ?? []), entry])
      if (typeof window !== "undefined")
        window.dispatchEvent(
          new CustomEvent(legacySelection.ASK_SELECTION_PARKED_EVENT, {
            detail: { tabId, backendKey },
          })
        )
    },
    consumeAskSelectionPrompts(
      tabId: string,
      state: AskSelectionDrainState
    ): string[] {
      const queued = parked.get(tabId) ?? []
      const matches = (entry: ParkedAskPrompt) =>
        entry.agentType === state.agentType && entry.folderId === state.folderId
      const held = queued.filter((entry) => !matches(entry))
      if (held.length) parked.set(tabId, held)
      else parked.delete(tabId)
      return queued.filter(matches).map((entry) => entry.prompt)
    },
    discardAskSelectionPrompts(tabId: string) {
      parked.delete(tabId)
    },
  }
  // Composer migration can use these exact keys. The factory never touches the
  // legacy composer module's pending writes or runs its realm-wide sweep.
  // Keep the scoped prefix outside `draft:`, which the default idle sweep owns.
  const draftPrefix = `backend:${encodeURIComponent(backendKey)}:draft:`
  const drafts = {
    buildNewConversationDraftStorageKey: (tabId: string) =>
      `${draftPrefix}${tabId}`,
    clearMessageInputDraftV2(draftKey: string) {
      if (disposed || typeof window === "undefined") return
      try {
        for (const version of [1, 2])
          localStorage.removeItem(
            `codeg:message-input-draft:v${version}:${draftKey}`
          )
      } catch {
        /* ignore storage failures */
      }
    },
    moveMessageInputDraft(fromKey: string, toKey: string) {
      if (disposed || typeof window === "undefined" || fromKey === toKey) return
      try {
        for (const version of [1, 2]) {
          const prefix = `codeg:message-input-draft:v${version}:`
          const value = localStorage.getItem(prefix + fromKey)
          if (value !== null) {
            localStorage.setItem(prefix + toKey, value)
            localStorage.removeItem(prefix + fromKey)
          }
        }
      } catch {
        /* retain the source if writing failed */
      }
    },
    sweepOrphanDraftKeys(live: () => Set<string>) {
      if (disposed || typeof window === "undefined") return
      try {
        const liveKeys = new Set(
          [...live()].map(drafts.buildNewConversationDraftStorageKey)
        )
        const stale: string[] = []
        for (let i = 0; i < localStorage.length; i++) {
          const stored = localStorage.key(i)
          if (!stored) continue
          for (const version of [1, 2]) {
            const prefix = `codeg:message-input-draft:v${version}:`
            if (
              stored.startsWith(prefix + draftPrefix) &&
              !liveKeys.has(stored.slice(prefix.length))
            )
              stale.push(stored)
          }
        }
        for (const stored of stale) localStorage.removeItem(stored)
      } catch {
        /* ignore storage failures */
      }
    },
  }
  type SelectorPreference = {
    modeId?: string
    configValues?: Record<string, string>
  }
  function readSelectorPreferences(): Record<string, SelectorPreference> {
    try {
      const value: unknown = JSON.parse(read("codeg:selector-prefs") ?? "{}")
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, SelectorPreference>)
        : {}
    } catch {
      return {}
    }
  }
  const selectorPreferences = {
    getSavedModeId(agentType: string): string | null {
      return readSelectorPreferences()[agentType]?.modeId ?? null
    },
    getSavedPrefsForConnect(agentType: string): {
      modeId: string | null
      configValues: Record<string, string> | null
    } {
      const prefs = readSelectorPreferences()[agentType]
      return {
        modeId: prefs?.modeId ?? null,
        configValues: prefs?.configValues ?? null,
      }
    },
    saveModePreference(agentType: string, modes: SessionModeStateInfo) {
      const all = readSelectorPreferences()
      all[agentType] = { ...all[agentType], modeId: modes.current_mode_id }
      write("codeg:selector-prefs", JSON.stringify(all))
    },
    saveConfigPreference(agentType: string, configId: string, valueId: string) {
      const all = readSelectorPreferences()
      const previous = all[agentType]
      all[agentType] = {
        ...previous,
        configValues: { ...previous?.configValues, [configId]: valueId },
      }
      write("codeg:selector-prefs", JSON.stringify(all))
    },
  }
  return {
    backendKey: backendKey as string | undefined,
    key,
    read,
    write,
    closedTabs,
    drafts,
    askSelection,
    selectorPreferences,
    loadLastActiveContext(): LastActiveContext | null {
      try {
        const value: unknown = JSON.parse(
          read("codeg:last-active-context:v1") ?? "null"
        )
        if (!value || typeof value !== "object") return null
        const ctx = value as Partial<LastActiveContext>
        return typeof ctx.folderId === "number" &&
          typeof ctx.isChat === "boolean"
          ? { folderId: ctx.folderId, isChat: ctx.isChat }
          : null
      } catch {
        return null
      }
    },
    saveLastActiveContext(ctx: LastActiveContext) {
      write("codeg:last-active-context:v1", JSON.stringify(ctx))
    },
    clearLastActiveContext() {
      write("codeg:last-active-context:v1", null)
    },
    dispose() {
      disposed = true
      stack = []
      parked.clear()
    },
  }
}

export type BackendStoreStorage = ReturnType<typeof createBackendStoreStorage>

/** Compatibility stays attached to the original standalone helper modules. */
export const defaultBackendStoreStorage: BackendStoreStorage = {
  backendKey: undefined,
  key: (base) => base,
  read: (base) => {
    try {
      return typeof window === "undefined" ? null : localStorage.getItem(base)
    } catch {
      return null
    }
  },
  write: (base, value) => {
    try {
      if (typeof window !== "undefined") {
        if (value === null) localStorage.removeItem(base)
        else localStorage.setItem(base, value)
      }
    } catch {
      /* ignore */
    }
  },
  closedTabs: legacyClosedTabs,
  drafts: legacyDrafts,
  askSelection: legacySelection,
  selectorPreferences: legacySelectorPreferences,
  ...legacyContext,
  dispose: () => {},
}
