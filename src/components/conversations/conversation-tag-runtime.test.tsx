import { type ReactNode } from "react"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import { BackendClientProvider } from "@/contexts/backend-client-context"
import { BackendStoresProvider } from "@/contexts/backend-stores-context"
import { createBackendClient } from "@/lib/backend/client"
import { createBackendStores, type BackendStores } from "@/lib/backend/stores"
import { useChangeConversationTags } from "@/lib/conversation-tag-assignment"
import type { Transport } from "@/lib/transport/types"
import {
  CONVERSATION_TAG_CHANGED_EVENT,
  type ConversationBranchTag,
  type ConversationTagChange,
  type ConversationTagDetail,
  type DbConversationSummary,
  type FolderDetail,
} from "@/lib/types"
import { useBranchChip, useResolvedTags } from "@/hooks/use-conversation-tags"
import { ConversationTagsSync } from "@/stores/conversation-tags-store"
import { ConversationHeaderTags } from "./conversation-tag-picker"
import {
  ConversationTagsManagerHost,
  resetConversationTagsManagerForTests,
  useOpenConversationTagsManager,
} from "./conversation-tags-manager"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

const owned: BackendStores[] = []
function host(name: string, id: number, color = "#0969da") {
  let tags: ConversationTagDetail[] = [
    { id: 1, folder_id: null, name, color, sort_order: 1 },
  ]
  let branch: ConversationBranchTag = { enabled: true, color }
  const conversation = {
    id: 1,
    folder_id: 1,
    title: `${name} session`,
    tag_ids: [1],
    git_branch: "main",
  } as DbConversationSummary
  const handlers: ((change: ConversationTagChange) => void)[] = []
  const reconnects: (() => void)[] = []
  const unlisten = vi.fn(),
    offReconnect = vi.fn()
  const call = vi.fn(
    async (
      command: string,
      args?: Record<string, unknown>
    ): Promise<unknown> => {
      switch (command) {
        case "list_conversation_tags":
          return tags
        case "get_conversation_branch_tag":
          return branch
        case "update_conversation_branch_tag":
          branch = args as unknown as ConversationBranchTag
          return branch
        case "update_conversation_tags":
          return conversation
        case "list_all_conversations":
          return [conversation]
        case "create_conversation_tag": {
          const tag = {
            id: 2,
            folder_id: args?.folderId ?? null,
            name: args?.name,
            color: args?.color,
            sort_order: 2,
          } as ConversationTagDetail
          tags = [...tags, tag]
          return tag
        }
        case "update_conversation_tag": {
          const tag = { ...tags[0], name: args?.name } as ConversationTagDetail
          tags = [tag]
          return tag
        }
        case "delete_conversation_tag":
          tags = []
          return undefined
        case "reorder_conversation_tags":
          return undefined
        default:
          throw new Error(`Unexpected command: ${command}`)
      }
    }
  )
  const subscribe = vi.fn(async (event: string, handler: unknown) => {
    expect(event).toBe(CONVERSATION_TAG_CHANGED_EVENT)
    handlers.push(handler as (change: ConversationTagChange) => void)
    return unlisten
  })
  const transport = {
    call,
    subscribe,
    isDesktop: () => false,
    onReconnect(callback: () => void) {
      reconnects.push(callback)
      return offReconnect
    },
  } as unknown as Transport
  const client = createBackendClient({
    key: `remote:${id}`,
    name,
    transport,
    remoteConnectionId: id,
    token: "",
  })
  const stores = createBackendStores(client)
  owned.push(stores)
  const folder = {
    id: 1,
    name: `${name} folder`,
    path: "/same/repo",
    parent_id: null,
    kind: "regular",
  } as FolderDetail
  stores.workspace.setState({
    folders: [folder],
    allFolders: [folder],
    foldersHydrated: true,
    conversations: [conversation],
    activeFolderId: 1,
  })
  return {
    client,
    stores,
    call,
    subscribe,
    handlers,
    reconnects,
    unlisten,
    offReconnect,
  }
}

