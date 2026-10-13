import { describe, expect, it, vi } from "vitest"
import {
  ProjectIdentityStore,
  projectCatalog,
  catalogFolders,
} from "./project-catalog"
import type { FolderDetail, RepositoryProjectIdentityEntry } from "@/lib/types"
import type { BackendDescriptor } from "./registry"

const folder = (
  id = 1,
  path = "/repo",
  parent_id: number | null = null
): FolderDetail => ({
  id,
  path,
  parent_id,
  name: "repo",
  kind: "regular",
  alias: null,
  group_id: null,
  git_branch: "main",
  default_agent_type: "codex",
  color: "",
  sort_order: 0,
  last_opened_at: "",
})
const identity = (
  id = 1,
  path = "/repo",
  key = "github:owner/repo"
): RepositoryProjectIdentityEntry => ({
  folder_id: id,
  path,
  status: "resolved",
  identity: {
    project_key: key,
    provider: "github",
    host: "github.com",
    repository_path: key.slice(7),
    remote_name: "origin",
  },
})
const host = (
  key: "remote:1" | "remote:2",
  generation = 1
): BackendDescriptor => ({
  key,
  generation,
  name: key,
  status: "connected",
  baseUrl: null,
  error: null,
})
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}

describe("logical project projection", () => {
  it("groups source across paths/hosts and retains two checkouts on one host", () => {
    const hosts = [host("remote:1"), host("remote:2")]
    const catalogs = new Map(
      hosts.map((h) => [
        h.key,
        {
          folders: [folder(), folder(2, "/second")],
          identities: new Map([
            [1, identity()],
            [2, identity(2, "/second")],
          ]),
        },
      ])
    )
    const projects = projectCatalog(hosts, catalogs)
    expect(projects).toHaveLength(1)
    expect(projects[0].setups.map((s) => s.backendKey)).toEqual([
      "remote:1",
      "remote:1",
      "remote:2",
      "remote:2",
    ])
    expect(projects[0].setups[0].folder.path).not.toBe(
      projects[0].setups[1].folder.path
    )
  })
  it("keeps different sources and unknown identities independent, with host-local children", () => {
    const hosts = [host("remote:1"), host("remote:2")]
    const catalogs = new Map(
      hosts.map((h, i) => [
        h.key,
        {
          folders: [folder(), folder(2, "/child", 1)],
          identities: new Map([
            [1, identity(1, "/repo", `github:owner/repo${i}`)],
          ]),
        },
      ])
    )
    expect(projectCatalog(hosts, catalogs)).toHaveLength(2)
    for (const project of projectCatalog(hosts, catalogs))
      expect(project.setups[0].children).toEqual([folder(2, "/child", 1)])
    const unknown = new Map(
      hosts.map((h) => [h.key, { folders: [folder()], identities: new Map() }])
    )
    expect(projectCatalog(hosts, unknown)).toHaveLength(2)
  })
  it("includes root ancestors but excludes closed unrelated folders and chats", () => {
    expect(
      catalogFolders(
        [folder(2, "/child", 1)],
        [folder(), folder(2, "/child", 1), folder(3)]
      )
    ).toEqual([folder(), folder(2, "/child", 1)])
  })
})

describe("runtime identity store", () => {
  it("coalesces loads and keeps latest refresh successes, failures and loading", async () => {
    const first = deferred<RepositoryProjectIdentityEntry[]>(),
      second = deferred<RepositoryProjectIdentityEntry[]>()
    const fetch = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const store = new ProjectIdentityStore(fetch, () => true)
    const a = store.setFolders([folder()])
    const duplicate = store.setFolders([folder()])
    expect(fetch).toHaveBeenCalledTimes(1)
    const b = store.refresh()
    second.resolve([identity()])
    await b
    first.reject(new Error("old failure"))
    await a
    await duplicate
    expect(store.getSnapshot().entries.get(1)?.identity?.project_key).toBe(
      "github:owner/repo"
    )
    expect(store.getSnapshot()).toMatchObject({
      loading: false,
      unavailable: false,
    })
  })
  it("preserves partial/transient metadata but clears resolved null and prunes changed/removed paths", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue([identity(), identity(2, "/second")])
    const store = new ProjectIdentityStore(fetch, () => true)
    await store.setFolders([folder(), folder(2, "/second")])
    fetch.mockResolvedValue([
      { folder_id: 1, path: "/repo", status: "unavailable", identity: null },
    ])
    await store.refresh()
    expect(store.getSnapshot().entries.size).toBe(2)
    expect(store.getSnapshot().unavailable).toBe(true)
    fetch.mockResolvedValue([
      { folder_id: 1, path: "/repo", status: "resolved", identity: null },
    ])
    await store.refresh()
    expect(store.getSnapshot().entries.get(1)?.identity).toBeNull()
    fetch.mockResolvedValue([])
    await store.setFolders([folder(1, "/changed")])
    expect(store.getSnapshot().entries.size).toBe(0)
  })
  it("rejects old successes and retirement including loading state", async () => {
    const old = deferred<RepositoryProjectIdentityEntry[]>()
    const fetch = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue([identity(1, "/new")])
    const store = new ProjectIdentityStore(fetch, () => true)
    const pending = store.setFolders([folder()])
    await store.setFolders([folder(1, "/new")])
    old.resolve([identity()])
    await pending
    expect(store.getSnapshot().entries.get(1)?.path).toBe("/new")
    const retired = deferred<RepositoryProjectIdentityEntry[]>()
    fetch.mockReturnValueOnce(retired.promise)
    const p = store.refresh()
    store.dispose()
    retired.resolve([identity()])
    await p
    expect(store.getSnapshot().entries.size).toBe(0)
    expect(store.getSnapshot().loading).toBe(false)
  })
  it("batches 128 and retries old-server capability only on explicit refresh", async () => {
    const fetch = vi.fn().mockRejectedValue({ message: "HTTP 404" })
    const store = new ProjectIdentityStore(fetch, () => true)
    await store.setFolders([folder()])
    expect(store.getSnapshot().capability).toBe("unsupported")
    await store.setFolders([folder(), folder(2)])
    expect(fetch).toHaveBeenCalledTimes(1)
    fetch.mockImplementation(async (ids: number[]) =>
      ids.map((id) => identity(id, `/repo/${id}`))
    )
    await store.setFolders(
      Array.from({ length: 260 }, (_, i) => folder(i + 1, `/repo/${i + 1}`))
    )
    await store.refresh()
    expect(fetch.mock.calls.slice(1).map((c) => c[0].length)).toEqual([
      128, 128, 4,
    ])
    expect(store.getSnapshot().capability).toBe("supported")
  })
})

