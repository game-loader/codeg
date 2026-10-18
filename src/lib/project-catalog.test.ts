import { describe, expect, it, vi } from "vitest"
import type { BackendClient } from "@/lib/backend-client"
import {
  buildProjectCatalog,
  loadBackendCatalogSnapshot,
  mergeCatalogRound,
  needsMachineLabel,
  sidebarProjectView,
  type BackendCatalogSnapshot,
} from "./project-catalog"
import type { FolderDetail, GitRemote } from "@/lib/types"

function folder(overrides: Partial<FolderDetail> & { id: number }) {
  return {
    name: `f${overrides.id}`,
    path: `/work/f${overrides.id}`,
    git_branch: null,
    default_agent_type: null,
    last_opened_at: "2026-10-16T00:00:00Z",
    sort_order: overrides.id,
    color: "",
    parent_id: null,
    kind: "regular",
    alias: null,
    group_id: null,
    ...overrides,
  } as FolderDetail
}

const CODEG: GitRemote[] = [
  { name: "origin", url: "git@github.com:game-loader/codeg.git" },
]

function snapshot(
  backendKey: BackendCatalogSnapshot["backendKey"],
  folders: FolderDetail[],
  remotes: Record<number, GitRemote[]> = {}
): BackendCatalogSnapshot {
  return {
    backendKey,
    folders,
    remotesByFolderId: new Map(
      Object.entries(remotes).map(([id, r]) => [Number(id), r])
    ),
  }
}

describe("buildProjectCatalog", () => {
  // Both machines reuse folder id 1: ids are only unique per backend.
  it("merges one repository checked out on two machines", () => {
    const catalog = buildProjectCatalog([
      snapshot("local", [folder({ id: 1, name: "codeg" })], { 1: CODEG }),
      snapshot("remote:4", [folder({ id: 1, name: "codeg-nas" })], {
        1: [{ name: "origin", url: "https://github.com/game-loader/codeg" }],
      }),
    ])
    expect(catalog).toHaveLength(1)
    const [project] = catalog
    expect(project.key).toBe("git:github.com/game-loader/codeg")
    expect(project.displayName).toBe("codeg")
    expect(project.backendKeys).toEqual(["local", "remote:4"])
    expect(project.placements.map((p) => p.folder.name)).toEqual([
      "codeg",
      "codeg-nas",
    ])
    expect(needsMachineLabel(project)).toBe(true)
  })

  it("never merges folders without a remote, even with the same name", () => {
    const catalog = buildProjectCatalog([
      snapshot("local", [folder({ id: 1, name: "notes" })]),
      snapshot("remote:4", [folder({ id: 1, name: "notes" })]),
    ])
    expect(catalog.map((p) => p.key)).toEqual([
      "local:local:1",
      "local:remote:4:1",
    ])
    expect(catalog.every((p) => !needsMachineLabel(p))).toBe(true)
  })

  it("nests worktrees under their root and hides chat folders", () => {
    const catalog = buildProjectCatalog([
      snapshot(
        "local",
        [
          folder({ id: 1, name: "codeg" }),
          folder({ id: 3, name: "codeg-b", parent_id: 1, sort_order: 9 }),
          folder({ id: 2, name: "codeg-a", parent_id: 1, sort_order: 5 }),
          folder({ id: 5, name: "chat", kind: "chat" }),
        ],
        { 1: CODEG }
      ),
    ])
    expect(catalog).toHaveLength(1)
    expect(catalog[0].placements[0].worktrees.map((w) => w.name)).toEqual([
      "codeg-a",
      "codeg-b",
    ])
  })

  it("shows a worktree whose root is closed as its own root", () => {
    const catalog = buildProjectCatalog([
      snapshot("local", [folder({ id: 2, parent_id: 1 })], { 2: CODEG }),
    ])
    expect(catalog).toHaveLength(1)
    expect(catalog[0].key).toBe("git:github.com/game-loader/codeg")
  })

  it("prefers the alias for the display name", () => {
    const [project] = buildProjectCatalog([
      snapshot("local", [folder({ id: 1, name: "codeg", alias: " Main " })]),
    ])
    expect(project.displayName).toBe("Main")
  })
})

