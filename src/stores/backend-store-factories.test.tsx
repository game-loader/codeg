import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, renderHook, screen } from "@testing-library/react"
import type { BackendClient, BackendKey } from "@/lib/backend/types"
import {
  createBackendStores,
  defaultBackendStores,
  type BackendStores,
} from "@/lib/backend/stores"
import {
  BackendStoresProvider,
  useBackendStores,
} from "@/contexts/backend-stores-context"
import { createTabStore } from "@/stores/tab-store"
import { commandLinkKey } from "@/stores/command-terminal-link-store"
import { defaultBackendStoreStorage } from "@/stores/backend-store-storage"
import type {
  AcademicLibrary,
  AcademicPaper,
  AcademicSettings,
} from "@/lib/academic"
import type {
  CanvasBoard,
  CanvasBoardSummary,
  CanvasNode,
  CanvasSnapshot,
  DbConversationDetail,
  DbConversationSummary,
  FolderDetail,
  GitHeadInfo,
  OpenedTabsSnapshot,
  SaveTabsOutcome,
} from "@/lib/types"

const DATE = "2026-10-11T00:00:00Z"
const summary = (name: string): DbConversationSummary => ({
  id: 1,
  folder_id: 1,
  agent_type: "claude_code",
  title: name,
  title_locked: false,
  status: "completed",
  kind: "regular",
  model: null,
  git_branch: "main",
  external_id: "same-external-id",
  message_count: 1,
  child_count: 0,
  created_at: DATE,
  updated_at: DATE,
  pinned_at: null,
})
const folder = (name: string): FolderDetail => ({
  id: 1,
  path: "/same/repo",
  name,
  kind: "regular",
  git_branch: "main",
  default_agent_type: "claude_code",
  last_opened_at: DATE,
  sort_order: 0,
  color: "gray",
  parent_id: null,
  group_id: null,
  alias: null,
})
const detail = (name: string): DbConversationDetail => ({
  summary: summary(name),
  session_stats: null,
  turns: [
    {
      id: "same-turn",
      role: "assistant",
      timestamp: DATE,
      blocks: [{ type: "text", text: name }],
    },
  ],
})
const paper = (name: string) =>
  ({
    id: "same-paper",
    item_key: "same-item",
    title: name,
    status: "ready",
    conversations: [],
  }) as unknown as AcademicPaper
