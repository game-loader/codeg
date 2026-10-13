import { createContext, useContext, useEffect, useMemo, useState } from "react"
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { MultiHostWorkspace } from "./multi-host-workspace"
import { RuntimeBridge } from "./backend-runtime"
import {
  RuntimeRecoveryStore,
  readWindowTabs,
  runtimeRecoveryStore,
  saveWindowTabs,
  type BackendRuntime,
} from "@/lib/backend/runtime"
import {
  emptyWindowLayout,
  readWindowLayout,
  saveWindowLayout,
  type WindowResourceRef,
} from "@/lib/backend/window-layout"
import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import type { RemoteTransportConfig } from "@/lib/transport"
import type { RemoteWorkspaceConnection } from "@/lib/types"
import messages from "@/i18n/messages/en.json"

const mocks = vi.hoisted(() => ({
  shell: {
    call: vi.fn(),
    subscribe: vi.fn().mockResolvedValue(() => {}),
    isDesktop: () => true,
  },
  remotes: new Map<
    number,
    {
      call: ReturnType<typeof vi.fn>
      destroy: ReturnType<typeof vi.fn>
      config: RemoteTransportConfig
    }
  >(),
  runtimes: new Map<string, BackendRuntime>(),
  list: vi.fn(),
  restore: vi.fn(),
  export: vi.fn().mockResolvedValue("saved"),
}))
vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => {
    let value: unknown = messages
    for (const part of `${namespace}.${key}`.split("."))
      value = (value as Record<string, unknown>)?.[part]
    return typeof value === "string" ? value : key
  },
}))
vi.mock("@/lib/transport", async (original) => ({
  ...(await original<typeof import("@/lib/transport")>()),
  getShellTransport: () => mocks.shell,
}))
vi.mock("@/lib/transport/remote-desktop-transport", () => ({
  RemoteDesktopTransport: class {
    call = vi.fn().mockResolvedValue({ content: "disk content", id: 1 })
    subscribe = vi.fn().mockResolvedValue(() => {})
    destroy = vi.fn()
    isDesktop = () => true
    constructor(readonly config: RemoteTransportConfig) {
      mocks.remotes.set(config.id, this)
    }
  },
}))
vi.mock("@/lib/remote-workspace", () => ({
  listRemoteWorkspaceConnections: mocks.list,
}))
vi.mock("@/lib/save-file", () => ({ saveTextFile: mocks.export }))
vi.mock("@/components/layout/window-controls", () => ({
  WindowControls: () => null,
}))
vi.mock("@/components/ui/app-toaster", () => ({ AppToaster: () => null }))
vi.mock("@/components/layout/remote-workspace-manage-dialog", () => ({
  RemoteWorkspaceManageDialog: () => null,
}))
vi.mock("@/components/layout/workspace-folder-dialog", () => ({
  WorkspaceFolderDialog: () => null,
}))
vi.mock("./host-worktree-dialog", () => ({ HostWorktreeDialog: () => null }))

interface Fixture {
  fileTabs: FileWorkspaceTab[]
  activeFileTabId: string | null
  actions: {
    switchFileTab(id: string): void
    closeFileTab(id: string): void
    activateConversationPane(): void
    openFilePreview(path: string): Promise<void>
  }
}
const FileFixture = createContext<Fixture>(null!)
function useFixture() {
  return useContext(FileFixture)
}
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceFileTabs: () => useFixture(),
  useWorkspaceActions: () => useFixture().actions,
  useWorkspaceView: () => ({ activePane: "files" }),
}))
const toggle = () => {}
const route = {
  routeId: "conversations",
  openConversations: toggle,
  setRoute: toggle,
}
vi.mock("@/contexts/workbench-route-context", async (original) => ({
  ...(await original<typeof import("@/contexts/workbench-route-context")>()),
  useWorkbenchRoute: () => route,
}))
vi.mock("@/contexts/sidebar-context", () => ({
  useSidebarContext: () => ({ isOpen: false, toggle }),
}))
vi.mock("@/contexts/aux-panel-context", () => ({
  useAuxPanelContext: () => ({ isOpen: false, toggle }),
}))
vi.mock("@/contexts/terminal-context", () => ({
  useTerminalContext: () => ({ isOpen: false, toggle }),
}))
vi.mock("@/contexts/search-dialog-context", () => ({
  useSearchDialog: () => ({ setOpen: toggle }),
}))

