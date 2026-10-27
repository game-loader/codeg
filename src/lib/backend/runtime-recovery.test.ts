import { beforeEach, describe, expect, it, vi } from "vitest"
import { BackendRegistry } from "./registry"
import {
  BackendRuntime,
  RuntimeRecoveryStore,
  type RuntimeView,
} from "./runtime"
import {
  loadMessageInputDraftV2,
  registerMessageInputDraftReader,
  saveMessageInputDraft,
  saveMessageInputDraftV2,
} from "@/lib/message-input-draft"
import type { RemoteWorkspaceConnection } from "@/lib/types"

function connection(id: number): RemoteWorkspaceConnection {
  return {
    id,
    name: `Machine ${id}`,
    base_url: `http://machine-${id}:3080`,
    token: "private-token",
    headers: [],
    sort_order: id,
    created_at: "",
    updated_at: "",
    config_revision: "old",
  }
}
function recoveryView(
  captureDirtyFiles: NonNullable<RuntimeView["captureDirtyFiles"]>
): RuntimeView {
  const noop = () => {}
  return {
    hydrated: true,
    tabs: [],
    selected: null,
    routeId: "conversations",
    sidebarOpen: false,
    terminalOpen: false,
    auxOpen: false,
    select: noop,
    close: noop,
    restoreFile: async () => {},
    navigate: noop,
    search: noop,
    toggleSidebar: noop,
    toggleTerminal: noop,
    toggleAux: noop,
    captureDirtyFiles,
  }
}
function setup() {
  const recovery = new RuntimeRecoveryStore()
  const transports: Array<{
    call: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
  }> = []
  const destinations = new Map<string, string>()
  const registry = new BackendRegistry((target, lifetime) => {
    const previousDestination = destinations.get(target.key)
    const url = target.connection?.base_url
    const runtime = new BackendRuntime(target, lifetime, {
      shellTransport: {
        call: vi.fn(),
        subscribe: vi.fn().mockResolvedValue(() => {}),
        isDesktop: () => true,
      },
      windowInstanceId: "recovery-test-window",
      recoveryStore: recovery,
      previousDestination,
      resetDestinationState:
        previousDestination !== undefined && url !== previousDestination,
      createRemoteTransport: () => {
        const transport = {
          call: vi.fn().mockResolvedValue({}),
          subscribe: vi.fn().mockResolvedValue(() => {}),
          destroy: vi.fn(),
          isDesktop: () => true,
        }
        transports.push(transport)
        return transport
      },
    })
    if (url) destinations.set(target.key, url)
    return runtime
  })
  registry.syncRemoteConnections([connection(1), connection(2)])
  return { registry, recovery, transports }
}
beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe("retired runtime recovery journal", () => {
  it("retains complete text and old identity before transport teardown without overwriting earlier recoveries", () => {
    const { registry, recovery, transports } = setup()
    const a = registry.get("remote:1")!
    const largeContent = "edited line\n".repeat(40000)
    a.publishView(
      recoveryView(() => {
        expect(transports[0].destroy).not.toHaveBeenCalled()
        return [
          {
            kind: "file",
            sourceId: "file:a",
            path: "/repo/a.ts",
            title: "a.ts",
            content: largeContent,
            saveError: "401",
          },
        ]
      })
    )
    registry.remove("remote:1")
    expect(recovery.getSnapshot()).toHaveLength(1)
    expect(recovery.getSnapshot()[0]).toMatchObject({
      backendKey: "remote:1",
      destination: "http://machine-1:3080/",
      content: largeContent,
      path: "/repo/a.ts",
      saveError: "401",
      persisted: true,
    })
    a.dispose()
    expect(transports[0].destroy).toHaveBeenCalledOnce()
    const reloaded = new RuntimeRecoveryStore()
    reloaded.reload()
    expect(reloaded.getSnapshot()[0].content).toBe(largeContent)
    reloaded.retain(
      {
        backendKey: "remote:1",
        machineName: "Machine 1",
        destination: "http://machine-1:3080",
      },
      {
        kind: "file",
        sourceId: "file:a",
        path: "/repo/a.ts",
        title: "a.ts",
        content: "a later recovery",
      }
    )
    const again = new RuntimeRecoveryStore()
    again.reload()
    expect(again.getSnapshot().map((record) => record.content)).toEqual(
      expect.arrayContaining([largeContent, "a later recovery"])
    )
    registry.dispose()
  })

  it("flushes and recovers unsent live composer drafts before reset, preserves B, and never replays A's draft on a new endpoint", () => {
    const { registry, recovery } = setup()
    const a = registry.get("remote:1")!
    const b = registry.get("remote:2")!
    const keyA =
      a.stores.storage.drafts.buildNewConversationDraftStorageKey(
        "same-live-tab"
      )
    const keyB =
      b.stores.storage.drafts.buildNewConversationDraftStorageKey(
        "same-live-tab"
      )
    a.stores.tabs.setState({
      tabs: [{ id: "same-live-tab", conversationId: null }] as never,
    })
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "unsent live text" }],
        },
      ],
    }
    const unregister = registerMessageInputDraftReader(keyA, () => {
      saveMessageInputDraftV2(keyA, doc)
      return true
    })
    saveMessageInputDraft(keyB, "B unsent text")
    registry.upsert({
      key: "remote:1",
      name: "Replacement",
      connection: {
        ...connection(1),
        base_url: "http://replacement:3080",
        config_revision: "new",
      },
    })
    unregister()
    expect(
      recovery.getSnapshot().find((record) => record.sourceId === keyA)
    ).toMatchObject({
      kind: "composer",
      destination: "http://machine-1:3080/",
      content: JSON.stringify(doc, null, 2),
      persisted: true,
    })
    expect(loadMessageInputDraftV2(keyA)).toBeNull()
    expect(loadMessageInputDraftV2(keyB)).toEqual({
      kind: "legacyMarkdown",
      markdown: "B unsent text",
    })
    expect(registry.get("remote:2")).toBe(b)
    registry.dispose()
  })

  it("archives persisted drafts on reopen before endpoint reset rather than deleting their only copy", () => {
    const recovery = new RuntimeRecoveryStore()
    const draftKey = "backend:remote%3A81:draft:closed-window-draft"
    localStorage.setItem(
      `codeg:message-input-draft:v1:${draftKey}`,
      JSON.stringify({ text: "closed window unsent content" })
    )
    const registry = new BackendRegistry(
      (target, lifetime) =>
        new BackendRuntime(target, lifetime, {
          windowInstanceId: "reopened-window",
          recoveryStore: recovery,
          previousDestination: "http://original:3080",
          resetDestinationState: true,
          shellTransport: {
            call: vi.fn(),
            subscribe: vi.fn().mockResolvedValue(() => {}),
            isDesktop: () => true,
          },
          createRemoteTransport: () => ({
            call: vi.fn(),
            subscribe: vi.fn().mockResolvedValue(() => {}),
            isDesktop: () => true,
          }),
        })
    )
    registry.upsert({
      key: "remote:81",
      name: "A",
      connection: { ...connection(81), base_url: "http://replacement:3080" },
    })
    expect(recovery.getSnapshot()[0]).toMatchObject({
      destination: "http://original:3080/",
      sourceId: draftKey,
      content: "closed window unsent content",
      persisted: true,
    })
    expect(
      localStorage.getItem(`codeg:message-input-draft:v1:${draftKey}`)
    ).toBeNull()
    registry.dispose()
  })

  it("keeps the last file and composer copies in memory when storage is unavailable", () => {
    const { registry, recovery } = setup()
    const a = registry.get("remote:1")!
    const draftKey =
      a.stores.storage.drafts.buildNewConversationDraftStorageKey(
        "memory-draft"
      )
    a.stores.tabs.setState({
      tabs: [{ id: "memory-draft", conversationId: null }] as never,
    })
    const reader = vi.fn(() => {
      saveMessageInputDraft(draftKey, "unpersistable composer")
      return true
    })
    const unregister = registerMessageInputDraftReader(draftKey, reader)
    a.publishView({
      ...recoveryView(() => [
        {
          kind: "file",
          sourceId: "file:memory",
          title: "memory",
          path: "/repo/memory",
          content: "",
        },
      ]),
      captureComposerDrafts: () => [
        {
          kind: "composer",
          sourceId: "composer-document:0",
          title: "composer",
          path: null,
          content: "<p>unpersistable composer</p>",
        },
      ],
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied")
    })
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied")
    })
    registry.remove("remote:1")
    expect(reader).toHaveBeenCalled()
    unregister()
    recovery.reload()
    expect(recovery.getSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "file",
          content: "",
          persisted: false,
        }),
        expect.objectContaining({
          kind: "composer",
          content: "<p>unpersistable composer</p>",
          persisted: false,
        }),
      ])
    )
    registry.dispose()
  })

  it("omits endpoint credentials and tolerates corrupt unrelated recovery records", () => {
    const recovery = new RuntimeRecoveryStore()
    const record = recovery.retain(
      {
        backendKey: "remote:9",
        machineName: "A",
        destination: "https://user:secret@host/api?token=private#private",
      },
      {
        kind: "file",
        sourceId: "a",
        title: "a",
        path: "/a",
        content: "recover this",
      }
    )
    expect(record.destination).toBe("https://host/api")
    expect(JSON.stringify(record)).not.toMatch(/secret|private|user:/)
    localStorage.setItem("codeg:multi-host-recovery:v1:bad", "corrupt")
    const reloaded = new RuntimeRecoveryStore()
    reloaded.reload()
    expect(reloaded.getSnapshot()).toEqual([record])
  })
})
