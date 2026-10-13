import { describe, expect, it, vi } from "vitest"
import { BackendRegistry } from "./registry"
import { BackendRuntime } from "./runtime"
import {
  resolveCatalogRuntime,
  selectFolderContext,
  openExistingConversation,
} from "./project-navigation"
import type {
  DbConversationSummary,
  FolderDetail,
  RemoteWorkspaceConnection,
} from "@/lib/types"

const folder: FolderDetail = {
  id: 1,
  name: "repo",
  path: "/repo",
  parent_id: null,
  kind: "regular",
  git_branch: "main",
  default_agent_type: "codex",
  alias: null,
  group_id: null,
  color: "",
  sort_order: 0,
  last_opened_at: "",
}
const conversation = {
  id: 1,
  folder_id: 1,
  agent_type: "codex",
  title: "Existing",
  kind: "regular",
  status: "completed",
  pinned_at: "2026-01-01",
} as DbConversationSummary
const connection = (id: number): RemoteWorkspaceConnection => ({
  id,
  name: String(id),
  base_url: `http://machine-${id}`,
  token: "",
  headers: [],
  config_revision: "1",
  sort_order: 0,
  created_at: "",
  updated_at: "",
})
const transport = () => ({
  call: vi.fn().mockResolvedValue([]),
  subscribe: vi.fn().mockResolvedValue(() => {}),
  destroy: vi.fn(),
  isDesktop: () => true,
})

it("selects folder without a draft and opens original A history while B is focused with equal IDs", () => {
  const registry = new BackendRegistry(
    (target, lifetime) =>
      new BackendRuntime(target, lifetime, {
        shellTransport: transport(),
        createRemoteTransport: transport,
        windowInstanceId: "test",
      })
  )
  registry.syncRemoteConnections([connection(1), connection(2)])
  const a = registry.get("remote:1")!,
    b = registry.get("remote:2")!
  for (const runtime of [a, b])
    runtime.stores.workspace.setState({
      folders: [folder],
      allFolders: [folder],
      conversations: [conversation],
    })
  const openA = vi.spyOn(a.stores.tabs.getState(), "openTab"),
    openB = vi.spyOn(b.stores.tabs.getState(), "openTab")
  selectFolderContext(b, folder)
  selectFolderContext(a, folder)
  expect(a.stores.tabs.getState().tabs).toHaveLength(0)
  expect(b.stores.tabs.getState().tabs).toHaveLength(0)
  const owner = resolveCatalogRuntime(
    registry,
    "remote:1",
    a.generation,
    folder
  )!
  openExistingConversation(owner, folder, conversation)
  expect(openA).toHaveBeenCalledWith(1, 1, "codex", false, "Existing")
  expect(openB).not.toHaveBeenCalled()
  expect(a.stores.tabs.getState().tabs[0].conversationId).toBe(1)
  a.stores.tabs.getState().openNewConversationTab(1, "/repo")
  expect(
    a.stores.tabs.getState().tabs.filter((t) => t.conversationId === null)
  ).toHaveLength(1)
  registry.dispose()
})

describe("captured catalog action fences", () => {
  it("rejects replacement generations before resolving runtime and rejects reused folder paths", () => {
    const registry = new BackendRegistry(
      (target, lifetime) =>
        new BackendRuntime(target, lifetime, {
          shellTransport: transport(),
          createRemoteTransport: transport,
          windowInstanceId: "test",
        })
    )
    registry.syncRemoteConnections([connection(1)])
    const old = registry.get("remote:1")!
    old.stores.workspace.setState({ allFolders: [folder], folders: [folder] })
    const get = vi.spyOn(registry, "get")
    expect(
      resolveCatalogRuntime(registry, "remote:1", old.generation + 1, folder)
    ).toBeNull()
    expect(get).not.toHaveBeenCalled()
    old.stores.workspace.setState({
      allFolders: [{ ...folder, path: "/changed" }],
    })
    expect(
      resolveCatalogRuntime(registry, "remote:1", old.generation, folder)
    ).toBeNull()
    registry.upsert({
      key: "remote:1",
      name: "new",
      connection: { ...connection(1), token: "changed" },
    })
    get.mockClear()
    expect(
      resolveCatalogRuntime(registry, "remote:1", old.generation, folder)
    ).toBeNull()
    expect(get).not.toHaveBeenCalled()
    registry.dispose()
  })
})
