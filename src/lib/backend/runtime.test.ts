import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BackendRegistry } from "./registry"
import {
  BackendRuntime,
  createWindowInstanceId,
  readWindowTabs,
  saveWindowTabs,
} from "./runtime"
import type { RemoteTransportConfig } from "@/lib/transport"
import type { RemoteWorkspaceConnection } from "@/lib/types"
import { windowResourceKey } from "./window-layout"

function connection(id: number): RemoteWorkspaceConnection {
  return {
    id,
    name: `Machine ${id}`,
    base_url: `http://machine-${id}:3080`,
    token: `secret-${id}`,
    headers: [],
    config_revision: `revision-${id}`,
    sort_order: id,
    created_at: "",
    updated_at: "",
  }
}

function transport() {
  return {
    call: vi.fn().mockResolvedValue({ id: 1 }),
    subscribe: vi.fn().mockResolvedValue(vi.fn()),
    destroy: vi.fn(),
    isDesktop: () => true,
  }
}

const registries: BackendRegistry<BackendRuntime>[] = []
function setup() {
  const shell = transport()
  const remotes = new Map<number, ReturnType<typeof transport>>()
  const configs = new Map<number, RemoteTransportConfig>()
  const windowInstanceId = createWindowInstanceId()
  const registry = new BackendRegistry(
    (target, lifetime) =>
      new BackendRuntime(target, lifetime, {
        shellTransport: shell,
        windowInstanceId,
        createRemoteTransport(config) {
          const inner = transport()
          remotes.set(config.id, inner)
          configs.set(config.id, config)
          return inner
        },
      })
  )
  registries.push(registry)
  registry.upsert({ key: "local", name: "Local", connection: null })
  registry.syncRemoteConnections([connection(1), connection(2)])
  return { registry, shell, remotes, configs, windowInstanceId }
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose()
})

