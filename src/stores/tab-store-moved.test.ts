import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as defaultApi from "@/lib/api"
import type {
  DbConversationSummary,
  FolderDetail,
  OpenedTab,
} from "@/lib/types"
import { createAppWorkspaceStore } from "./app-workspace-store"
import { createBackendStoreStorage } from "./backend-store-storage"
import { createConversationRuntimeStore } from "./conversation-runtime-store"
import { resetFolderTabsStore } from "./folder-tabs-store"
import { createTabStore } from "./tab-store"

const row = (id: number, folderId = 1): DbConversationSummary => ({
  id,
  folder_id: folderId,
  agent_type: "codex",
  title: `Conversation ${id}`,
  title_locked: false,
  status: "completed",
  kind: "regular",
  model: null,
  git_branch: null,
  external_id: `session-${id}`,
  message_count: 1,
  child_count: 0,
  created_at: "2026-11-17T00:00:00Z",
  updated_at: "2026-11-17T00:00:00Z",
  pinned_at: null,
})

const opened = (id: number, folderId = 1): OpenedTab => ({
  id: 0,
  folder_id: folderId,
  conversation_id: id,
  agent_type: "codex",
  is_pinned: true,
  is_active: id === 1,
  position: id - 1,
})

const cleanups: Array<() => void> = []

async function backend(key: string) {
  const storage = createBackendStoreStorage(key)
  const workspace = createAppWorkspaceStore(defaultApi, storage)
  const api = {
    getFolderConversation: vi.fn<typeof defaultApi.getFolderConversation>(),
    listOpenedTabs: vi.fn(async () => ({
      items: [opened(1), opened(2)],
      version: 1,
    })),
    saveOpenedTabs: vi.fn<typeof defaultApi.saveOpenedTabs>(
      async (items, expected) => ({
        accepted: true,
        version: expected + 1,
        tabs: items,
      })
    ),
  }
  const runtime = createConversationRuntimeStore({
    getFolderConversation: api.getFolderConversation,
    getFolderConversationTurns: vi.fn(),
  })
  const tabs = createTabStore(api, storage, workspace, runtime)
  cleanups.push(() => {
    tabs.dispose()
    runtime.dispose()
    workspace.dispose()
    storage.dispose()
  })
  const folders = [1, 2].map(
    (id): FolderDetail => ({
      id,
      name: `Project ${id}`,
      path: `/project-${id}`,
      kind: "regular",
      git_branch: null,
      default_agent_type: null,
      last_opened_at: "2026-11-17T00:00:00Z",
      sort_order: id,
      color: "inherit",
      parent_id: null,
      group_id: null,
      alias: null,
    })
  )
  workspace.setState({
    folders,
    allFolders: folders,
    conversations: [row(1), row(2)],
    conversationsLoading: false,
  })
  tabs.getState().hydrate()
  await vi.advanceTimersByTimeAsync(0)
  expect(tabs.getState().tabsHydrated).toBe(true)
  return { tabs, workspace, api, storage }
}

beforeEach(() => {
  localStorage.clear()
  resetFolderTabsStore()
  vi.useFakeTimers()
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.useRealTimers()
})

