import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createBackendStoreStorage,
  defaultBackendStoreStorage,
} from "@/stores/backend-store-storage"
import {
  clearMessageInputDraftV2,
  loadMessageInputDraft,
  saveMessageInputDraft,
} from "@/lib/message-input-draft"

beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

describe("backend draft storage ownership", () => {
  it.each([1, 2])(
    "keeps A/B v%s drafts created after a default idle sweep was queued",
    (version) => {
      const idle: IdleRequestCallback[] = []
      vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
        idle.push(callback)
        return idle.length
      })
      const a = createBackendStoreStorage("remote:1")
      const b = createBackendStoreStorage("remote:2")
      const prefix = `codeg:message-input-draft:v${version}:`
      const legacy = defaultBackendStoreStorage.drafts
      const live = new Set<string>()
      const legacyLive = legacy.buildNewConversationDraftStorageKey("same-tab")
      const legacyOrphan = legacy.buildNewConversationDraftStorageKey("orphan")
      expect(legacyLive).toBe("draft:same-tab")
      localStorage.setItem(prefix + legacyLive, "legacy live")
      localStorage.setItem(prefix + legacyOrphan, "legacy orphan")
      localStorage.setItem(prefix + "conv:1", "conversation draft")
      localStorage.setItem(prefix + "new", "legacy shared draft")
      legacy.sweepOrphanDraftKeys(() => live)
      expect(idle).toHaveLength(1)

      // Scoped persistence can land while the default sweep waits for idle.
      live.add("same-tab")
      for (const storage of [a, b]) {
        for (const tabId of ["same-tab", "orphan"]) {
          localStorage.setItem(
            prefix + storage.drafts.buildNewConversationDraftStorageKey(tabId),
            `${storage.backendKey}:${tabId}`
          )
        }
      }
      idle[0]({} as IdleDeadline)
      expect(localStorage.getItem(prefix + legacyLive)).toBe("legacy live")
      expect(localStorage.getItem(prefix + legacyOrphan)).toBeNull()
      expect(localStorage.getItem(prefix + "conv:1")).toBe("conversation draft")
      expect(localStorage.getItem(prefix + "new")).toBe("legacy shared draft")
      for (const storage of [a, b]) {
        for (const tabId of ["same-tab", "orphan"]) {
          expect(
            localStorage.getItem(
              prefix + storage.drafts.buildNewConversationDraftStorageKey(tabId)
            )
          ).toBe(`${storage.backendKey}:${tabId}`)
        }
      }

      a.drafts.sweepOrphanDraftKeys(() => new Set(["same-tab"]))
      expect(
        localStorage.getItem(
          prefix + a.drafts.buildNewConversationDraftStorageKey("orphan")
        )
      ).toBeNull()
      expect(localStorage.getItem(prefix + legacyLive)).toBe("legacy live")
      expect(
        localStorage.getItem(
          prefix + a.drafts.buildNewConversationDraftStorageKey("same-tab")
        )
      ).toBe("remote:1:same-tab")
      for (const tabId of ["same-tab", "orphan"]) {
        expect(
          localStorage.getItem(
            prefix + b.drafts.buildNewConversationDraftStorageKey(tabId)
          )
        ).toBe(`remote:2:${tabId}`)
      }
      b.drafts.sweepOrphanDraftKeys(() => new Set())
      expect(
        localStorage.getItem(
          prefix + a.drafts.buildNewConversationDraftStorageKey("same-tab")
        )
      ).toBe("remote:1:same-tab")
      a.dispose()
      b.dispose()
    }
  )

  it("preserves default cache and pending-write cleanup without removing scoped writes", () => {
    const idle: IdleRequestCallback[] = []
    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
      idle.push(callback)
      return idle.length
    })
    const a = createBackendStoreStorage("remote:1")
    const legacyKey =
      defaultBackendStoreStorage.drafts.buildNewConversationDraftStorageKey(
        "cached-orphan"
      )
    const scopedKey =
      a.drafts.buildNewConversationDraftStorageKey("cached-orphan")
    saveMessageInputDraft(legacyKey, "saved legacy")
    saveMessageInputDraft(scopedKey, "saved scoped")
    idle.shift()!({} as IdleDeadline)
    saveMessageInputDraft(legacyKey, "pending legacy")
    saveMessageInputDraft(scopedKey, "pending scoped")
    defaultBackendStoreStorage.drafts.sweepOrphanDraftKeys(() => new Set())
    // Sweep first, then flush the already queued persistence callback.
    idle.pop()!({} as IdleDeadline)
    expect(loadMessageInputDraft(legacyKey)).toBeNull()
    expect(loadMessageInputDraft(scopedKey)).toBe("pending scoped")
    idle.shift()!({} as IdleDeadline)
    expect(
      localStorage.getItem(`codeg:message-input-draft:v1:${legacyKey}`)
    ).toBeNull()
    expect(
      localStorage.getItem(`codeg:message-input-draft:v1:${scopedKey}`)
    ).toBe(JSON.stringify({ text: "pending scoped" }))
    clearMessageInputDraftV2(scopedKey)
    a.dispose()
  })

  it("uses an exact encoded backend prefix for sweep, move and clear", () => {
    const a = createBackendStoreStorage("remote:2")
    const b = createBackendStoreStorage("remote:1:backend:remote:2")
    const from = a.drafts.buildNewConversationDraftStorageKey("same-tab")
    const to = a.drafts.buildNewConversationDraftStorageKey("replacement")
    const other = b.drafts.buildNewConversationDraftStorageKey("same-tab")
    expect(from).toBe("backend:remote%3A2:draft:same-tab")
    for (const version of [1, 2]) {
      const prefix = `codeg:message-input-draft:v${version}:`
      localStorage.setItem(prefix + from, `A v${version}`)
      localStorage.setItem(prefix + other, `B v${version}`)
    }
    a.drafts.moveMessageInputDraft(from, to)
    a.drafts.sweepOrphanDraftKeys(() => new Set(["replacement"]))
    for (const version of [1, 2]) {
      const prefix = `codeg:message-input-draft:v${version}:`
      expect(localStorage.getItem(prefix + from)).toBeNull()
      expect(localStorage.getItem(prefix + to)).toBe(`A v${version}`)
      expect(localStorage.getItem(prefix + other)).toBe(`B v${version}`)
    }
    a.drafts.clearMessageInputDraftV2(to)
    for (const version of [1, 2]) {
      const prefix = `codeg:message-input-draft:v${version}:`
      expect(localStorage.getItem(prefix + to)).toBeNull()
      expect(localStorage.getItem(prefix + other)).toBe(`B v${version}`)
    }
    a.dispose()
    b.dispose()
  })
})