describe("retained machine runtimes", () => {
  it("creates independent callable stores and binds remote subscriptions to this window", async () => {
    const { registry, shell, remotes, configs, windowInstanceId } = setup()
    const a = registry.get("remote:1")!
    const b = registry.get("remote:2")!
    expect(a.stores.workspace).not.toBe(b.stores.workspace)
    expect(a.stores.tabs).not.toBe(b.stores.tabs)
    a.stores.workspace.getState().setActiveFolderId(1)
    expect(b.stores.workspace.getState().activeFolderId).toBeNull()
    expect(configs.get(1)).toMatchObject({
      windowInstanceId,
      configRevision: "revision-1",
    })
    expect(configs.get(2)?.windowInstanceId).toBe(windowInstanceId)
    expect(createWindowInstanceId()).not.toBe(windowInstanceId)
    await Promise.all([
      a.client.api.acpRespondPermission("same", "request", "allow"),
      b.client.api.acpRespondPermission("same", "request", "deny"),
    ])
    expect(remotes.get(1)?.call).toHaveBeenCalledWith(
      "acp_respond_permission",
      { connectionId: "same", requestId: "request", optionId: "allow" },
      undefined
    )
    expect(remotes.get(2)?.call).toHaveBeenCalledWith(
      "acp_respond_permission",
      { connectionId: "same", requestId: "request", optionId: "deny" },
      undefined
    )
    expect(shell.call).not.toHaveBeenCalled()
  })

  it("keeps an A request on A while B is used and retires stale responses on endpoint replacement", async () => {
    const { registry, remotes } = setup()
    const a = registry.get("remote:1")!
    const b = registry.get("remote:2")!
    let resolve!: (value: unknown) => void
    remotes.get(1)!.call.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const pending = a.client.api.getFolder(1)
    await b.client.api.getFolder(1)
    resolve({ id: 1, name: "A" })
    await expect(pending).resolves.toMatchObject({ name: "A" })
    expect(registry.get("remote:1")).toBe(a)
    remotes.get(1)!.call.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const retired = a.client.api.getFolder(1)
    registry.upsert({
      key: "remote:1",
      name: "New A",
      connection: { ...connection(1), base_url: "http://new-a:3080" },
    })
    resolve({ id: 1, name: "old A" })
    await expect(retired).rejects.toMatchObject({ code: "backend_retired" })
    expect(a.stores.workspace.isDisposed()).toBe(true)
    expect(b.stores.workspace.isDisposed()).toBe(false)
    await expect(b.client.api.getFolder(1)).resolves.toMatchObject({ id: 1 })
  })

  it("binds native transfers and cancellation to the same window instance as subscriptions", async () => {
    const { registry, shell, windowInstanceId } = setup()
    const a = registry.get("remote:1")!
    await a.client.api.uploadWorkspaceLocalPathsToRemote({
      rootPath: "/repo",
      targetPath: "/repo/files",
      entries: [],
    })
    await a.client.api.cancelWorkspaceTransfer("transfer-1")
    expect(shell.call).toHaveBeenCalledWith(
      "remote_upload_workspace_paths",
      expect.objectContaining({
        connectionId: 1,
        configRevision: "revision-1",
        windowInstanceId,
      })
    )
    expect(shell.call).toHaveBeenCalledWith(
      "remote_cancel_workspace_transfer",
      { transferId: "transfer-1", connectionId: 1, windowInstanceId }
    )
  })

  it("clears only a replaced destination's scoped device state, including drafts", () => {
    const { registry, shell, windowInstanceId } = setup()
    const a = registry.get("remote:1")!
    const b = registry.get("remote:2")!
    const draftA =
      "codeg:message-input-draft:v2:" +
      a.stores.storage.drafts.buildNewConversationDraftStorageKey("same")
    const draftB =
      "codeg:message-input-draft:v2:" +
      b.stores.storage.drafts.buildNewConversationDraftStorageKey("same")
    localStorage.setItem(draftA, "old A")
    localStorage.setItem(draftB, "B draft")
    localStorage.setItem(a.stores.storage.key("codeg:selector-prefs"), "old")
    const replacement = new BackendRegistry(
      (target, lifetime) =>
        new BackendRuntime(target, lifetime, {
          shellTransport: shell,
          windowInstanceId,
          resetDestinationState: true,
          createRemoteTransport: () => transport(),
        })
    )
    registries.push(replacement)
    replacement.upsert({
      key: "remote:1",
      name: "New A",
      connection: { ...connection(1), base_url: "http://new-a:3080" },
    })
    expect(localStorage.getItem(draftA)).toBeNull()
    expect(
      localStorage.getItem(a.stores.storage.key("codeg:selector-prefs"))
    ).toBeNull()
    expect(localStorage.getItem(draftB)).toBe("B draft")
  })

  it("isolates unauthorized/disconnected machines and destroys only owned transports once", async () => {
    const { registry, shell, remotes, configs } = setup()
    const a = registry.get("remote:1")!
    const b = registry.get("remote:2")!
    configs.get(1)!.onUnauthorized?.()
    expect(registry.descriptor("remote:1")?.status).toBe("unauthorized")
    await b.client.api.getFolder(1)
    configs.get(1)!.onDisconnected?.()
    expect(registry.descriptor("remote:1")?.status).toBe("offline")
    expect(registry.descriptor("remote:2")?.status).toBe("connected")
    registry.remove("remote:1")
    a.dispose()
    expect(remotes.get(1)?.destroy).toHaveBeenCalledOnce()
    expect(remotes.get(2)?.destroy).not.toHaveBeenCalled()
    expect(shell.destroy).not.toHaveBeenCalled()
    registry.dispose()
    expect(remotes.get(2)?.destroy).toHaveBeenCalledOnce()
    expect(shell.destroy).not.toHaveBeenCalled()
    for (const inner of remotes.values())
      expect(
        inner.call.mock.calls.some(([command]) =>
          /disconnect|terminal_kill/.test(command)
        )
      ).toBe(false)
  })

  it("persists namespaced tab order without credentials, buffers or transient state", () => {
    const tabs = ["remote:2", "remote:1"].flatMap((backendKey) => [
      {
        ref: {
          backendKey,
          kind: "conversation",
          id: "conversation-1",
          folderId: 1,
        },
        title: "Same conversation",
        machineName: "secret-label",
        running: true,
      },
      {
        ref: {
          backendKey,
          kind: "file",
          id: "file:/same/a.ts",
          path: "/same/a.ts",
        },
        title: "a.ts",
        machineName: "secret-label",
        dirty: true,
      },
    ]) as Parameters<typeof saveWindowTabs>[0]
    saveWindowTabs(tabs)
    const loaded = readWindowTabs()
    expect(loaded.map((tab) => windowResourceKey(tab.ref))).toEqual(
      tabs.map((tab) => windowResourceKey(tab.ref))
    )
    const stored = localStorage.getItem("codeg:multi-host-tabs:v1")!
    expect(stored).not.toMatch(/secret|running|dirty|content|token/)
    expect(new Set(loaded.map((tab) => windowResourceKey(tab.ref))).size).toBe(
      4
    )
  })
})