describe("moved conversations in backend tab stores", () => {
  it("moves and saves only the owning backend's tab, retaining its ID and group", async () => {
    const a = await backend("remote:a")
    const b = await backend("remote:b")
    const before = a.tabs.getState()
    const untouched = b.tabs.getState()
    const id = before.rawTabs[0].id
    expect(id).not.toBe(untouched.rawTabs[0].id)

    a.workspace.getState().applyConversationUpsert(row(1, 2))

    expect(a.tabs.getState().rawTabs[0]).toMatchObject({
      id,
      folderId: 2,
      isPinned: true,
    })
    expect(a.tabs.getState().activeTabId).toBe(id)
    expect(a.tabs.getState().groupOf).toEqual(before.groupOf)
    expect(b.tabs.getState()).toBe(untouched)
    a.tabs.getState().runSaveEffect()
    b.tabs.getState().runSaveEffect()
    await vi.advanceTimersByTimeAsync(500)
    expect(a.api.saveOpenedTabs).toHaveBeenCalledWith(
      [opened(1, 2), opened(2)],
      1,
      expect.any(String)
    )
    expect(b.api.saveOpenedTabs).not.toHaveBeenCalled()
  })

  it("keeps a bound draft's host ID and runtime when a moved snapshot beats the row refresh", async () => {
    const a = await backend("remote:a")
    const b = await backend("remote:b")
    const untouched = b.tabs.getState()
    const draft = a.tabs.getState().openChatModeTab({ forceAgent: "codex" })
    a.workspace.getState().applyConversationUpsert({ ...row(3), kind: "chat" })
    a.tabs
      .getState()
      .bindConversationTab(draft.tabId, 3, "codex", "Chat", -3, 1, "/scratch")
    expect(a.tabs.getState().rawTabs.slice(-1)[0]?.isChat).toBe(true)
    a.workspace.setState({ conversationsLoading: true })

    a.tabs.getState().handleTabsChanged({
      version: 2,
      origin: "server",
      tabs: [
        { ...opened(1), is_active: false },
        opened(2),
        { ...opened(3, 2), is_active: true },
      ],
    })

    expect(a.tabs.getState().rawTabs.slice(-1)[0]).toMatchObject({
      id: draft.tabId,
      folderId: 2,
      runtimeConversationId: -3,
      isChat: true,
    })
    expect(a.tabs.getState().rawTabs.slice(-1)[0]?.workingDir).toBeUndefined()
    expect(a.tabs.getState().activeTabId).toBe(draft.tabId)
    a.workspace.getState().applyConversationUpsert(row(3, 2))
    expect(a.tabs.getState().rawTabs.slice(-1)[0]?.isChat).toBe(true)
    a.workspace.setState({ conversationsLoading: false })
    expect(a.tabs.getState().rawTabs.slice(-1)[0]).toMatchObject({
      id: draft.tabId,
      folderId: 2,
      runtimeConversationId: -3,
      isChat: false,
    })
    expect(b.tabs.getState()).toBe(untouched)
  })

  it("keeps an unsaved close local when both backends move the same conversation ID", async () => {
    const a = await backend("remote:a")
    const b = await backend("remote:b")
    const id = b.tabs.getState().rawTabs[0].id
    a.tabs.getState().closeTab(a.tabs.getState().rawTabs[0].id)

    for (const current of [a, b]) {
      current.workspace.getState().applyConversationUpsert(row(1, 2))
      current.tabs.getState().handleTabsChanged({
        version: 2,
        origin: "server",
        tabs: [opened(1, 2), opened(2)],
      })
      current.tabs.getState().runSaveEffect()
    }
    await vi.advanceTimersByTimeAsync(500)

    expect(a.tabs.getState().rawTabs.map((tab) => tab.conversationId)).toEqual([
      2,
    ])
    expect(b.tabs.getState().rawTabs[0]).toMatchObject({ id, folderId: 2 })
    expect(a.api.saveOpenedTabs).toHaveBeenCalledWith(
      [{ ...opened(2), is_active: true, position: 0 }],
      2,
      expect.any(String)
    )
    expect(b.api.saveOpenedTabs).not.toHaveBeenCalled()
  })

  it("uses only its own child summary to reopen a tab from an outdated folder", async () => {
    const a = await backend("remote:a")
    const b = await backend("remote:b")
    a.tabs.setState({ childSummaries: new Map([[7, row(7, 2)]]) })
    a.tabs.getState().openTab(1, 7, "codex", true)
    b.tabs.getState().openTab(1, 7, "codex", true)

    expect(a.tabs.getState().rawTabs.slice(-1)[0]?.folderId).toBe(2)
    expect(b.tabs.getState().rawTabs.slice(-1)[0]?.folderId).toBe(1)
    a.tabs.getState().openTab(1, 7, "codex", true)
    expect(
      a.tabs.getState().rawTabs.filter((tab) => tab.conversationId === 7)
    ).toHaveLength(1)
  })
})