function connection(id: number): RemoteWorkspaceConnection {
  return {
    id,
    name: id === 1 ? "Machine A" : "Machine B",
    base_url: `http://machine-${id}:3080`,
    token: "private-token",
    headers: [],
    sort_order: id,
    created_at: "",
    updated_at: "",
    config_revision: `revision-${id}`,
  }
}
const fileRef = (backendKey: "remote:1" | "remote:2"): WindowResourceRef => ({
  backendKey,
  kind: "file",
  id: "file:/same/file.ts",
  path: "/same/file.ts",
})
function file(content = "disk content"): FileWorkspaceTab {
  return {
    id: "file:/same/file.ts",
    kind: "file",
    folderId: null,
    path: "/same/file.ts",
    title: "file.ts",
    description: null,
    language: "typescript",
    content,
    savedContent: "disk content",
    loading: false,
    isDirty: false,
  }
}

/** Every generation starts with NO file tabs; only explicit opening/restoration
 * can add one. RuntimeBridge reads the same local state as the editor fixture. */
function ReplacementProbe({ runtime }: { runtime: BackendRuntime }) {
  const key = runtime.client.key
  const [fileTabs, setFiles] = useState<FileWorkspaceTab[]>([])
  const [activeFileTabId, select] = useState<string | null>(null)
  const actions = useMemo(
    () => ({
      switchFileTab: select,
      closeFileTab: () => setFiles([]),
      activateConversationPane: toggle,
      openFilePreview: async (path: string) => {
        mocks.restore(key, path, runtime.generation)
        await runtime.client.api.readFileForEdit("/same", "file.ts")
        setFiles([file()])
        select("file:/same/file.ts")
      },
    }),
    [key, runtime]
  )
  useEffect(() => {
    mocks.runtimes.set(key, runtime)
    runtime.stores.tabs.setState({ tabsHydrated: true, tabs: [], rawTabs: [] })
  }, [key, runtime])
  return (
    <FileFixture.Provider value={{ fileTabs, activeFileTabId, actions }}>
      <RuntimeBridge runtime={runtime} />
      <div data-testid={`replacement-${key}`}>
        <div
          className="ProseMirror"
          contentEditable
          suppressContentEditableWarning
          aria-label={`Composer ${key}`}
        />
        <button
          onClick={() => {
            setFiles([file()])
            select("file:/same/file.ts")
          }}
        >
          Open file {key}
        </button>
        {(["error", "saving"] as const).map((saveState) => (
          <button
            key={saveState}
            onClick={() => {
              setFiles([
                {
                  ...file(`${saveState} buffer without dirty flag`),
                  saveState,
                  saveError:
                    saveState === "error"
                      ? "Save failed without dirty flag"
                      : null,
                },
              ])
              select("file:/same/file.ts")
            }}
          >
            {saveState} file {key}
          </button>
        ))}
        {fileTabs.map((tab) => (
          <div key={tab.id}>
            <textarea
              aria-label={`Edit ${key}`}
              value={tab.content}
              onChange={(event) =>
                setFiles([
                  { ...tab, content: event.target.value, isDirty: true },
                ])
              }
            />
            <button
              onClick={() => {
                void runtime.client.api
                  .saveFileContent("/same", "file.ts", tab.content)
                  .catch(() => {
                    setFiles((tabs) =>
                      tabs.map((value) => ({
                        ...value,
                        saveState: "error",
                        saveError: "Save failed",
                      }))
                    )
                  })
              }}
            >
              Save {key}
            </button>
            {tab.saveError && <span>{tab.saveError}</span>}
          </div>
        ))}
      </div>
    </FileFixture.Provider>
  )
}
function mount() {
  return render(
    <MultiHostWorkspace
      renderWorkspace={(runtime) => <ReplacementProbe runtime={runtime} />}
    />
  )
}
async function openFiles() {
  await screen.findByTestId("replacement-remote:2")
  for (const key of ["remote:1", "remote:2"] as const) {
    fireEvent.click(
      screen.getAllByRole("button", {
        name: key === "remote:1" ? "Machine A" : "Machine B",
      })[1]
    )
    fireEvent.click(screen.getByRole("button", { name: `Open file ${key}` }))
  }
  await waitFor(() => expect(readWindowLayout().files).toHaveLength(2))
}
function edit(key: string, content: string) {
  fireEvent.change(screen.getByLabelText(`Edit ${key}`), {
    target: { value: content },
  })
}
async function findRecovery(content: string) {
  return waitFor(() => {
    const buffer = screen
      .getAllByRole("textbox")
      .find(
        (element) =>
          element.hasAttribute("readonly") &&
          (element as HTMLTextAreaElement).value === content
      )
    expect(buffer).toBeDefined()
    return buffer!
  })
}
beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  localStorage.clear()
  mocks.remotes.clear()
  mocks.runtimes.clear()
  mocks.list.mockResolvedValue([connection(1), connection(2)])
})

