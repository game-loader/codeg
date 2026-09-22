import { beforeEach, describe, expect, it, vi } from "vitest"
import { useTabStore, resetTabStore } from "./tab-store"
import { resetAppWorkspaceStore } from "./app-workspace-store"
import { snapshotConversationTab } from "@/lib/closed-tab-stack"

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
})

const active = () => {
  const state = useTabStore.getState()
  return state.rawTabs.find((tab) => tab.id === state.activeTabId)!
}

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
