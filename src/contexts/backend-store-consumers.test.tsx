import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { BackendStoresProvider } from "./backend-stores-context"
import { useActiveFolder } from "./active-folder-context"
import { useConversationRuntime } from "./conversation-runtime-context"
import { createBackendStores, type BackendStores } from "@/lib/backend/stores"
import type { BackendClient } from "@/lib/backend/types"
import { openAcademicConversation } from "@/lib/academic-conversation"
import { sessionNotificationPayload } from "@/lib/notification-session"
import { getCanvasViewStorage } from "@/lib/canvas-view-storage"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"

const owned: BackendStores[] = []
function runtime(id: number) {
  const api = { getFolder: vi.fn() }
  const client = {
    key: `remote:${id}`,
    api,
    academic: {},
    platform: {},
  } as unknown as BackendClient
  const stores = createBackendStores(client)
  owned.push(stores)
  const folder = {
    id: 1,
    path: "/same/repo",
    name: `Folder ${id}`,
  } as FolderDetail
  const summary = {
    id: 1,
    folder_id: 1,
    title: `Session ${id}`,
  } as DbConversationSummary
  stores.workspace.setState({
    allFolders: [folder],
    folders: [folder],
    activeFolderId: 1,
    conversations: [summary],
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <BackendStoresProvider stores={stores}>{children}</BackendStoresProvider>
  )
  return { stores, api, client, folder, summary, wrapper }
}
afterEach(() => {
  for (const stores of owned.splice(0)) stores.dispose()
  localStorage.clear()
})

describe("existing consumers bind to resource providers", () => {
  it("reads equal folder/conversation IDs from the selected provider and preserves callback scope", () => {
    const a = runtime(1),
      b = runtime(2)
    const first = renderHook(
      () => ({ folder: useActiveFolder(), runtime: useConversationRuntime() }),
      { wrapper: a.wrapper }
    )
    const other = renderHook(
      () => ({ folder: useActiveFolder(), runtime: useConversationRuntime() }),
      { wrapper: b.wrapper }
    )
    expect(first.result.current.folder.activeFolder?.name).toBe("Folder 1")
    expect(other.result.current.folder.activeFolder?.name).toBe("Folder 2")
    act(() => a.stores.workspace.getState().applyConversationRemove(1))
    expect(b.stores.workspace.getState().conversations).toEqual([b.summary])
    expect(first.result.current.runtime.getSession(1)).toBeNull()
    expect(other.result.current.runtime.getSession(1)).toBeNull()
    const content = { body: "done" }
    expect(
      sessionNotificationPayload("closed-tab", 1, null, content, b.stores)
    ).toMatchObject({ title: "Session 2", body: "Folder 2 · done" })
    expect(
      sessionNotificationPayload("closed-tab", 1, "Folder 1", content, a.stores)
        .title
    ).toBe("Folder 1 - Codeg")
  })

  it("routes a deferred academic open to A even while B has the same folder path and ID", async () => {
    const a = runtime(1),
      b = runtime(2)
    let resolve!: (folder: FolderDetail) => void
    a.api.getFolder.mockImplementation(
      () =>
        new Promise<FolderDetail>((r) => {
          resolve = r
        })
    )
    const transport = {}
    const platform = {
      getTransport: () => transport,
    } as unknown as BackendClient["platform"]
    const opening = openAcademicConversation(
      {
        paper_id: "same-paper",
        agent_type: "codex",
        folder_id: 1,
        working_dir: "/same/repo",
      },
      a.client.api,
      platform,
      a.stores
    )
    b.stores.workspace.getState().setActiveFolderId(1)
    resolve(a.folder)
    await opening
    expect(
      a.stores.tabs
        .getState()
        .rawTabs.some((t) => t.academicPaperId === "same-paper")
    ).toBe(true)
    expect(b.stores.tabs.getState().rawTabs).toEqual([])
    expect(b.api.getFolder).not.toHaveBeenCalled()
  })

  it("stores drafts, selection prompts, closed tabs and canvas views independently for equal IDs", () => {
    const a = runtime(1),
      b = runtime(2)
    const first = getCanvasViewStorage(a.stores.storage),
      other = getCanvasViewStorage(b.stores.storage)
    first.saveCanvasViewport(1, { x: 10, y: 20, zoom: 1 })
    other.saveCanvasViewport(1, { x: 50, y: 60, zoom: 2 })
    expect(first.loadCanvasViewport(1)).toEqual({ x: 10, y: 20, zoom: 1 })
    expect(other.loadCanvasViewport(1)).toEqual({ x: 50, y: 60, zoom: 2 })
    first.forgetCanvasBoardViewState(1)
    expect(other.loadCanvasViewport(1)).toEqual({ x: 50, y: 60, zoom: 2 })
    a.stores.storage.askSelection.parkAskSelectionPrompt("same-tab", {
      prompt: "A",
      agentType: "codex",
      folderId: 1,
    })
    b.stores.storage.askSelection.parkAskSelectionPrompt("same-tab", {
      prompt: "B",
      agentType: "codex",
      folderId: 1,
    })
    expect(
      a.stores.storage.askSelection.consumeAskSelectionPrompts("same-tab", {
        agentType: "codex",
        folderId: 1,
      })
    ).toEqual(["A"])
    expect(
      b.stores.storage.askSelection.consumeAskSelectionPrompts("same-tab", {
        agentType: "codex",
        folderId: 1,
      })
    ).toEqual(["B"])
    expect(
      a.stores.storage.drafts.buildNewConversationDraftStorageKey("same-tab")
    ).not.toBe(
      b.stores.storage.drafts.buildNewConversationDraftStorageKey("same-tab")
    )
  })
})

import {
  loadMessageInputDraftV2,
  saveMessageInputDraft,
  saveMessageInputDraftV2,
} from "@/lib/message-input-draft"
it.each([1, 2])(
  "does not resurrect a moved or cleared scoped v%s composer draft",
  (version) => {
    const a = runtime(1),
      b = runtime(2)
    const source =
      a.stores.storage.drafts.buildNewConversationDraftStorageKey("same-tab")
    const target =
      a.stores.storage.drafts.buildNewConversationDraftStorageKey("replacement")
    const other =
      b.stores.storage.drafts.buildNewConversationDraftStorageKey("same-tab")
    const save = (key: string, text: string) =>
      version === 1
        ? saveMessageInputDraft(key, text)
        : saveMessageInputDraftV2(key, {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text }] }],
          })
    save(source, "A")
    save(other, "B")
    a.stores.storage.drafts.moveMessageInputDraft(source, target)
    expect(loadMessageInputDraftV2(source)).toBeNull()
    expect(loadMessageInputDraftV2(target)).not.toBeNull()
    a.stores.storage.drafts.clearMessageInputDraftV2(target)
    expect(loadMessageInputDraftV2(target)).toBeNull()
    expect(loadMessageInputDraftV2(other)).not.toBeNull()
  }
)