describe("sidebarProjectView", () => {
  it("tags own folders with other machines and lists elsewhere-only projects", () => {
    const catalog = buildProjectCatalog([
      snapshot(
        "local",
        [
          folder({ id: 1, name: "codeg" }),
          folder({ id: 2, name: "codeg-wt", parent_id: 1 }),
          folder({ id: 3, name: "notes" }),
        ],
        { 1: CODEG }
      ),
      snapshot(
        "remote:4",
        [folder({ id: 9, name: "codeg" }), folder({ id: 8, name: "infra" })],
        {
          9: CODEG,
          8: [{ name: "origin", url: "git@github.com:me/infra.git" }],
        }
      ),
    ])

    const view = sidebarProjectView(catalog, "local")

    expect(view.otherMachinesByFolderId.get(1)).toEqual(["remote:4"])
    expect(view.otherMachinesByFolderId.get(2)).toEqual(["remote:4"])
    expect(view.otherMachinesByFolderId.has(3)).toBe(false)
    expect(view.elsewhereProjects.map((p) => p.displayName)).toEqual(["infra"])
  })
})

describe("mergeCatalogRound", () => {
  const nas = snapshot("remote:4", [folder({ id: 1, name: "codeg" })])
  const fresh = snapshot("remote:4", [folder({ id: 2, name: "infra" })])
  const previous = new Map([
    ["remote:4" as const, { baseUrl: "http://nas:3080", snapshot: nas }],
  ])
  const failed: PromiseSettledResult<BackendCatalogSnapshot> = {
    status: "rejected",
    reason: new Error("offline"),
  }

  it("replaces a machine that answered", () => {
    const next = mergeCatalogRound(
      previous,
      [{ backendKey: "remote:4", baseUrl: "http://nas:3080" }],
      [{ status: "fulfilled", value: fresh }]
    )
    expect(next.get("remote:4")?.snapshot).toBe(fresh)
  })

  it("keeps an offline machine's last snapshot at the same address", () => {
    const next = mergeCatalogRound(
      previous,
      [{ backendKey: "remote:4", baseUrl: "http://nas:3080" }],
      [failed]
    )
    expect(next.get("remote:4")?.snapshot).toBe(nas)
  })

  it("drops it once the connection points at another server", () => {
    const next = mergeCatalogRound(
      previous,
      [{ backendKey: "remote:4", baseUrl: "http://other:3080" }],
      [failed]
    )
    expect(next.has("remote:4")).toBe(false)
  })

  it("drops machines whose connection was deleted", () => {
    const next = mergeCatalogRound(
      previous,
      [{ backendKey: "local", baseUrl: null }],
      [{ status: "fulfilled", value: snapshot("local", []) }]
    )
    expect([...next.keys()]).toEqual(["local"])
  })
})

describe("loadBackendCatalogSnapshot", () => {
  it("reads remotes for each root and tolerates per-folder failures", async () => {
    const call = vi.fn(async (command: string, args?: { path?: string }) => {
      if (command === "list_open_folder_details") {
        return [
          folder({ id: 1, path: "/a" }),
          folder({ id: 2, path: "/gone" }),
          folder({ id: 3, path: "/a-wt", parent_id: 1 }),
        ]
      }
      if (args?.path === "/gone") throw new Error("not a git repo")
      return CODEG
    })
    const client = { key: "remote:4", call } as unknown as BackendClient

    const snap = await loadBackendCatalogSnapshot(client)

    expect(snap.backendKey).toBe("remote:4")
    expect(snap.remotesByFolderId.get(1)).toEqual(CODEG)
    expect(snap.remotesByFolderId.get(2)).toEqual([])
    // Worktree remotes aren't fetched: they follow their root.
    expect(snap.remotesByFolderId.has(3)).toBe(false)
  })

  it("rejects when the folder listing fails", async () => {
    const client = {
      key: "remote:4",
      call: vi.fn().mockRejectedValue(new Error("offline")),
    } as unknown as BackendClient
    await expect(loadBackendCatalogSnapshot(client)).rejects.toThrow("offline")
  })
})
