import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { BackendStoresProvider } from "@/contexts/backend-stores-context"
import { WorkspaceRuntimeVisibilityProvider } from "@/contexts/workspace-runtime-visibility-context"
import { BackendRuntime } from "@/lib/backend/runtime"
import { selectFolderContext } from "@/lib/backend/project-navigation"
import type { FolderDetail } from "@/lib/types"
import {
  loadMessageInputDraft,
  saveMessageInputDraft,
} from "@/lib/message-input-draft"
import { ConversationDetailPanel } from "./conversation-detail-panel"

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpActions: () => ({ disconnectIfIdle: vi.fn() }),
  useAcpEvent: () => {},
}))
vi.mock("@/contexts/task-context", () => ({
  useTaskContext: () => ({ addTask: vi.fn(), updateTask: vi.fn() }),
}))
vi.mock("@/hooks/use-agent-display", () => ({
  useAgentDisplay: () => ({ getAgentLabel: (agent: string) => agent }),
}))

const root: FolderDetail = {
  id: 1,
  name: "repo",
  path: "/repo",
  kind: "regular",
  parent_id: null,
  alias: null,
  group_id: null,
  git_branch: "main",
  default_agent_type: "codex",
  color: "",
  sort_order: 0,
  last_opened_at: "",
}
const child = { ...root, id: 2, parent_id: 1, path: "/worktree" }
let runtime: BackendRuntime

beforeEach(() => {
  localStorage.clear()
  runtime = new BackendRuntime(
    { key: "local", name: "Local", connection: null },
    { generation: 1, isCurrent: () => true, setStatus: () => {} },
    {
      windowInstanceId: "panel-no-tabs",
      shellTransport: {
        call: vi.fn().mockResolvedValue([]),
        subscribe: vi.fn().mockResolvedValue(() => {}),
        isDesktop: () => true,
      },
    }
  )
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  runtime.dispose()
})

function mount(managed?: boolean) {
  const panel = <ConversationDetailPanel />
  return render(
    <BackendStoresProvider stores={runtime.stores}>
      {managed === undefined ? (
        panel
      ) : (
        <WorkspaceRuntimeVisibilityProvider
          value={{ managed, visible: true, focused: true }}
        >
          {panel}
        </WorkspaceRuntimeVisibilityProvider>
      )}
    </BackendStoresProvider>
  )
}

// Keep the panel on its real empty-tab render path even when the broken effect
// calls the action. Draft creation/recovery is also exercised with the real
// store below; no panel effect, active-folder hook or selector is replaced.
function watchDraft() {
  return vi
    .spyOn(runtime.stores.tabs.getState(), "openNewConversationTab")
    .mockImplementation((folderId) => ({
      tabId: "unexpected",
      folderId,
      agentType: "codex",
    }))
}

it("keeps managed context-only root/worktree selection empty after closing the recovered folderless chat", () => {
  const { workspace, tabs } = runtime.stores
  tabs.runRecoveryOnce()
  expect(tabs.getState().tabs[0]).toMatchObject({ isChat: true, folderId: 0 })
  tabs.getState().closeTab(tabs.getState().tabs[0].id)
  tabs.runRecoveryOnce()
  expect(tabs.getState().tabs).toHaveLength(0)
  const draft = vi.spyOn(tabs.getState(), "openNewConversationTab")
  const view = mount(true)
  act(() =>
    workspace.setState({ allFolders: [root, child], folders: [root, child] })
  )
  act(() => selectFolderContext(runtime, root))
  expect(workspace.getState().activeFolderId).toBe(1)
  act(() => selectFolderContext(runtime, child))
  expect(workspace.getState().activeFolderId).toBe(2)
  expect(draft).not.toHaveBeenCalled()
  expect(tabs.getState().tabs).toHaveLength(0)
  view.unmount()
  draft.mockRestore()
  tabs.getState().openNewConversationTab(child.id, child.path)
  expect(tabs.getState().tabs).toHaveLength(1)
  expect(tabs.getState().tabs[0]).toMatchObject({
    folderId: 2,
    workingDir: "/worktree",
    conversationId: null,
  })
})

it.each([undefined, false])(
  "preserves the legacy panel empty-tab draft bridge with managed=%s",
  (managed) => {
    runtime.stores.workspace.setState({ allFolders: [root], folders: [root] })
    const draft = watchDraft()
    mount(managed)
    act(() => selectFolderContext(runtime, root))
    expect(draft).toHaveBeenCalledWith(root.id, root.path)
  }
)

it("preserves initial repository draft recovery and its saved composer text", () => {
  const { workspace, tabs, storage } = runtime.stores
  workspace.setState({
    allFolders: [root],
    folders: [root],
    activeFolderId: root.id,
  })
  const bridge = watchDraft()
  const view = mount(true)
  expect(bridge).not.toHaveBeenCalled()
  view.unmount()
  bridge.mockRestore()
  tabs.runRecoveryOnce()
  const draft = tabs.getState().tabs[0]
  expect(draft).toMatchObject({
    folderId: 1,
    conversationId: null,
    workingDir: "/repo",
  })
  const key = storage.drafts.buildNewConversationDraftStorageKey(draft.id)
  saveMessageInputDraft(key, "unfinished prompt")
  tabs.runRecoveryOnce()
  expect(tabs.getState().tabs[0]).toEqual(draft)
  expect(loadMessageInputDraft(key)).toBe("unfinished prompt")
})