describe("runtime replacement and recovery integration", () => {
  it("never restores old A paths on URL replacement and leaves B's provider, tabs and buffer intact", async () => {
    mount()
    await openFiles()
    edit("remote:1", "dirty old endpoint buffer")
    edit("remote:2", "B remains dirty")
    const beforeB = screen.getByTestId("replacement-remote:2")
    const runtimeB = mocks.runtimes.get("remote:2")!
    const oldA = mocks.runtimes.get("remote:1")!
    const oldTransport = mocks.remotes.get(1)!
    mocks.list.mockResolvedValue([
      {
        ...connection(1),
        base_url: "http://new-a:3080",
        config_revision: "new",
      },
      connection(2),
    ])
    fireEvent(window, new Event("focus"))
    await waitFor(() => expect(oldTransport.destroy).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(readWindowLayout().files).toEqual([fileRef("remote:2")])
    )
    await act(async () => {
      await mocks.runtimes.get("remote:1")!.client.api.getFolder(1)
    })
    expect(await findRecovery("dirty old endpoint buffer")).toHaveAttribute(
      "readonly"
    )
    expect(
      mocks.restore.mock.calls.filter(([key]) => key === "remote:1")
    ).toEqual([])
    expect(screen.queryByLabelText("Edit remote:1")).toBeNull()
    expect(readWindowTabs().map((tab) => tab.ref)).toEqual([
      fileRef("remote:2"),
    ])
    expect(readWindowLayout().selected).toEqual(fileRef("remote:2"))
    expect(screen.getByTestId("replacement-remote:2")).toBe(beforeB)
    expect(mocks.runtimes.get("remote:2")).toBe(runtimeB)
    expect(screen.getByLabelText("Edit remote:2")).toHaveValue(
      "B remains dirty"
    )
    await expect(
      oldA.client.api.saveFileContent("/same", "file.ts", "old edit")
    ).rejects.toMatchObject({ code: "backend_retired" })
    expect(mocks.remotes.get(1)!.call).not.toHaveBeenCalledWith(
      "save_file_content",
      expect.anything(),
      undefined
    )
    expect(mocks.remotes.get(2)!.destroy).not.toHaveBeenCalled()
  })

  it("invalidates saved companions and pending selection when reopening after an outside URL edit", async () => {
    const a = fileRef("remote:1"),
      b = fileRef("remote:2")
    saveWindowLayout({
      ...emptyWindowLayout("remote:1"),
      selected: a,
      files: [a, b].filter((ref) => ref.kind === "file"),
      destinations: {
        "remote:1": connection(1).base_url,
        "remote:2": connection(2).base_url,
      },
    })
    saveWindowTabs([
      { ref: a, title: "old A", machineName: "A" },
      {
        ref: {
          backendKey: "remote:1",
          kind: "conversation",
          id: "old-conversation",
          folderId: 1,
        },
        title: "old conversation",
        machineName: "A",
      },
      { ref: b, title: "B", machineName: "B" },
    ])
    let resolve!: (connections: RemoteWorkspaceConnection[]) => void
    mocks.list.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    mount()
    await screen.findByRole("tab", { name: /old A/ })
    await act(async () =>
      resolve([
        {
          ...connection(1),
          base_url: "http://replacement-a:3080",
          config_revision: "new",
        },
        connection(2),
      ])
    )
    // Connect/hydrate an initially empty replacement: old files would otherwise
    // be restored only after this status transition.
    await act(async () => {
      await mocks.runtimes.get("remote:1")!.client.api.getFolder(1)
    })
    await act(async () => {
      await mocks.runtimes.get("remote:2")!.client.api.getFolder(1)
    })
    await waitFor(() =>
      expect(mocks.restore).toHaveBeenCalledWith(
        "remote:2",
        "/same/file.ts",
        expect.any(Number)
      )
    )
    expect(
      mocks.restore.mock.calls.filter(([key]) => key === "remote:1")
    ).toEqual([])
    expect(
      screen.queryByRole("tab", { name: /old A|old conversation/ })
    ).toBeNull()
    expect(readWindowLayout().files).toEqual([b])
    expect(readWindowLayout().selected).toBeNull()
    expect(
      readWindowTabs().some((tab) => tab.ref.backendKey === "remote:1")
    ).toBe(false)
  })

  it("captures the latest failed-save buffer before a credential repair and exposes persisted read-only copy/export", async () => {
    mount()
    await openFiles()
    fireEvent.click(screen.getAllByRole("button", { name: "Machine A" })[1])
    edit("remote:1", "failed save text")
    mocks.remotes
      .get(1)!
      .call.mockRejectedValueOnce({ code: "authentication_failed" })
    fireEvent.click(screen.getByRole("button", { name: "Save remote:1" }))
    await screen.findByText("Save failed")
    // Content-only edit keeps RuntimeView identity but recovery must read it.
    const oldA = mocks.runtimes.get("remote:1")!
    const snapshot = oldA.getSnapshot()
    edit("remote:1", "latest failed save text\nwith all lines")
    expect(oldA.getSnapshot()).toBe(snapshot)
    mocks.list.mockResolvedValue([
      { ...connection(1), token: "repaired", config_revision: "repaired" },
      connection(2),
    ])
    act(() => mocks.remotes.get(1)!.config.onConfigurationChanged?.())
    const recovery = await findRecovery(
      "latest failed save text\nwith all lines"
    )
    expect(recovery).toHaveAttribute("readonly")
    const record = runtimeRecoveryStore
      .getSnapshot()
      .find(
        (value) => value.content === "latest failed save text\nwith all lines"
      )!
    expect(record).toMatchObject({
      backendKey: "remote:1",
      machineName: "Machine A",
      destination: "http://machine-1:3080/",
      path: "/same/file.ts",
      persisted: true,
    })
    const reloaded = new RuntimeRecoveryStore()
    reloaded.reload()
    expect(reloaded.getSnapshot()).toContainEqual(record)
    const copy = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: copy },
    })
    fireEvent.click(
      within(recovery.closest("details")!).getByRole("button", {
        name: "Copy text",
      })
    )
    expect(copy).toHaveBeenCalledWith(record.content)
    fireEvent.click(
      within(recovery.closest("details")!).getByRole("button", {
        name: "Export recovery",
      })
    )
    expect(mocks.export).toHaveBeenCalledWith(
      expect.objectContaining({
        content: JSON.stringify(record, null, 2),
        suggestedName: "file.ts.recovery.json",
        ext: "json",
      })
    )
    await expect(
      oldA.client.api.saveFileContent("/same", "file.ts", record.content)
    ).rejects.toMatchObject({ code: "backend_retired" })
    expect(
      mocks.remotes
        .get(1)!
        .call.mock.calls.some(([command]) => command === "save_file_content")
    ).toBe(false)
    expect(
      mocks.shell.call.mock.calls.some(([command]) =>
        /cancel|kill|disconnect/.test(command)
      )
    ).toBe(false)
  })

  it.each(["error", "saving"] as const)(
    "preserves a %s file even when its dirty flag is false",
    async (saveState) => {
      mount()
      await screen.findByTestId("replacement-remote:1")
      fireEvent.click(screen.getAllByRole("button", { name: "Machine A" })[1])
      fireEvent.click(
        screen.getByRole("button", { name: `${saveState} file remote:1` })
      )
      mocks.list.mockResolvedValue([connection(2)])
      fireEvent(window, new Event("focus"))
      expect(
        await findRecovery(`${saveState} buffer without dirty flag`)
      ).toHaveAttribute("readonly")
      expect(screen.queryByTestId("replacement-remote:1")).toBeNull()
    }
  )

  it("keeps a complete explicit memory recovery when storage fails during outside-window deletion", async () => {
    const mounted = mount()
    await openFiles()
    fireEvent.click(screen.getAllByRole("button", { name: "Machine A" })[1])
    edit("remote:1", "memory only deletion buffer")
    const b = screen.getByTestId("replacement-remote:2")
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota")
    })
    mocks.list.mockResolvedValue([connection(2)])
    fireEvent(window, new Event("focus"))
    const recovery = await findRecovery("memory only deletion buffer")
    expect(recovery).toHaveAttribute("readonly")
    expect(
      screen.getByText(messages.MultiHost.recoveryMemoryOnly)
    ).toBeVisible()
    expect(screen.queryByTestId("replacement-remote:1")).toBeNull()
    expect(screen.getByTestId("replacement-remote:2")).toBe(b)
    const record = runtimeRecoveryStore
      .getSnapshot()
      .find((value) => value.content === "memory only deletion buffer")!
    expect(record.persisted).toBe(false)
    mounted.unmount()
    mount()
    expect(await findRecovery("memory only deletion buffer")).toHaveAttribute(
      "readonly"
    )
  })

  it("preserves live composer text and reference markup when scoped draft writes are unavailable", async () => {
    mount()
    await screen.findByTestId("replacement-remote:1")
    fireEvent.click(screen.getAllByRole("button", { name: "Machine A" })[1])
    const html =
      '<p>Unsent text <span data-type="reference" data-path="/old/a.ts">a.ts</span></p>'
    screen.getByLabelText("Composer remote:1").innerHTML = html
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied")
    })
    mocks.list.mockResolvedValue([
      {
        ...connection(1),
        base_url: "http://composer-replacement:3080",
        config_revision: "new-composer",
      },
      connection(2),
    ])
    fireEvent(window, new Event("focus"))
    expect(await findRecovery(html)).toHaveAttribute("readonly")
    expect(
      runtimeRecoveryStore
        .getSnapshot()
        .find((record) => record.content === html)
    ).toMatchObject({
      backendKey: "remote:1",
      destination: "http://machine-1:3080/",
      kind: "composer",
      language: "html",
      persisted: false,
    })
    expect(screen.getByLabelText("Composer remote:1").innerHTML).toBe("")
    expect(mocks.remotes.get(1)!.call).not.toHaveBeenCalled()
  })
})
