import { beforeEach, describe, expect, it, vi } from "vitest"
import { useTabStore, resetTabStore } from "./tab-store"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "./app-workspace-store"
import {
  popClosedTab,
  resetClosedTabStackForTests,
  snapshotConversationTab,
} from "@/lib/closed-tab-stack"
import type { FolderDetail } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  getFolderConversation: vi.fn(),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(),
  onTransportReconnect: vi.fn(),
}))

beforeEach(() => {
  resetTabStore()
  resetAppWorkspaceStore()
  resetClosedTabStackForTests()
})

const active = () => {
  const state = useTabStore.getState()
  return state.rawTabs.find((tab) => tab.id === state.activeTabId)!
}

const ids = () => useTabStore.getState().rawTabs.map((tab) => tab.id)

function openConversation(id: number) {
  useTabStore.getState().openTab(1, id, "codex", true, `Conversation ${id}`)
  return active().id
}

describe("chat draft positions", () => {
  it.each(["paper-a", undefined])(
    "restores a closed chat draft with paper %s between its neighbors",
    (academicPaperId) => {
      const left = openConversation(1)
      const draft = useTabStore.getState().openChatModeTab({
        forceAgent: "codex",
        academicPaperId,
      })
      const right = openConversation(2)
      expect(ids()).toEqual([left, draft.tabId, right])

      useTabStore.getState().closeTab(draft.tabId)
      expect(ids()).toEqual([left, right])
      const closed = popClosedTab()
      if (!closed || closed.kind !== "conversation") {
        throw new Error("expected a closed conversation draft")
      }
      expect(closed).toMatchObject({
        index: 1,
        isChat: true,
        conversationId: null,
        academicPaperId,
      })
      const restored = useTabStore.getState().openChatModeTab({
        index: closed.index,
        forceAgent: closed.agentType,
        academicPaperId: closed.academicPaperId,
      })
      expect(ids()).toEqual([left, restored.tabId, right])
      expect(active()).toMatchObject({
        id: restored.tabId,
        isChat: true,
        academicPaperId,
        agentType: "codex",
      })
    }
  )

  it.each([
    [undefined, 2],
    [-1, 0],
    [1, 1],
    [99, 2],
  ] as const)("inserts a new draft at index %s (slot %s)", (index, slot) => {
    const neighbors = [openConversation(1), openConversation(2)]
    const draft = useTabStore.getState().openChatModeTab({ index })
    neighbors.splice(slot, 0, draft.tabId)
    expect(ids()).toEqual(neighbors)
  })

  it.each(["unchanged", "paper", "agent", "folder"])(
    "moves a reused draft with %s changes to the explicit slot",
    (change) => {
      const left = openConversation(1)
      const draft =
        change === "folder"
          ? useTabStore.getState().openNewConversationTab(1, "/repo", {
              forceAgent: "codex",
            })
          : useTabStore.getState().openChatModeTab({ forceAgent: "codex" })
      const right = openConversation(2)
      const options = {
        forceAgent:
          change === "agent" ? ("gemini" as const) : ("codex" as const),
        academicPaperId: change === "paper" ? "paper-a" : undefined,
      }
      const reused = useTabStore.getState().openChatModeTab({
        ...options,
        index: 99,
      })
      expect(reused.tabId).toBe(draft.tabId)
      expect(ids()).toEqual([left, right, draft.tabId])
      expect(active()).toMatchObject({
        id: draft.tabId,
        folderId: 0,
        isChat: true,
        agentType: options.forceAgent,
        academicPaperId: options.academicPaperId,
      })
      useTabStore.getState().openChatModeTab({ ...options, index: -1 })
      expect(ids()).toEqual([draft.tabId, left, right])
    }
  )

  it("leaves a reused draft in place without an index and preserves its agent", () => {
    const left = openConversation(1)
    const draft = useTabStore
      .getState()
      .openChatModeTab({ forceAgent: "gemini" })
    const right = openConversation(2)
    useTabStore.getState().openChatModeTab()
    expect(ids()).toEqual([left, draft.tabId, right])
    expect(active().agentType).toBe("gemini")
    useTabStore.getState().switchTab(right)
    useTabStore.getState().openChatModeTab({ index: 0 })
    expect(ids()).toEqual([draft.tabId, left, right])
    expect(active().agentType).toBe("gemini")
  })

  it("uses global slots while only creating or reusing the target group's draft", () => {
    const left = openConversation(1)
    const right = openConversation(2)
    useTabStore.getState().splitTab(right, "right", { move: true })
    const { groupOf } = useTabStore.getState()
    const other = useTabStore.getState().openChatModeTab({
      targetGroup: groupOf[right],
      academicPaperId: "other-paper",
    })
    const target = useTabStore.getState().openChatModeTab({
      targetGroup: groupOf[left],
      academicPaperId: "paper-a",
      index: 1,
    })
    expect(ids()).toEqual([left, target.tabId, right, other.tabId])
    const reused = useTabStore.getState().openChatModeTab({
      targetGroup: groupOf[right],
      academicPaperId: "other-paper",
      index: 0,
    })
    expect(reused.tabId).toBe(other.tabId)
    expect(ids()).toEqual([other.tabId, left, target.tabId, right])
    expect(useTabStore.getState().groupOf).toMatchObject({
      [target.tabId]: groupOf[left],
      [other.tabId]: groupOf[right],
    })
    expect(
      useTabStore.getState().rawTabs.find((t) => t.id === target.tabId)
    ).toMatchObject({ academicPaperId: "paper-a" })
  })

  it("forwards the slot when opening a conversation in a hidden chat folder", () => {
    useAppWorkspaceStore.setState({
      allFolders: [{ id: 7, kind: "chat" } as FolderDetail],
    })
    const right = openConversation(1)
    const draft = useTabStore.getState().openNewConversationTab(7, "/chat", {
      index: 0,
      forceAgent: "codex",
      academicPaperId: "paper-a",
    })
    expect(ids()).toEqual([draft.tabId, right])
    expect(active()).toMatchObject({
      folderId: 0,
      isChat: true,
      agentType: "codex",
      academicPaperId: "paper-a",
    })
  })
})