function Probe({ name }: { name: string }) {
  const tags = useResolvedTags([1]),
    branch = useBranchChip("main")
  const change = useChangeConversationTags(),
    open = useOpenConversationTagsManager()
  return (
    <div data-testid={`probe-${name}`}>
      <span>{tags.map((tag) => tag.name).join(",")}</span>
      <span data-testid={`branch-${name}`}>{branch?.color}</span>
      <button onClick={() => void change(1, { add: [2] })}>
        Assign {name}
      </button>
      <button onClick={() => open({ folderId: 1 })}>Manage {name}</button>
      <ConversationHeaderTags
        conversationId={1}
        folderId={1}
        tagIds={[1]}
        gitBranch="main"
        max={3}
      />
      <ConversationTagsSync />
      <ConversationTagsSync />
      <ConversationTagsManagerHost />
    </div>
  )
}
function Runtime({
  runtime,
  children,
}: {
  runtime: ReturnType<typeof host>
  children: ReactNode
}) {
  return (
    <BackendClientProvider client={runtime.client}>
      <BackendStoresProvider stores={runtime.stores}>
        {children}
      </BackendStoresProvider>
    </BackendClientProvider>
  )
}
function pair(a: ReturnType<typeof host>, b: ReturnType<typeof host>) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <Runtime runtime={a}>
        <Probe name="A" />
      </Runtime>
      <Runtime runtime={b}>
        <Probe name="B" />
      </Runtime>
    </NextIntlClientProvider>
  )
}
beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  })
})
afterEach(() => {
  cleanup()
  resetConversationTagsManagerForTests()
  for (const stores of owned.splice(0)) stores.dispose()
  vi.unstubAllGlobals()
})