const library = (name: string): AcademicLibrary => ({
  library_id: 1,
  instance_id: name,
  collections: [],
  items: [],
})
const board = (name: string): CanvasBoard => ({
  id: 1,
  name,
  description: null,
  color: null,
  created_at: DATE,
  updated_at: DATE,
})
const boardSummary = (name: string): CanvasBoardSummary => ({
  board: board(name),
  node_count: 0,
  terminal_count: 0,
  preview: [],
})
const node = (name: string): CanvasNode => ({
  id: 1,
  board_id: 1,
  kind: "note",
  content: name,
  member_ids: [],
  folder_id: null,
  folder_group_id: null,
  agent_type: null,
  conversation_id: null,
  title: null,
  path: null,
  color: null,
  collapsed: false,
  grid_columns: 0,
  grid_rows: 0,
  x: 0,
  y: 0,
  width: 200,
  height: 140,
  created_at: DATE,
  updated_at: DATE,
})
const snapshot = (name: string): CanvasSnapshot => ({
  board_id: 1,
  revision: 0,
  nodes: [node(name)],
})
const tabSnapshot = (): OpenedTabsSnapshot => ({
  version: 1,
  items: [
    {
      id: 1,
      folder_id: 1,
      conversation_id: 1,
      agent_type: "claude_code",
      position: 0,
      is_active: true,
      is_pinned: true,
    },
  ],
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const owned: BackendStores[] = []
function backend(key: BackendKey, name: string) {
  const api = {
    listOpenFolderDetails: vi.fn(async () => [folder(name)]),
    listAllFolderDetails: vi.fn(async () => [folder(name)]),
    listFolderGroups: vi.fn(async () => []),
    listAllConversations: vi.fn(async () => [summary(name)]),
    getGitHead: vi.fn(
      async (): Promise<GitHeadInfo> => ({
        is_repo: true,
        branch: name,
        detached: false,
        short_sha: "1234567",
      })
    ),
    getFolderConversation: vi.fn(
      async (): Promise<DbConversationDetail> => detail(name)
    ),
    getFolderConversationTurns: vi.fn(),
    listOpenedTabs: vi.fn(
      async (): Promise<OpenedTabsSnapshot> => tabSnapshot()
    ),
    saveOpenedTabs: vi.fn<BackendClient["api"]["saveOpenedTabs"]>(
      async (): Promise<SaveTabsOutcome> => ({
        accepted: true,
        version: 2,
        tabs: tabSnapshot().items,
      })
    ),
    openFolder: vi.fn(async () => folder(name)),
    canvasListNodes: vi.fn(async (): Promise<CanvasSnapshot> => snapshot(name)),
    canvasListBoards: vi.fn(async () => [boardSummary(name)]),
  }
  const academic = {
    academicLibrary: vi.fn(async () => library(name)),
    academicSelect: vi.fn(async () => paper(name)),
    academicPaperGet: vi.fn(async () => paper(name)),
    academicSettingsGet: vi.fn(
      async (): Promise<AcademicSettings> => ({
        agent_type: "claude_code",
        bridge_port: 23119,
        paired: true,
      })
    ),
  }
  // Frozen API namespaces match real clients and catch accidental Proxy invariants.
  const client = {
    key,
    name,
    api: Object.freeze(api),
    academic: Object.freeze(academic),
  } as unknown as BackendClient
  const stores = createBackendStores(client)
  owned.push(stores)
  return { client, api, academic, stores }
}

beforeEach(() => {
  localStorage.clear()
})
afterEach(() => {
  for (const stores of owned.splice(0)) stores.dispose()
  vi.useRealTimers()
})

describe("backend store factories", () => {
  it("owns callable stores, module-like helper namespaces and explicit tab dependencies", () => {
    const { stores } = backend("remote:1", "A")
    for (const store of [
      stores.workspace,
      stores.tabs,
      stores.conversationRuntime,
      stores.academic,
      stores.canvas,
      stores.canvasBoards,
      stores.commandTerminalLinks,
      stores.forgeRefresh,
    ]) {
      expect(typeof store).toBe("function")
      expect(typeof store.getState).toBe("function")
      expect(typeof store.subscribe).toBe("function")
    }
    expect(stores.tabs.conversationRuntime).toBe(stores.conversationRuntime)
    expect(stores.conversationRuntime.useConversationRuntimeStore).toBe(
      stores.conversationRuntime
    )
    expect(stores.workspace).not.toBe(defaultBackendStores.workspace)
  })

  it("isolates conversation/folder tombstones and the workspace-to-tab subscription for duplicate IDs", async () => {
    const a = backend("remote:1", "A").stores
    const b = backend("remote:2", "B").stores
    await Promise.all([
      a.workspace.getState().fetchFolders(),
      b.workspace.getState().fetchFolders(),
      a.workspace.getState().refreshConversations(),
      b.workspace.getState().refreshConversations(),
    ])
    a.tabs.getState().hydrate()
    b.tabs.getState().hydrate()
    await settle()
    expect(a.tabs.getState().tabs[0].title).toBe("A")
    expect(b.tabs.getState().tabs[0].title).toBe("B")
    a.workspace.getState().setActiveFolderId(1)
    b.workspace.getState().setActiveFolderId(1)
    a.workspace.getState().applyConversationRemove(1)
    a.workspace.getState().applyConversationUpsert(summary("deleted"))
    b.workspace.getState().applyConversationUpsert(summary("B updated"))
    expect(a.workspace.isConversationDeleted(1)).toBe(true)
    expect(b.workspace.isConversationDeleted(1)).toBe(false)
    expect(a.workspace.getState().conversations).toEqual([])
    expect(b.tabs.getState().tabs[0].title).toBe("B updated")
    a.workspace.getState().applyFolderRemove(1)
    expect(b.workspace.getState().allFolders[0].path).toBe("/same/repo")
    expect(defaultBackendStores.workspace.isConversationDeleted(1)).toBe(false)
  })

  it("keeps independent HEAD deduplication and late folder/conversation responses", async () => {
    const a = backend("remote:1", "A")
    const b = backend("remote:2", "B")
    const folders = deferred<FolderDetail[]>()
    const conversations = deferred<DbConversationSummary[]>()
    a.api.listAllFolderDetails.mockReturnValueOnce(folders.promise)
    a.api.listAllConversations.mockReturnValueOnce(conversations.promise)
    const pendingFolders = a.stores.workspace.getState().fetchFolders()
    const pendingConversations = a.stores.workspace
      .getState()
      .refreshConversations()
    await b.stores.workspace.getState().fetchFolders()
    a.stores.workspace.getState().applyFolderRemove(1)
    a.stores.workspace.getState().applyConversationRemove(1)
    folders.resolve([folder("late A")])
    conversations.resolve([summary("late A")])
    await Promise.all([pendingFolders, pendingConversations])
    expect(a.stores.workspace.getState().allFolders).toEqual([])
    expect(a.stores.workspace.getState().conversations).toEqual([])
    for (const instance of [a, b]) {
      instance.stores.workspace.getState().ensureGitHead(1, "/same/repo")
      instance.stores.workspace.getState().ensureGitHead(1, "/same/repo")
    }
    await settle()
    expect(a.api.getGitHead).toHaveBeenCalledTimes(1)
    expect(b.api.getGitHead).toHaveBeenCalledTimes(1)
    expect(a.stores.workspace.getState().branches.get(1)).toBe("A")
    expect(b.stores.workspace.getState().branches.get(1)).toBe("B")
  })

  it("isolates runtime external IDs, cached timelines, claims and release timers", async () => {
    vi.useFakeTimers()
    const a = backend("remote:1", "A")
    const b = backend("remote:2", "B")
    for (const instance of [a, b])
      instance.stores.conversationRuntime.getState().actions.fetchDetail(1)
    await settle()
    const ra = a.stores.conversationRuntime
    const rb = b.stores.conversationRuntime
    ra.getState().actions.setExternalId(1, "same-external-id")
    rb.getState().actions.setExternalId(1, "same-external-id")
    expect(ra.getConversationIdByExternalIdFromStore("same-external-id")).toBe(
      1
    )
    expect(rb.getConversationIdByExternalIdFromStore("same-external-id")).toBe(
      1
    )
    const timelineA = ra.getTimelineTurns(1)
    const timelineB = rb.getTimelineTurns(1)
    expect(timelineA).toBe(ra.selectTimelineTurns(ra.getState(), 1))
    expect(timelineB).not.toBe(timelineA)
    expect(timelineB[0].turn.blocks).toEqual([{ type: "text", text: "B" }])
    ra.releaseRuntimeSession(1)
    rb.claimRuntimeSession(1)
    await vi.runAllTimersAsync()
    expect(ra.getRuntimeSession(1)).toBeNull()
    expect(rb.getRuntimeSession(1)?.detail?.summary.title).toBe("B")
  })

  it("isolates mounted tab view refs and injected callbacks", async () => {
    const a = backend("remote:1", "A").stores
    const b = backend("remote:2", "B").stores
    a.tabs.getState().hydrate()
    b.tabs.getState().hydrate()
    await settle()
    const tabId = a.tabs.getState().rawTabs[0].id
    const tabIdB = b.tabs.getState().rawTabs[0].id
    expect(tabId).not.toBe(tabIdB)
    const releaseA = a.tabs.trackConversationView(tabId, "departing", -10)
    const releaseB = b.tabs.trackConversationView(tabIdB, "departing", -20)
    expect(
      a.tabs.reparentedViewRuntimeConversationId(a.tabs.getState(), tabId)
    ).toBe(-10)
    expect(
      b.tabs.reparentedViewRuntimeConversationId(b.tabs.getState(), tabIdB)
    ).toBe(-20)
    releaseA()
    expect(
      b.tabs.reparentedViewRuntimeConversationId(b.tabs.getState(), tabIdB)
    ).toBe(-20)
    releaseB()
    const activateA = vi.fn(),
      activateB = vi.fn()
    a.tabs.getState().setSideEffects({
      activateConversationPane: activateA,
      acpDisconnect: async () => {},
    })
    b.tabs.getState().setSideEffects({
      activateConversationPane: activateB,
      acpDisconnect: async () => {},
    })
    a.tabs.getState().switchTab(tabId)
    expect(activateA).toHaveBeenCalledOnce()
    expect(activateB).not.toHaveBeenCalled()
  })

  it("isolates academic library, paper selection and settings for matching IDs", async () => {
    const a = backend("remote:1", "A")
    const b = backend("remote:2", "B")
    const pending = deferred<AcademicPaper>()
    a.academic.academicSelect.mockReturnValueOnce(pending.promise)
    const selecting = a.stores.academic.getState().selectItem("same-item")
    await Promise.all([
      b.stores.academic.getState().selectItem("same-item"),
      a.stores.academic.getState().refreshLibrary(),
      b.stores.academic.getState().refreshLibrary(),
      a.stores.academic.getState().loadSettings(),
    ])
    expect(b.stores.academic.getState().selectedPaper?.title).toBe("B")
    a.stores.academic.getState().reset()
    pending.resolve(paper("late A"))
    await selecting
    expect(a.stores.academic.getState().selectedPaper).toBeNull()
    expect(b.stores.academic.getState().selectedPaper?.title).toBe("B")
    expect(b.stores.academic.getState().library?.instance_id).toBe("B")
    expect(a.academic.academicPaperGet).not.toHaveBeenCalled()
    expect(b.academic.academicPaperGet).toHaveBeenCalledWith("same-paper")
  })

  it("isolates canvas snapshots, write marks and board tombstones", async () => {
    const a = backend("remote:1", "A").stores
    const b = backend("remote:2", "B").stores
    a.canvas.getState().openBoard(1)
    b.canvas.getState().openBoard(1)
    await Promise.all([
      a.canvas.getState().refetch(),
      b.canvas.getState().refetch(),
      a.canvasBoards.getState().refetch(),
      b.canvasBoards.getState().refetch(),
    ])
    const endA = a.canvas.beginContentWrite(1)
    const endB = b.canvas.beginContentWrite(1)
    endA()
    expect(a.canvas.hasContentWriteInFlight(1)).toBe(false)
    expect(b.canvas.hasContentWriteInFlight(1)).toBe(true)
    a.canvas.getState().handleCanvasChanged({
      kind: "upsert",
      revision: 1,
      node: node("A changed"),
    })
    a.canvasBoards.getState().removeBoard(1, a.canvasBoards.getState().scope())
    b.canvasBoards
      .getState()
      .handleBoardChanged({ kind: "upsert", board: board("B changed") })
    expect(a.canvas.getState().nodes.get(1)?.content).toBe("A changed")
    expect(b.canvas.getState().nodes.get(1)?.content).toBe("B")
    expect(a.canvasBoards.getState().boards).toEqual([])
    expect(b.canvasBoards.getState().boards[0].board.name).toBe("B changed")
    endB()
  })

  it("namespaces group layouts, closed stacks, draft cleanup, folder/model preferences and restoration", async () => {
    const a = backend("remote:1", "A").stores
    const b = backend("remote:2", "B").stores
    a.tabs.getState().hydrate()
    b.tabs.getState().hydrate()
    await settle()
    const tabId = a.tabs.getState().rawTabs[0].id
    a.tabs.getState().splitTab(tabId, "right", { move: false })
    expect(a.tabs.selectIsSplit(a.tabs.getState())).toBe(true)
    expect(b.tabs.selectIsSplit(b.tabs.getState())).toBe(false)
    a.tabs.getState().closeTab(tabId)
    b.tabs.getState().closeTab(b.tabs.getState().rawTabs[0].id)
    a.workspace.getState().applyConversationRemove(1)
    expect(a.storage.closedTabs.peekClosedTab()).toBeNull()
    expect(b.storage.closedTabs.peekClosedTab()?.kind).toBe("conversation")
    for (const stores of [a, b]) {
      stores.storage.saveLastActiveContext({ folderId: 1, isChat: false })
      stores.storage.write(
        "selector-prefs:folder:1:model",
        stores === a ? "A model" : "B model"
      )
      stores.storage.selectorPreferences.saveConfigPreference(
        "claude_code",
        "model",
        stores === a ? "A model" : "B model"
      )
      const draftKey =
        stores.storage.drafts.buildNewConversationDraftStorageKey("same-draft")
      localStorage.setItem(
        `codeg:message-input-draft:v2:${draftKey}`,
        JSON.stringify({ doc: { type: "doc" } })
      )
    }
    a.storage.drafts.sweepOrphanDraftKeys(() => new Set())
    expect(
      localStorage.getItem(
        `codeg:message-input-draft:v2:${b.storage.drafts.buildNewConversationDraftStorageKey("same-draft")}`
      )
    ).not.toBeNull()
    const groupBlobB = localStorage.getItem(
      b.storage.key("workspace:tab-groups:v1")
    )
    a.dispose()
    expect(localStorage.getItem(b.storage.key("workspace:tab-groups:v1"))).toBe(
      groupBlobB
    )
    const reopened = backend("remote:2", "B restored").stores
    expect(reopened.storage.closedTabs.peekClosedTab()?.kind).toBe(
      "conversation"
    )
    expect(reopened.storage.loadLastActiveContext()?.folderId).toBe(1)
    expect(reopened.storage.read("selector-prefs:folder:1:model")).toBe(
      "B model"
    )
    expect(
      reopened.storage.selectorPreferences.getSavedPrefsForConnect(
        "claude_code"
      ).configValues?.model
    ).toBe("B model")
    expect(localStorage.getItem("codeg:selector-prefs")).toBeNull()
    expect(localStorage.getItem("workspace:tab-groups:v1")).toBeNull()
  })

  it("isolates command/terminal IDs, forge callbacks and parked selection prompts", () => {
    const a = backend("remote:1", "A").stores
    const b = backend("remote:2", "B").stores
    a.commandTerminalLinks
      .getState()
      .setLink(commandLinkKey(7, 1), "same-terminal")
    b.commandTerminalLinks
      .getState()
      .setLink(commandLinkKey(7, 1), "same-terminal")
    a.commandTerminalLinks.getState().clearLink(commandLinkKey(7, 1))
    expect(b.commandTerminalLinks.getState().links[commandLinkKey(7, 1)]).toBe(
      "same-terminal"
    )
    const refresh = vi.fn()
    b.forgeRefresh.getState().publish({ refresh, busy: true })
    a.forgeRefresh.getState().withdraw()
    expect(b.forgeRefresh.getState().refresh).toBe(refresh)
    for (const stores of [a, b])
      stores.storage.askSelection.parkAskSelectionPrompt("same-tab", {
        prompt: stores === a ? "A prompt" : "B prompt",
        agentType: "claude_code",
        folderId: 1,
      })
    a.storage.askSelection.discardAskSelectionPrompts("same-tab")
    expect(
      b.storage.askSelection.consumeAskSelectionPrompts("same-tab", {
        agentType: "claude_code",
        folderId: 1,
      })
    ).toEqual(["B prompt"])
  })

  it.each(["remote:1", "remote:2"] as const)(
    "migrates old conversation group IDs for %s while retaining draft IDs",
    async (backendKey) => {
      const prefix = `host-${encodeURIComponent(backendKey)}:`
      const first = "conv-1-claude_code-1"
      const second = "conv-1-claude_code-2"
      const draft = "new-preserved"
      const layout = {
        type: "split",
        id: "split-restored",
        orientation: "horizontal",
        ratios: [0.5, 0.5],
        children: [
          { type: "group", id: "left" },
          { type: "group", id: "right" },
        ],
      }
      localStorage.setItem(
        `workspace:tab-groups:v1:backend:${backendKey}`,
        JSON.stringify({
          layout,
          assignments: {
            [first]: "left",
            // An already qualified assignment wins over an old duplicate.
            [prefix + second]: "left",
            [second]: "right",
            [draft]: "right",
          },
          selection: { left: second, right: draft },
          tileByGroup: { left: true, right: false },
          drafts: [
            {
              id: draft,
              group: "right",
              index: 2,
              folderId: 1,
              agentType: "claude_code",
            },
          ],
          activeDraft: draft,
        })
      )
      const a = backend(backendKey, "restored")
      const tabs = a.stores.tabs
      expect(tabs.getState().groupOf).toEqual({
        [prefix + first]: "left",
        [prefix + second]: "left",
        [draft]: "right",
      })
      expect(tabs.getState().groupSelection).toEqual({
        left: prefix + second,
        right: draft,
      })
      const snap = tabSnapshot()
      a.api.listOpenedTabs.mockResolvedValueOnce({
        ...snap,
        items: [
          ...snap.items,
          {
            ...snap.items[0],
            id: 2,
            conversation_id: 2,
            is_active: false,
            position: 1,
          },
        ],
      })
      tabs.getState().hydrate()
      await settle()
      expect(tabs.getState().rawTabs.map((tab) => tab.id)).toEqual([
        prefix + first,
        prefix + second,
        draft,
      ])
      expect(tabs.getState().groupLayout).toEqual(layout)
      expect(tabs.getState().groupSelection).toEqual({
        left: prefix + second,
        right: draft,
      })
      expect(tabs.getState().activeTabId).toBe(draft)
      const persisted = JSON.parse(
        localStorage.getItem(a.stores.storage.key("workspace:tab-groups:v1"))!
      )
      expect(persisted.assignments).toEqual({
        [prefix + first]: "left",
        [prefix + second]: "left",
      })
      expect(persisted.selection).toEqual(tabs.getState().groupSelection)
      expect(persisted.drafts[0].id).toBe(draft)
      expect(persisted.activeDraft).toBe(draft)
      a.stores.dispose()
      const reopened = backend(backendKey, "reopened").stores
      expect(reopened.tabs.getState().groupOf).toEqual(persisted.assignments)
      expect(reopened.tabs.getState().groupSelection).toEqual(
        persisted.selection
      )
    }
  )

  it("keeps default tab IDs and persisted selections unprefixed", async () => {
    const a = backend("remote:1", "legacy dependencies")
    const tabId = "conv-1-claude_code-1"
    localStorage.setItem(
      "workspace:tab-groups:v1",
      JSON.stringify({
        layout: { type: "group", id: "legacy" },
        assignments: { [tabId]: "legacy" },
        selection: { legacy: tabId },
      })
    )
    const tabs = createTabStore(
      a.client.api,
      defaultBackendStoreStorage,
      a.stores.workspace,
      a.stores.conversationRuntime
    )
    try {
      tabs.getState().hydrate()
      await settle()
      expect(tabs.getState().rawTabs[0].id).toBe(tabId)
      expect(tabs.getState().groupOf).toEqual({ [tabId]: "legacy" })
      expect(tabs.getState().groupSelection).toEqual({ legacy: tabId })
      const draft = tabs.getState().openNewConversationTab(1, "/same/repo")
      expect(draft.tabId).toMatch(/^new-/)
    } finally {
      tabs.dispose()
    }
  })

  it("rejects old requests across reset even when the conversation ID and generation counter are reused", async () => {
    const a = backend("remote:1", "A")
    const first = deferred<DbConversationDetail>()
    const second = deferred<DbConversationDetail>()
    a.api.getFolderConversation
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const runtime = a.stores.conversationRuntime
    runtime.getState().actions.fetchDetail(1)
    runtime.resetConversationRuntimeStore()
    runtime.getState().actions.fetchDetail(1)
    first.resolve(detail("old"))
    await settle()
    expect(runtime.getRuntimeSession(1)?.detail).toBeNull()
    second.resolve(detail("new"))
    await settle()
    expect(runtime.getRuntimeSession(1)?.detail?.summary.title).toBe("new")
  })

  it("rejects a folder continuation that was already queued when reset changed its epoch", async () => {
    const a = backend("remote:1", "A")
    const pending = deferred<FolderDetail>()
    a.api.openFolder.mockReturnValueOnce(pending.promise)
    const opening = a.stores.workspace.getState().openFolder("/same/repo")
    pending.resolve(folder("old"))
    await Promise.resolve()
    a.stores.workspace.resetAppWorkspaceStore()
    await expect(opening).rejects.toMatchObject({ name: "StaleStoreRequest" })
    expect(a.stores.workspace.getState().allFolders).toEqual([])
    expect(a.api.listAllConversations).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    "rejects a queued tab-save continuation after reset (CAS accepted: %s)",
    async (accepted) => {
      vi.useFakeTimers()
      const a = backend("remote:1", "A")
      const pending = deferred<SaveTabsOutcome>()
      a.api.saveOpenedTabs.mockReturnValueOnce(pending.promise)
      const tabs = a.stores.tabs
      tabs.getState().hydrate()
      await settle()
      tabs.getState().openTab(1, 2, "claude_code", true)
      tabs.getState().runSaveEffect()
      await vi.advanceTimersByTimeAsync(500)
      expect(a.api.saveOpenedTabs).toHaveBeenCalledOnce()
      const sentItems = a.api.saveOpenedTabs.mock.calls[0][0]
      pending.resolve({ accepted, version: 100, tabs: sentItems })
      // The forwarding reaction passes its guard first. Reset then runs before
      // the store's .then continuation, which is a separate queued microtask.
      await Promise.resolve()
      tabs.resetTabStore()
      const resetState = tabs.getState()
      const groupKey = a.stores.storage.key("workspace:tab-groups:v1")
      const resetBlob = localStorage.getItem(groupKey)
      await settle()
      expect(tabs.getState()).toBe(resetState)
      expect(localStorage.getItem(groupKey)).toBe(resetBlob)

      // The identical payload must still save in the new generation, against
      // reset's version zero; old baselines/versions must not suppress it.
      tabs.setState({ tabsHydrated: true })
      tabs.getState().openTab(1, 1, "claude_code", true)
      tabs.getState().openTab(1, 2, "claude_code", true)
      tabs.getState().runSaveEffect()
      await vi.advanceTimersByTimeAsync(500)
      expect(a.api.saveOpenedTabs).toHaveBeenCalledTimes(2)
      expect(a.api.saveOpenedTabs.mock.calls[1][0]).toEqual(sentItems)
      expect(a.api.saveOpenedTabs.mock.calls[1][1]).toBe(0)
    }
  )

  it.each([false, true])(
    "rejects a queued refetch after reset (new generation hydrated: %s)",
    async (hydrated) => {
      const a = backend("remote:1", "A")
      const tabs = a.stores.tabs
      tabs.getState().hydrate()
      await settle()
      const pending = deferred<OpenedTabsSnapshot>()
      a.api.listOpenedTabs.mockReturnValueOnce(pending.promise)
      const refetching = tabs.getState().refetchTabs()
      pending.resolve({
        version: 100,
        items: [{ ...tabSnapshot().items[0], conversation_id: 2 }],
      })
      await Promise.resolve()
      tabs.resetTabStore()
      if (hydrated) tabs.setState({ tabsHydrated: true })
      const resetState = tabs.getState()
      await refetching
      expect(tabs.getState()).toBe(resetState)
      // A stale unhydrated refetch could hide in pendingRemote until the next
      // hydration. Only that generation's fresh server snapshot may be applied.
      tabs.getState().hydrate()
      await settle()
      expect(tabs.getState().rawTabs.map((tab) => tab.conversationId)).toEqual([
        1,
      ])
      expect(tabs.getState().consumeRemoteActivation()).toBe(false)
    }
  )

  it("does not let a pre-reset child seed clear the new in-flight entry for the same ID", async () => {
    const a = backend("remote:1", "A")
    const oldSeed = deferred<DbConversationDetail>()
    const newSeed = deferred<DbConversationDetail>()
    a.api.getFolderConversation
      .mockReturnValueOnce(oldSeed.promise)
      .mockReturnValueOnce(newSeed.promise)
    a.stores.workspace.setState({ conversationsLoading: false })
    a.stores.tabs.getState().openTab(1, 1, "claude_code", true)
    a.stores.tabs.getState().reconcileChildSummaries()
    a.stores.tabs.resetTabStore()
    a.stores.tabs.getState().openTab(1, 1, "claude_code", true)
    a.stores.tabs.getState().reconcileChildSummaries()
    oldSeed.resolve(detail("old"))
    await settle()
    a.stores.tabs.getState().reconcileChildSummaries()
    expect(a.api.getFolderConversation).toHaveBeenCalledTimes(2)
    newSeed.resolve(detail("new"))
    await settle()
    expect(a.stores.tabs.getState().childSummaries.get(1)?.title).toBe("new")
  })

  it("disposes every pending fetch without stale writes, retries or effects on B", async () => {
    vi.useFakeTimers()
    const a = backend("remote:1", "A")
    const b = backend("remote:2", "B")
    const folders = deferred<FolderDetail[]>(),
      conversations = deferred<DbConversationSummary[]>(),
      transcript = deferred<DbConversationDetail>(),
      academicPaper = deferred<AcademicPaper>(),
      academicLibrary = deferred<AcademicLibrary>(),
      nodes = deferred<CanvasSnapshot>(),
      boards = deferred<CanvasBoardSummary[]>(),
      tabs = deferred<OpenedTabsSnapshot>()
    a.api.listAllFolderDetails.mockReturnValueOnce(folders.promise)
    a.api.listAllConversations.mockReturnValueOnce(conversations.promise)
    a.api.getFolderConversation.mockReturnValueOnce(transcript.promise)
    a.academic.academicSelect.mockReturnValueOnce(academicPaper.promise)
    a.academic.academicLibrary.mockReturnValueOnce(academicLibrary.promise)
    a.api.canvasListNodes.mockReturnValueOnce(nodes.promise)
    a.api.canvasListBoards.mockReturnValueOnce(boards.promise)
    a.api.listOpenedTabs.mockReturnValueOnce(tabs.promise)
    const pending = [
      a.stores.workspace.getState().fetchFolders(),
      a.stores.workspace.getState().refreshConversations(),
      a.stores.academic.getState().selectItem("same-item"),
      a.stores.academic.getState().refreshLibrary(),
      a.stores.canvasBoards.getState().refetch(),
    ]
    a.stores.conversationRuntime.getState().actions.fetchDetail(1)
    a.stores.tabs.getState().hydrate()
    a.stores.canvas.getState().openBoard(1)
    pending.push(a.stores.canvas.getState().refetch())
    await b.stores.workspace.getState().refreshConversations()
    a.stores.dispose()
    a.stores.dispose()
    const workspaceAfterDispose = a.stores.workspace.getState()
    folders.resolve([folder("late")])
    conversations.resolve([summary("late")])
    transcript.resolve(detail("late"))
    academicPaper.resolve(paper("late"))
    academicLibrary.resolve(library("late"))
    nodes.reject(new Error("late network failure"))
    boards.resolve([boardSummary("late")])
    tabs.resolve(tabSnapshot())
    await Promise.all(pending)
    await settle()
    await vi.runAllTimersAsync()
    expect(a.stores.workspace.getState()).toBe(workspaceAfterDispose)
    expect(a.stores.tabs.getState().rawTabs).toEqual([])
    expect(a.stores.tabs.getState().tabsHydrated).toBe(false)
    expect(a.stores.conversationRuntime.getRuntimeSession(1)).toBeNull()
    expect(a.stores.academic.getState().selectedPaper).toBeNull()
    expect(a.stores.academic.getState().library).toBeNull()
    expect(a.stores.canvas.getState().boardId).toBeNull()
    expect(a.stores.canvasBoards.getState().boards).toEqual([])
    expect(a.api.canvasListNodes).toHaveBeenCalledTimes(1)
    expect(b.stores.workspace.getState().conversations[0].title).toBe("B")
    expect(vi.getTimerCount()).toBe(0)
    a.stores.workspace.getState().setActiveFolderId(99)
    a.stores.workspace.setState({ activeFolderId: 99 })
    expect(a.stores.workspace.getState()).toBe(workspaceAfterDispose)
  })

  it("cancels save/group/release/viewer/metadata timers and unsubscribes only the disposed tabs", async () => {
    vi.useFakeTimers()
    const a = backend("remote:1", "A")
    const b = backend("remote:2", "B")
    for (const instance of [a, b]) {
      instance.stores.workspace
        .getState()
        .applyConversationUpsert(summary(instance.client.name))
      instance.stores.tabs.getState().hydrate()
      instance.stores.conversationRuntime.getState().actions.fetchDetail(1)
    }
    await settle()
    a.stores.tabs.getState().openTab(1, 2, "claude_code", true)
    const focused = a.stores.tabs.getState().activeTabId!
    a.stores.tabs.getState().splitTab(focused, "right", { move: false })
    const layout = a.stores.tabs.getState().groupLayout
    if (layout.type !== "split") throw new Error("Expected a split layout")
    a.stores.tabs.getState().resizeGroupSplit(layout.id, 0, 0.6)
    a.stores.tabs.getState().runSaveEffect()
    a.stores.conversationRuntime.releaseRuntimeSession(1)
    a.stores.conversationRuntime.getState().actions.syncTurnMetadata(1)
    a.api.getFolderConversation.mockResolvedValueOnce({
      ...detail("A"),
      turns: [
        {
          id: "user",
          role: "user",
          timestamp: DATE,
          blocks: [{ type: "text", text: "unfinished" }],
        },
      ],
    })
    a.stores.conversationRuntime.getState().actions.syncViewerDetail(1)
    await settle()
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(5)
    a.stores.dispose()
    const disposedTabs = a.stores.tabs.getState()
    a.stores.workspace.getState().applyConversationUpsert(summary("ignored"))
    b.stores.workspace.getState().applyConversationUpsert(summary("B updated"))
    await vi.runAllTimersAsync()
    expect(a.api.saveOpenedTabs).not.toHaveBeenCalled()
    expect(a.stores.tabs.getState()).toBe(disposedTabs)
    expect(b.stores.tabs.getState().tabs[0].title).toBe("B updated")
    expect(b.stores.conversationRuntime.getRuntimeSession(1)).not.toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("releases the workspace subscription owned by a tab factory", () => {
    const a = backend("remote:1", "A")
    const originalSubscribe = a.stores.workspace.subscribe
    const unsubscribe = vi.fn()
    vi.spyOn(a.stores.workspace, "subscribe").mockImplementation((listener) => {
      const stop = originalSubscribe(listener)
      return () => {
        stop()
        unsubscribe()
      }
    })
    const tabs = createTabStore(
      a.client.api,
      a.stores.storage,
      a.stores.workspace,
      a.stores.conversationRuntime
    )
    tabs.dispose()
    tabs.dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it("does not submit follow-up reads after a disposed folder-open operation resolves", async () => {
    const a = backend("remote:1", "A")
    const pending = deferred<FolderDetail>()
    a.api.openFolder.mockReturnValueOnce(pending.promise)
    const opening = a.stores.workspace.getState().openFolder("/same/repo")
    a.stores.dispose()
    pending.resolve(folder("late"))
    await expect(opening).rejects.toMatchObject({ name: "StaleStoreRequest" })
    expect(a.api.listAllConversations).not.toHaveBeenCalled()
    expect(a.stores.workspace.getState().allFolders).toEqual([])
  })

  it("drops an in-flight tab save when the same backend key gets a replacement runtime", async () => {
    vi.useFakeTimers()
    const a = backend("remote:1", "A")
    const pendingSave = deferred<SaveTabsOutcome>()
    a.api.saveOpenedTabs.mockReturnValueOnce(pendingSave.promise)
    a.stores.tabs.getState().hydrate()
    await settle()
    a.stores.tabs.getState().openTab(1, 2, "claude_code", true)
    a.stores.tabs.getState().runSaveEffect()
    await vi.advanceTimersByTimeAsync(500)
    expect(a.api.saveOpenedTabs).toHaveBeenCalledOnce()
    a.stores.dispose()
    const replacement = backend("remote:1", "replacement").stores
    replacement.tabs.getState().hydrate()
    await settle()
    const state = replacement.tabs.getState()
    const persisted = localStorage.getItem(
      replacement.storage.key("workspace:tab-groups:v1")
    )
    pendingSave.resolve({ accepted: false, version: 100, tabs: [] })
    await settle()
    expect(replacement.tabs.getState()).toBe(state)
    expect(
      localStorage.getItem(replacement.storage.key("workspace:tab-groups:v1"))
    ).toBe(persisted)
    expect(a.stores.tabs.getState().rawTabs).toEqual([])
  })

  it("provides the default singleton without a provider and retains both runtimes when providers switch", () => {
    const a = backend("remote:1", "A").stores
    const b = backend("remote:2", "B").stores
    expect(renderHook(() => useBackendStores()).result.current).toBe(
      defaultBackendStores
    )
    function Selection() {
      const current = useBackendStores()
      const activeFolder = current.workspace((state) => state.activeFolderId)
      return (
        <span
          data-testid="active-folder"
          data-backend={current === a ? "a" : "b"}
        >
          {activeFolder}
        </span>
      )
    }
    const { rerender, unmount } = render(
      <BackendStoresProvider stores={a}>
        <Selection />
      </BackendStoresProvider>
    )
    act(() => a.workspace.getState().setActiveFolderId(1))
    expect(screen.getByTestId("active-folder").textContent).toBe("1")
    expect(screen.getByTestId("active-folder").dataset.backend).toBe("a")
    b.workspace.getState().setActiveFolderId(2)
    rerender(
      <BackendStoresProvider stores={b}>
        <Selection />
      </BackendStoresProvider>
    )
    expect(screen.getByTestId("active-folder").dataset.backend).toBe("b")
    expect(screen.getByTestId("active-folder").textContent).toBe("2")
    unmount()
    expect(a.workspace.isDisposed()).toBe(false)
    expect(b.workspace.isDisposed()).toBe(false)
  })
})
