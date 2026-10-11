import { useEffect, useMemo, useState } from "react"
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MultiHostWorkspace } from "./multi-host-workspace"
import { useBackendClient } from "@/contexts/backend-client-context"
import { useBackendStores } from "@/contexts/backend-stores-context"
import { useWorkspaceRuntimeVisibility } from "@/contexts/workspace-runtime-visibility-context"
import { useRemoteConnection } from "@/contexts/remote-connection-context"
import type { BackendRuntime, RuntimeView } from "@/lib/backend/runtime"
import type { WindowResourceRef } from "@/lib/backend/window-layout"
import type { BackendKey } from "@/lib/backend/types"
import type { RemoteTransportConfig } from "@/lib/transport"
import type { FolderDetail, RemoteWorkspaceConnection } from "@/lib/types"
import type { WorkbenchRouteId } from "@/contexts/workbench-route-context"
import {
  emptyWindowLayout,
  readWindowLayout,
  saveWindowLayout,
} from "@/lib/backend/window-layout"
import { readWindowTabs, saveWindowTabs } from "@/lib/backend/runtime"
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
  list: vi.fn(),
  unmount: vi.fn(),
}))
vi.mock("next-intl", async (original) => ({
  ...(await original<typeof import("next-intl")>()),
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
    call = vi.fn().mockResolvedValue({ id: 1 })
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
vi.mock("@/components/layout/window-controls", () => ({
  WindowControls: () => <button>Window controls</button>,
}))
vi.mock("@/components/ui/app-toaster", () => ({
  AppToaster: () => <div data-testid="toaster" />,
}))
vi.mock("@/components/layout/remote-workspace-manage-dialog", () => ({
  RemoteWorkspaceManageDialog: () => null,
}))
vi.mock("@/components/layout/workspace-folder-dialog", () => ({
  WorkspaceFolderDialog: () => <FolderPicker />,
}))
vi.mock("./host-worktree-dialog", () => ({ HostWorktreeDialog: () => null }))

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
function folder(name: string): FolderDetail {
  return {
    id: 1,
    name,
    path: "/same/repo",
    kind: "regular",
    git_branch: "main",
    parent_id: null,
    group_id: null,
    alias: null,
    default_agent_type: null,
    color: "gray",
    last_opened_at: "",
    sort_order: 0,
  }
}
function FolderPicker() {
  const client = useBackendClient()
  return (
    <button
      onClick={() => {
        void client.api.openFolder("/remote/new-repo")
      }}
    >
      Pick on {client.key}
    </button>
  )
}

function Probe({ runtime }: { runtime: BackendRuntime }) {
  const client = useBackendClient()
  const stores = useBackendStores()
  const visibility = useWorkspaceRuntimeVisibility()
  const remote = useRemoteConnection()
  const [routeId, navigate] = useState<WorkbenchRouteId>("conversations")
  const [selected, select] = useState<WindowResourceRef>({
    backendKey: client.key,
    kind: "conversation",
    id: "conversation-1",
    folderId: 1,
  })
  const [files, setFiles] = useState(true)
  const view = useMemo<RuntimeView>(
    () => ({
      hydrated: true,
      tabs: [
        {
          ref: {
            backendKey: client.key,
            kind: "conversation",
            id: "conversation-1",
            folderId: 1,
          },
          title: "Same conversation",
          machineName: client.name,
        },
        ...(files
          ? [
              {
                ref: {
                  backendKey: client.key,
                  kind: "file" as const,
                  id: "file:/same/file.ts",
                  path: "/same/file.ts",
                },
                title: "file.ts",
                machineName: client.name,
              },
            ]
          : []),
      ],
      selected,
      routeId,
      sidebarOpen: false,
      terminalOpen: false,
      auxOpen: false,
      select,
      close: (ref) => {
        if (ref.kind === "file") setFiles(false)
      },
      restoreFile: async () => {
        setFiles(true)
      },
      navigate,
      search: () => {},
      toggleSidebar: () => {},
      toggleTerminal: () => {},
      toggleAux: () => {},
    }),
    [client, selected, routeId, files]
  )
  useEffect(() => {
    runtime.publishView(view)
  }, [runtime, view])
  useEffect(() => {
    stores.workspace.setState({
      allFolders: [folder(client.name)],
      folders: [folder(client.name)],
      foldersLoading: false,
    })
    return () => {
      mocks.unmount(client.key)
    }
  }, [client, stores])
  return (
    <div
      data-testid={`probe-${client.key}`}
      data-visible={visibility.visible}
      data-focused={visibility.focused}
    >
      <span>
        {client.key} · {remote?.connection?.id ?? "local"} · {routeId}
      </span>
      <button
        onClick={() => {
          void client.transport.call("acp_prompt", {
            connectionId: "same",
            text: client.key,
          })
        }}
      >
        Send {client.key}
      </button>
      <button
        onClick={() => {
          void client.api.acpRespondPermission("same", "same", "allow")
        }}
      >
        Approve {client.key}
      </button>
    </div>
  )
}

beforeEach(() => {
  localStorage.clear()
  mocks.remotes.clear()
  mocks.unmount.mockClear()
  mocks.shell.call.mockClear()
  mocks.list.mockResolvedValue([connection(1), connection(2)])
})
afterEach(() => vi.clearAllMocks())

function hostNode(key: BackendKey) {
  return document.querySelector(
    `section[data-backend-key="${key}"]`
  )! as HTMLElement
}
async function mount() {
  const result = render(
    <MultiHostWorkspace
      renderWorkspace={(runtime) => <Probe runtime={runtime} />}
    />
  )
  await screen.findByTestId("probe-remote:2")
  await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(6))
  return result
}

describe("single-window machine integration", () => {
  it("retains all provider trees through machine selection, both splits and collapse", async () => {
    const result = await mount()
    const a = screen.getByTestId("probe-remote:1")
    const b = screen.getByTestId("probe-remote:2")
    fireEvent.click(
      within(hostNode("remote:1")).getAllByRole("button", {
        name: "Machine A",
      })[1]
    )
    expect(a).toHaveAttribute("data-visible", "true")
    expect(b).toHaveAttribute("data-visible", "false")
    expect(b.closest("[data-runtime-generation]")).toHaveAttribute("inert")
    fireEvent.click(screen.getByRole("button", { name: "Side by side" }))
    fireEvent.change(screen.getByLabelText("Second machine"), {
      target: { value: "remote:2" },
    })
    expect(a).toHaveAttribute("data-visible", "true")
    expect(b).toHaveAttribute("data-visible", "true")
    fireEvent.click(screen.getByRole("button", { name: "Top and bottom" }))
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-orientation",
      "horizontal"
    )
    fireEvent.click(screen.getByRole("button", { name: "Single view" }))
    expect(screen.getByTestId("probe-remote:1")).toBe(a)
    expect(screen.getByTestId("probe-remote:2")).toBe(b)
    expect(mocks.unmount).not.toHaveBeenCalled()
    expect(mocks.remotes.get(1)?.destroy).not.toHaveBeenCalled()
    expect(mocks.remotes.get(2)?.destroy).not.toHaveBeenCalled()
    expect(
      screen.getAllByRole("button", { name: "Window controls" })
    ).toHaveLength(1)
    expect(screen.getAllByTestId("toaster")).toHaveLength(1)
    result.unmount()
    expect(mocks.remotes.get(1)?.destroy).toHaveBeenCalledOnce()
    expect(mocks.remotes.get(2)?.destroy).toHaveBeenCalledOnce()
  })

  it("routes duplicate-ID sends and approvals independently and keeps B alive after A fails", async () => {
    await mount()
    fireEvent.click(
      within(hostNode("remote:1")).getAllByRole("button", {
        name: "Machine A",
      })[1]
    )
    fireEvent.click(screen.getByRole("button", { name: "Side by side" }))
    fireEvent.change(screen.getByLabelText("Second machine"), {
      target: { value: "remote:2" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send remote:1" }))
    fireEvent.click(screen.getByRole("button", { name: "Send remote:2" }))
    fireEvent.click(screen.getByRole("button", { name: "Approve remote:1" }))
    fireEvent.click(screen.getByRole("button", { name: "Approve remote:2" }))
    await waitFor(() =>
      expect(mocks.remotes.get(2)?.call).toHaveBeenCalledTimes(2)
    )
    expect(mocks.remotes.get(1)?.call).toHaveBeenCalledWith(
      "acp_prompt",
      { connectionId: "same", text: "remote:1" },
      undefined
    )
    expect(mocks.remotes.get(2)?.call).toHaveBeenCalledWith(
      "acp_prompt",
      { connectionId: "same", text: "remote:2" },
      undefined
    )
    act(() => {
      mocks.remotes.get(1)!.config.onUnauthorized?.()
    })
    expect(hostNode("remote:1")).toHaveTextContent("Authentication required")
    expect(hostNode("remote:2")).toHaveTextContent("Connected")
    fireEvent.click(screen.getByRole("button", { name: "Send remote:2" }))
    await waitFor(() =>
      expect(mocks.remotes.get(2)?.call).toHaveBeenCalledTimes(3)
    )
    expect(mocks.unmount).not.toHaveBeenCalled()
  })

  it("selects actual machine tabs, closes files without reopening them and binds the repository picker", async () => {
    await mount()
    const tablist = screen.getByRole("tablist")
    fireEvent.click(
      within(tablist).getByRole("tab", { name: "file.ts Machine A" })
    )
    expect(screen.getByTestId("probe-remote:1")).toHaveAttribute(
      "data-visible",
      "true"
    )
    const selectedTab = within(tablist).getByRole("tab", {
      name: "file.ts Machine A",
    })
    expect(selectedTab).toHaveAttribute("aria-selected", "true")
    fireEvent.click(
      within(selectedTab.parentElement!).getByRole("button", {
        name: "Close · file.ts",
      })
    )
    await waitFor(() =>
      expect(
        within(tablist).queryByRole("tab", { name: "file.ts Machine A" })
      ).toBeNull()
    )
    fireEvent.click(
      within(tablist).getByRole("tab", { name: "file.ts Machine B" })
    )
    expect(screen.getByTestId("probe-remote:2")).toHaveAttribute(
      "data-visible",
      "true"
    )
    fireEvent.click(
      within(hostNode("remote:1")).getByRole("button", {
        name: "Open repository",
      })
    )
    fireEvent.click(screen.getByRole("button", { name: "Pick on remote:1" }))
    await waitFor(() =>
      expect(mocks.remotes.get(1)?.call).toHaveBeenCalledWith(
        "open_folder",
        { path: "/remote/new-repo" },
        undefined
      )
    )
    expect(mocks.remotes.get(2)?.call).not.toHaveBeenCalledWith(
      "open_folder",
      expect.anything(),
      undefined
    )
  })

  it("restores machine positions, selection and cross-machine tab order", async () => {
    const selected: WindowResourceRef = {
      backendKey: "remote:2",
      kind: "file",
      id: "file:/same/file.ts",
      path: "/same/file.ts",
    }
    saveWindowLayout({
      ...emptyWindowLayout("remote:1"),
      secondary: "remote:2",
      split: "vertical",
      selected,
      files: [selected],
      destinations: {
        "remote:1": connection(1).base_url,
        "remote:2": connection(2).base_url,
      },
    })
    saveWindowTabs([
      { ref: selected, title: "file.ts", machineName: "Machine B" },
    ])
    await mount()
    expect(screen.getByTestId("probe-remote:1")).toHaveAttribute(
      "data-visible",
      "true"
    )
    expect(screen.getByTestId("probe-remote:2")).toHaveAttribute(
      "data-visible",
      "true"
    )
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-orientation",
      "horizontal"
    )
    expect(screen.getAllByRole("tab")[0]).toHaveTextContent("Machine B")
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "file.ts Machine B" })
      ).toHaveAttribute("aria-selected", "true")
    )
    const b = screen
      .getByTestId("probe-remote:2")
      .closest("[data-runtime-generation]")! as HTMLElement
    fireEvent.change(within(b).getByLabelText("Workspaces"), {
      target: { value: "tasks" },
    })
    expect(screen.getByTestId("probe-remote:2")).toHaveTextContent("tasks")
    expect(screen.getByTestId("probe-remote:1")).toHaveTextContent(
      "conversations"
    )
  })

  it("replaces only a changed generation and clears only the deleted machine's resources", async () => {
    await mount()
    const beforeB = screen.getByTestId("probe-remote:2")
    const oldA = mocks.remotes.get(1)!
    mocks.list.mockResolvedValue([
      {
        ...connection(1),
        config_revision: "new-revision",
        base_url: "http://new-a:3080",
      },
      connection(2),
    ])
    fireEvent(window, new Event("focus"))
    await waitFor(() => expect(oldA.destroy).toHaveBeenCalledOnce())
    expect(mocks.remotes.get(1)).not.toBe(oldA)
    expect(screen.getByTestId("probe-remote:2")).toBe(beforeB)
    expect(mocks.remotes.get(2)?.destroy).not.toHaveBeenCalled()
    mocks.list.mockResolvedValue([connection(2)])
    fireEvent(window, new Event("focus"))
    await waitFor(() =>
      expect(screen.queryByTestId("probe-remote:1")).toBeNull()
    )
    expect(screen.getByTestId("probe-remote:2")).toBe(beforeB)
    expect(screen.queryByRole("tab", { name: "file.ts Machine A" })).toBeNull()
  })

  it("releases all window subscriptions on pagehide without erasing restoration data", async () => {
    await mount()
    await waitFor(() => expect(readWindowLayout().files).toHaveLength(3))
    const layout = readWindowLayout()
    const tabs = readWindowTabs()
    expect(tabs).toHaveLength(6)
    fireEvent(window, new Event("pagehide"))
    await waitFor(() =>
      expect(mocks.remotes.get(1)?.destroy).toHaveBeenCalledOnce()
    )
    expect(mocks.remotes.get(2)?.destroy).toHaveBeenCalledOnce()
    expect(readWindowLayout()).toEqual(layout)
    expect(readWindowTabs()).toEqual(tabs)
  })
})