it("owns metadata for root ancestors without probing on conversation/view repaint and retires on configuration change", async () => {
  const { registry, remotes } = setup()
  const a = registry.get("remote:1")!,
    b = registry.get("remote:2")!
  const root = {
    id: 1,
    path: "/a",
    name: "repo",
    parent_id: null,
    kind: "regular",
    alias: null,
    group_id: null,
    git_branch: null,
    default_agent_type: null,
    color: "",
    last_opened_at: "",
    sort_order: 0,
  } as const
  const child = { ...root, id: 2, parent_id: 1, path: "/a-child" }
  remotes.get(1)!.call.mockResolvedValue([
    {
      folder_id: 1,
      path: "/a",
      status: "resolved",
      identity: {
        project_key: "github:o/r",
        repository_path: "o/r",
        provider: "github",
        host: "github.com",
        remote_name: "origin",
      },
    },
  ])
  a.stores.workspace.setState({ folders: [child], allFolders: [root, child] })
  await a.projectIdentities.setFolders([root, child])
  expect(remotes.get(1)!.call).toHaveBeenCalledWith(
    "list_repository_project_identities",
    { folderIds: [1] },
    undefined
  )
  expect(a.projectIdentities.getSnapshot().entries.size).toBe(1)
  expect(b.projectIdentities.getSnapshot().entries.size).toBe(0)
  a.stores.workspace.setState({ conversations: [] })
  a.stores.workspace.getState().setActiveFolderId(2)
  a.publishView({} as Parameters<typeof a.publishView>[0])
  expect(remotes.get(1)!.call).toHaveBeenCalledTimes(1)
  registry.upsert({
    key: "remote:1",
    name: "renamed",
    connection: { ...connection(1), name: "renamed" },
  })
  expect(registry.get("remote:1")).toBe(a)
  expect(a.projectIdentities.getSnapshot().entries.size).toBe(1)
  registry.upsert({
    key: "remote:1",
    name: "replaced",
    connection: { ...connection(1), token: "new" },
  })
  expect(a.projectIdentities.getSnapshot().entries.size).toBe(0)
  expect(
    registry.get("remote:1")?.projectIdentities.getSnapshot().entries.size
  ).toBe(0)
})

it("keeps an old server connected on metadata 404 and refreshes identities after relevant Git remote changes only", async () => {
  const { registry, remotes } = setup()
  const runtime = registry.get("remote:1")!
  const root = {
    id: 1,
    path: "/repo",
    name: "repo",
    kind: "regular",
    parent_id: null,
    alias: null,
    group_id: null,
    git_branch: null,
    default_agent_type: null,
    color: "",
    last_opened_at: "",
    sort_order: 0,
  } as const
  const call = remotes.get(1)!.call
  await runtime.client.api.getFolder(1)
  call.mockClear()
  call.mockRejectedValueOnce({
    code: "network_error",
    message: "Remote returned HTTP 404 Not Found",
  })
  runtime.stores.workspace.setState({ allFolders: [root], folders: [root] })
  await runtime.projectIdentities.setFolders([root])
  expect(runtime.projectIdentities.getSnapshot().capability).toBe("unsupported")
  expect(registry.descriptor("remote:1")?.status).toBe("connected")
  call.mockResolvedValue([])
  await runtime.client.api.gitRemoveRemote("/repo", "origin")
  expect(
    call.mock.calls.filter(
      ([command]) => command === "list_repository_project_identities"
    )
  ).toHaveLength(1)
  await runtime.projectIdentities.refresh()
  expect(runtime.projectIdentities.getSnapshot().capability).toBe("supported")
  await runtime.client.api.gitAddRemote(
    "/unrelated",
    "origin",
    "https://github.com/o/r.git"
  )
  expect(
    call.mock.calls.filter(
      ([command]) => command === "list_repository_project_identities"
    )
  ).toHaveLength(2)
  await runtime.client.api.gitSetRemoteUrl(
    "/repo",
    "origin",
    "https://github.com/o/new.git"
  )
  expect(
    call.mock.calls.filter(
      ([command]) => command === "list_repository_project_identities"
    )
  ).toHaveLength(3)
})
