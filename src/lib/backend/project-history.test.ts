import { describe, expect, it } from "vitest"
import {
  DEFAULT_HISTORY_OPTIONS,
  matchesOwnedTagFilter,
  ownedSession,
  projectHistory,
  pruneOwnedTagFilter,
  sortOwnedSessions,
  type HostTagCatalog,
  type OwnedTagFilter,
} from "./project-history"
import type { BackendKey } from "./types"
import type { ProjectSetup } from "./project-catalog"
import type {
  ConversationTagDetail,
  DbConversationSummary,
  FolderDetail,
} from "@/lib/types"

const hosts = [
  { key: "remote:1" as const, generation: 1 },
  { key: "remote:2" as const, generation: 2 },
]
const tag = (id: number): ConversationTagDetail => ({
  id,
  name: `tag${id}`,
  color: "#0969da",
  folder_id: null,
  sort_order: id,
})
const conversation = (
  id: number,
  tag_ids: number[],
  extra: Partial<DbConversationSummary> = {}
): DbConversationSummary => ({
  id,
  tag_ids,
  folder_id: 1,
  title: `session${id}`,
  title_locked: false,
  kind: "regular",
  agent_type: "codex",
  status: "pending_review",
  model: null,
  git_branch: null,
  external_id: null,
  message_count: 0,
  child_count: 0,
  pinned_at: null,
  created_at: `2026-01-0${id}`,
  updated_at: `2026-02-0${id}`,
  ...extra,
})
const selection: OwnedTagFilter = {
  backendKey: "remote:1",
  generation: 1,
  filter: { tagIds: [1, 2], mode: "any" },
}
const options = { ...DEFAULT_HISTORY_OPTIONS, tagFilter: selection }

describe("owner-qualified history tag filters", () => {
  it("matches ANY/ALL only within the selected backend and generation", () => {
    const rows = [
      ownedSession("remote:1", 1, null, null, conversation(1, [1])),
      ownedSession("remote:1", 1, null, null, conversation(2, [1, 2])),
      ownedSession("remote:2", 2, null, null, conversation(2, [1, 2])),
      ownedSession("remote:1", 3, null, null, conversation(2, [1, 2])),
      ownedSession("remote:1", 1, null, null, conversation(3, [])),
    ]
    expect(sortOwnedSessions(rows, options)).toEqual([rows[1], rows[0]])
    expect(
      sortOwnedSessions(rows, {
        ...options,
        tagFilter: {
          ...selection,
          filter: { ...selection.filter, mode: "all" },
        },
      })
    ).toEqual([rows[1]])
    expect(
      sortOwnedSessions(rows, {
        ...options,
        tagFilter: { ...selection, filter: { tagIds: [], mode: "all" } },
      })
    ).toHaveLength(rows.length)
    expect(matchesOwnedTagFilter("remote:1", 1, {}, selection)).toBe(false)
  })

  it("keeps worktree ownership, pin/completion rules and host-qualified merging", () => {
    const root = { id: 1, path: "/repo" } as FolderDetail
    const child = { id: 2, path: "/repo/wt", parent_id: 1 } as FolderDetail
    const setups: ProjectSetup[] = hosts.map((host) => ({
      backendKey: host.key,
      generation: host.generation,
      folder: root,
      children: [child],
    }))
    const conversations = [
      conversation(1, [1], { status: "completed", pinned_at: "2026" }),
      conversation(2, [2], { folder_id: 2 }),
      conversation(3, [1], { status: "completed" }),
      conversation(4, [], { pinned_at: "2027" }),
      conversation(5, [1], { kind: "chat" }),
      conversation(6, [1], { parent_id: 1 }),
    ]
    const catalogs = new Map(
      hosts.map((host) => [
        host.key,
        { generation: host.generation, conversations },
      ])
    )
    const rows = projectHistory(setups, catalogs, {
      ...options,
      showCompleted: false,
      showWorktrees: false,
    })
    expect(rows.map((row) => row.conversation.id)).toEqual([1, 2])
    expect(rows.every((row) => row.backendKey === "remote:1")).toBe(true)
    expect(rows[1].folder).toBe(child)
    expect(rows[1].root).toBe(root)
    expect(
      projectHistory(setups, catalogs).filter(
        (row) => row.conversation.id === 1
      )
    ).toHaveLength(2)
    catalogs.set("remote:1", { generation: 3, conversations })
    expect(projectHistory(setups, catalogs, options)).toEqual([])
  })

  it("prunes deleted definitions only after their owning generation hydrates", () => {
    const catalogs = new Map<BackendKey, HostTagCatalog>([
      ["remote:1", { generation: 1, tags: [], tagsHydrated: false }],
      [
        "remote:2",
        { generation: 2, tags: [tag(1), tag(2)], tagsHydrated: true },
      ],
    ])
    expect(pruneOwnedTagFilter(selection, hosts, catalogs)).toBe(selection)
    catalogs.set("remote:1", {
      generation: 3,
      tags: [],
      tagsHydrated: true,
    })
    expect(pruneOwnedTagFilter(selection, hosts, catalogs)).toBe(selection)
    catalogs.set("remote:1", {
      generation: 1,
      tags: [tag(2)],
      tagsHydrated: true,
    })
    const pruned = pruneOwnedTagFilter(selection, hosts, catalogs)!
    expect(pruned.filter).toEqual({ tagIds: [2], mode: "any" })
    expect(pruneOwnedTagFilter(pruned, hosts, catalogs)).toBe(pruned)
    catalogs.set("remote:1", {
      generation: 1,
      tags: [],
      tagsHydrated: true,
    })
    const cleared = pruneOwnedTagFilter(pruned, hosts, catalogs)
    expect(cleared?.filter.tagIds).toEqual([])
    expect(matchesOwnedTagFilter("remote:2", 2, {}, cleared)).toBe(true)
  })

  it("retires selections when their machine is removed or replaced", () => {
    expect(pruneOwnedTagFilter(selection, hosts.slice(1), new Map())).toBeNull()
    expect(
      pruneOwnedTagFilter(
        selection,
        [{ ...hosts[0], generation: 3 }, hosts[1]],
        new Map()
      )
    ).toBeNull()
    expect(pruneOwnedTagFilter(null, hosts, new Map())).toBeNull()
  })
})