describe("mounted conversation tags across backend runtimes", () => {
  it("isolates colliding IDs, events, reconnects, assignments and manager mutations", async () => {
    const a = host("A tag", 1),
      b = host("B tag", 2, "#cf222e")
    render(pair(a, b))
    await waitFor(() =>
      expect(
        within(screen.getByTestId("probe-A")).getAllByText("A tag")
      ).toHaveLength(2)
    )
    expect(
      within(screen.getByTestId("probe-B")).getAllByText("B tag")
    ).toHaveLength(2)
    expect(screen.getByTestId("branch-A")).toHaveTextContent("#0969da")
    expect(screen.getByTestId("branch-B")).toHaveTextContent("#cf222e")
    expect(a.subscribe).toHaveBeenCalledTimes(1)
    expect(b.subscribe).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: "Assign A" }))
    expect(a.stores.workspace.getState().conversations[0].tag_ids).toEqual([
      1, 2,
    ])
    expect(b.stores.workspace.getState().conversations[0].tag_ids).toEqual([1])
    expect(a.call).toHaveBeenCalledWith("update_conversation_tags", {
      conversationId: 1,
      add: [2],
      remove: [],
    })
    expect(
      b.call.mock.calls.some(
        ([command]) => command === "update_conversation_tags"
      )
    ).toBe(false)
    const beforeB = b.call.mock.calls.length
    await act(async () => a.reconnects[0]())
    expect(b.call).toHaveBeenCalledTimes(beforeB)
    expect(
      a.call.mock.calls.filter(
        ([command]) => command === "list_conversation_tags"
      )
    ).toHaveLength(2)
    fireEvent.click(screen.getByRole("button", { name: "Manage B" }))
    const dialog = await screen.findByRole("dialog", { name: "Manage tags" })
    expect(screen.getAllByRole("dialog")).toHaveLength(1)
    expect(within(dialog).getByText("B tag")).toBeTruthy()
    expect(within(dialog).queryByText("A tag")).toBeNull()
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Show" }))
    await waitFor(() =>
      expect(b.call).toHaveBeenCalledWith("update_conversation_branch_tag", {
        enabled: false,
        color: "#cf222e",
      })
    )
    expect(
      a.call.mock.calls.some(
        ([command]) => command === "update_conversation_branch_tag"
      )
    ).toBe(false)
    act(() => a.handlers[0]({ kind: "deleted", id: 1 }))
    expect(a.stores.conversationTags.getState().tags).toEqual([])
    expect(b.stores.conversationTags.getState().tagsById.get(1)?.name).toBe(
      "B tag"
    )
    act(() =>
      b.handlers[0]({
        kind: "upsert",
        tag: {
          id: 1,
          folder_id: null,
          name: "B renamed",
          color: "#cf222e",
          sort_order: 1,
        },
      })
    )
    expect(within(dialog).getByText("B renamed")).toBeTruthy()
  })

  it("keeps an in-flight create-and-assign on its original runtime after a provider switch", async () => {
    const a = host("A tag", 1),
      b = host("B tag", 2)
    const view = render(pair(a, b))
    await waitFor(() =>
      expect(
        within(screen.getByTestId("probe-A")).getAllByText("A tag")
      ).toHaveLength(2)
    )
    const creating = deferred<ConversationTagDetail>()
    const originalCall = a.call.getMockImplementation()!
    a.call.mockImplementation((command, args) =>
      command === "create_conversation_tag"
        ? creating.promise
        : originalCall(command, args)
    )
    fireEvent.click(
      within(screen.getByTestId("probe-A")).getByRole("button", {
        name: "Edit tags",
      })
    )
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "created" },
    })
    fireEvent.click(
      screen.getByRole("option", { name: "Create global tag “created”" })
    )
    expect(a.call).toHaveBeenCalledWith("create_conversation_tag", {
      folderId: null,
      name: "created",
      color: expect.any(String),
    })
    view.rerender(pair(b, a))
    await act(async () =>
      creating.resolve({
        id: 2,
        folder_id: null,
        name: "created",
        color: "#0969da",
        sort_order: 2,
      })
    )
    await waitFor(() =>
      expect(a.call).toHaveBeenCalledWith("update_conversation_tags", {
        conversationId: 1,
        add: [2],
        remove: [],
      })
    )
    expect(a.stores.workspace.getState().conversations[0].tag_ids).toEqual([
      1, 2,
    ])
    expect(b.stores.workspace.getState().conversations[0].tag_ids).toEqual([1])
    expect(
      b.call.mock.calls.some(
        ([command]) =>
          command === "create_conversation_tag" ||
          command === "update_conversation_tags"
      )
    ).toBe(false)
  })

  it("drops delayed reads, late events and reconnects after replacing the same backend", async () => {
    const old = host("old tag", 1),
      other = host("other tag", 2)
    const tags = deferred<ConversationTagDetail[]>(),
      branch = deferred<ConversationBranchTag>()
    old.call.mockImplementation((command) => {
      if (command === "list_conversation_tags") return tags.promise
      if (command === "get_conversation_branch_tag") return branch.promise
      throw new Error(command)
    })
    const view = render(pair(old, other))
    await waitFor(() => expect(old.handlers).toHaveLength(1))
    const replacement = host("new tag", 1, "#1a7f37")
    act(() => old.stores.dispose())
    view.rerender(pair(replacement, other))
    await waitFor(() =>
      expect(
        within(screen.getByTestId("probe-A")).getAllByText("new tag")
      ).toHaveLength(2)
    )
    const calls = old.call.mock.calls.length
    await act(async () => {
      tags.resolve([
        {
          id: 1,
          folder_id: null,
          name: "late old tag",
          color: "#cf222e",
          sort_order: 1,
        },
      ])
      branch.resolve({ enabled: true, color: "#cf222e" })
      old.handlers[0]({ kind: "deleted", id: 1 })
      old.reconnects[0]()
    })
    expect(old.call).toHaveBeenCalledTimes(calls)
    expect(old.unlisten).toHaveBeenCalledTimes(1)
    expect(old.offReconnect).toHaveBeenCalledTimes(1)
    expect(old.stores.conversationTags.getState().tags).toEqual([])
    expect(old.stores.conversationTags.getState().loadError).toBeNull()
    expect(
      replacement.stores.conversationTags.getState().tagsById.get(1)?.name
    ).toBe("new tag")
    expect(screen.getByTestId("branch-A")).toHaveTextContent("#1a7f37")
    expect(other.stores.conversationTags.getState().tagsById.get(1)?.name).toBe(
      "other tag"
    )
  })

  it("closes an originating manager on retirement and never hands it to the replacement", async () => {
    const old = host("old tag", 1),
      other = host("other tag", 2)
    const view = render(pair(old, other))
    fireEvent.click(screen.getByRole("button", { name: "Manage A" }))
    const dialog = await screen.findByRole("dialog", { name: "Manage tags" })
    await waitFor(() =>
      expect(
        within(dialog).getByRole("radio", { name: "#cf222e" })
      ).toBeEnabled()
    )
    fireEvent.click(within(dialog).getByRole("radio", { name: "#cf222e" }))
    const replacement = host("new tag", 1)
    act(() => old.stores.dispose())
    view.rerender(pair(replacement, other))
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(
      old.call.mock.calls.some(
        ([command]) => command === "update_conversation_branch_tag"
      )
    ).toBe(false)
    expect(
      replacement.call.mock.calls.some(
        ([command]) => command === "update_conversation_branch_tag"
      )
    ).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "Manage A" }))
    const next = await screen.findByRole("dialog", { name: "Manage tags" })
    await waitFor(() => expect(within(next).getByText("new tag")).toBeTruthy())
    expect(screen.getAllByRole("dialog")).toHaveLength(1)
  })
})
