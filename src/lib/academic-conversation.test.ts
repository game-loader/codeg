import { beforeEach, expect, it, vi } from "vitest"
import { openAcademicConversation } from "./academic-conversation"
import { resetTabStore, useTabStore } from "@/stores/tab-store"
import { resetAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  saveMessageInputDraft,
  registerMessageInputDraftReader,
  loadMessageInputDraftV2,
  saveMessageInputDraftV2,
  buildNewConversationDraftStorageKey,
} from "./message-input-draft"

const environment = vi.hoisted(() => ({ local: true, transport: {} }))
vi.mock("@/lib/transport", () => ({
  getTransport: () => environment.transport,
}))

vi.mock("@/lib/api", () => ({
  getFolder: vi.fn(async (id: number) => ({ id, path: "/repo", name: "repo" })),
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  getFolderConversation: vi.fn(),
}))
vi.mock("@/lib/platform", () => ({
  isLocalDesktop: () => environment.local,
  subscribe: vi.fn(),
  onTransportReconnect: vi.fn(),
}))
beforeEach(() => {
  environment.local = true
  resetTabStore()
  resetAppWorkspaceStore()
})
const target = {
  paper_id: "paper-a",
  agent_type: "codex",
  folder_id: null,
  working_dir: null,
}
it("protects unsent text when opening a different research context", async () => {
  const draft = useTabStore.getState().openChatModeTab({ forceAgent: "codex" })
  saveMessageInputDraft(
    buildNewConversationDraftStorageKey(draft.tabId),
    "Unsent task"
  )
  await expect(openAcademicConversation(target)).rejects.toThrow(
    "academicDraftConflict"
  )
  expect(useTabStore.getState().rawTabs[0].academicPaperId).toBeUndefined()
})
it("protects reference-only composer documents too", async () => {
  const draft = useTabStore.getState().openChatModeTab({ forceAgent: "codex" })
  saveMessageInputDraftV2(buildNewConversationDraftStorageKey(draft.tabId), {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "reference" }] },
    ],
  })
  await expect(openAcademicConversation(target)).rejects.toThrow(
    "academicDraftConflict"
  )
})
it("focuses the same paper without altering its unsent question", async () => {
  const draft = useTabStore
    .getState()
    .openChatModeTab({ forceAgent: "codex", academicPaperId: "paper-a" })
  saveMessageInputDraft(
    buildNewConversationDraftStorageKey(draft.tabId),
    "My question"
  )
  await openAcademicConversation(target)
  expect(useTabStore.getState().activeTabId).toBe(draft.tabId)
  expect(useTabStore.getState().rawTabs).toHaveLength(1)
})
it("starts a paper-only chat with fixed research agent and paper identity", async () => {
  await openAcademicConversation(target)
  expect(useTabStore.getState().rawTabs[0]).toMatchObject({
    isChat: true,
    folderId: 0,
    academicPaperId: "paper-a",
    agentType: "codex",
  })
})

it("checks live composer text before the 300ms persistence debounce", async () => {
  const draft = useTabStore.getState().openChatModeTab({ forceAgent: "codex" })
  const key = buildNewConversationDraftStorageKey(draft.tabId)
  const stop = registerMessageInputDraftReader(key, () => true)
  try {
    expect(loadMessageInputDraftV2(key)).toBeNull()
    await expect(openAcademicConversation(target)).rejects.toThrow(
      "academicDraftConflict"
    )
    expect(useTabStore.getState().rawTabs[0].academicPaperId).toBeUndefined()
  } finally {
    stop()
  }
})

it("opens a research draft in a remote workspace", async () => {
  environment.local = false
  await openAcademicConversation(target)
  expect(useTabStore.getState().rawTabs[0]).toMatchObject({
    academicPaperId: "paper-a",
    agentType: "codex",
    isChat: true,
  })
})