it("does not accept raw URLs, extra credentials or wrong returned paths and uses exact source case", async () => {
  const fetch = vi.fn().mockResolvedValue([
    {
      ...identity(),
      token: "secret",
      identity: {
        ...identity().identity!,
        url: "https://secret@example.invalid/repo.git",
      },
    },
  ])
  const store = new ProjectIdentityStore(fetch, () => true)
  await store.setFolders([folder()])
  expect(JSON.stringify([...store.getSnapshot().entries.values()])).not.toMatch(
    /secret|url/
  )
  fetch.mockResolvedValue([identity(1, "/wrong", "github:new/source")])
  await store.refresh()
  expect(store.getSnapshot().entries.get(1)?.identity?.project_key).toBe(
    "github:owner/repo"
  )
  expect(store.getSnapshot().unavailable).toBe(true)
  fetch.mockResolvedValue([identity(1, "/repo", "https://secret@host/repo")])
  await store.refresh()
  expect(store.getSnapshot().entries.get(1)?.identity?.project_key).toBe(
    "github:owner/repo"
  )
  const hosts = [host("remote:1"), host("remote:2")]
  const catalogs = new Map(
    hosts.map((h, i) => [
      h.key,
      {
        folders: [folder(1, `/host${i}`)],
        identities: new Map([[1, identity(1, `/host${i}`)]]),
      },
    ])
  )
  expect(
    projectCatalog(hosts, catalogs)[0].setups.map((s) => s.folder.path)
  ).toEqual(["/host0", "/host1"])
  catalogs
    .get("remote:2")!
    .identities.set(1, identity(1, "/host1", "git:host/Owner/repo"))
  catalogs
    .get("remote:1")!
    .identities.set(1, identity(1, "/host0", "git:host/owner/repo"))
  expect(projectCatalog(hosts, catalogs)).toHaveLength(2)
})

it("does not let an earlier success clear a later refresh's loading or replace its null result", async () => {
  const old = deferred<RepositoryProjectIdentityEntry[]>(),
    latest = deferred<RepositoryProjectIdentityEntry[]>()
  const fetch = vi
    .fn()
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(latest.promise)
  const store = new ProjectIdentityStore(fetch, () => true)
  const a = store.setFolders([folder()]),
    b = store.refresh()
  old.resolve([identity()])
  await a
  expect(store.getSnapshot().loading).toBe(true)
  expect(store.getSnapshot().entries.size).toBe(0)
  latest.resolve([
    { folder_id: 1, path: "/repo", status: "resolved", identity: null },
  ])
  await b
  expect(store.getSnapshot().entries.get(1)?.identity).toBeNull()
  expect(store.getSnapshot().loading).toBe(false)
})

it.each([404, 405, 501])(
  "isolates missing capability %s with no automatic polling reprobe",
  async (status) => {
    const fetch = vi.fn().mockRejectedValue({ status })
    const store = new ProjectIdentityStore(fetch, () => true)
    await store.setFolders([folder()])
    await store.setFolders([folder()])
    await store.setFolders([folder(), folder(2)])
    expect(store.getSnapshot().capability).toBe("unsupported")
    expect(fetch).toHaveBeenCalledTimes(1)
  }
)