describe("academic draft identity", () => {
  it("carries a paper into repo and chat drafts and their closed snapshots", () => {
    useTabStore.getState().openNewConversationTab(1, "/repo", {
      forceAgent: "codex",
      academicPaperId: "paper-a",
    })
    expect(active().academicPaperId).toBe("paper-a")
    expect(snapshotConversationTab(active(), 0).academicPaperId).toBe("paper-a")
    useTabStore
      .getState()
      .openChatModeTab({ forceAgent: "codex", academicPaperId: "paper-b" })
    expect(active().academicPaperId).toBe("paper-b")
    expect(active().isChat).toBe(true)
  })

  it("clears paper identity when the same draft is opened for ordinary work", () => {
    useTabStore.getState().openNewConversationTab(1, "/repo", {
      forceAgent: "codex",
      academicPaperId: "paper-a",
    })
    useTabStore
      .getState()
      .openNewConversationTab(1, "/repo", { forceAgent: "codex" })
    expect(active().academicPaperId).toBeUndefined()
    useTabStore
      .getState()
      .openChatModeTab({ forceAgent: "codex", academicPaperId: "paper-b" })
    useTabStore.getState().openChatModeTab({ forceAgent: "codex" })
    expect(active().academicPaperId).toBeUndefined()
  })

  it("preserves identity when binding the draft to its durable conversation", () => {
    const target = useTabStore
      .getState()
      .openChatModeTab({ forceAgent: "codex", academicPaperId: "paper-a" })
    useTabStore
      .getState()
      .bindConversationTab(
        target.tabId,
        42,
        "codex",
        "Question",
        undefined,
        2,
        "/chat"
      )
    expect(active().academicPaperId).toBe("paper-a")
    expect(active().conversationId).toBe(42)
  })
})

it("never applies an obsolete async retarget after a newer paper selection", async () => {
  const pending: Array<() => void> = []
  useTabStore.getState().setSideEffects({
    activateConversationPane: () => {},
    acpDisconnect: () => new Promise<void>((resolve) => pending.push(resolve)),
  })
  useTabStore.getState().openNewConversationTab(1, "/one", {
    forceAgent: "codex",
    academicPaperId: "a",
  })
  useTabStore.getState().openNewConversationTab(2, "/two", {
    forceAgent: "codex",
    academicPaperId: "b",
  })
  useTabStore.getState().consumeDraftRetargets()
  useTabStore.getState().openNewConversationTab(3, "/three", {
    forceAgent: "codex",
    academicPaperId: "c",
  })
  useTabStore.getState().consumeDraftRetargets()
  pending[1]()
  await Promise.resolve()
  pending[0]()
  await Promise.resolve()
  expect(active().academicPaperId).toBe("c")
  expect(active().folderId).toBe(3)
})

it("inherits the paper when splitting a research conversation into a new draft", () => {
  const opened = useTabStore
    .getState()
    .openChatModeTab({ forceAgent: "codex", academicPaperId: "paper-a" })
  useTabStore.getState().splitTab(opened.tabId, "right", { move: false })
  expect(useTabStore.getState().rawTabs).toHaveLength(2)
  expect(active().academicPaperId).toBe("paper-a")
})

it.each(["claude_code", "codex"] as const)(
  "settles the latest folder and paper while preserving an explicit %s selection",
  async (selectedAgent) => {
    let finish!: () => void
    useTabStore.getState().setSideEffects({
      activateConversationPane: () => {},
      acpDisconnect: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    })
    const draft = useTabStore.getState().openNewConversationTab(1, "/one", {
      forceAgent: "codex",
      academicPaperId: "paper-a",
    })
    useTabStore.getState().openNewConversationTab(2, "/two", {
      forceAgent: "gemini",
      academicPaperId: "paper-b",
    })
    useTabStore.getState().consumeDraftRetargets()
    useTabStore.getState().confirmDraftAgent(draft.tabId, selectedAgent)
    finish()
    await Promise.resolve()
    expect(active()).toMatchObject({
      folderId: 2,
      workingDir: "/two",
      academicPaperId: "paper-b",
      agentType: selectedAgent,
      agentTypeProvisional: false,
      draftRetargetPending: false,
    })
  }
)
