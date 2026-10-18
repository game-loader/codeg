import { afterEach, describe, expect, it, vi } from "vitest"

const shellCall = vi.fn()
let desktop = true

vi.mock("@/lib/transport", () => ({
  getShellTransport: () => ({ call: shellCall }),
  isDesktop: () => desktop,
}))

const getConnection = vi.fn()
vi.mock("@/lib/remote-workspace", () => ({
  getRemoteWorkspaceConnection: (id: number) => getConnection(id),
}))

import {
  __resetBackendClientsForTests,
  BackendBindingChangedError,
  getBackendClient,
  normalizeBaseUrl,
  parseBackendKey,
  pinBackendClient,
} from "./backend-client"

afterEach(() => {
  shellCall.mockReset()
  getConnection.mockReset()
  desktop = true
  __resetBackendClientsForTests()
})

describe("parseBackendKey", () => {
  it.each([
    ["local", { kind: "local" }],
    ["remote:12", { kind: "remote", connectionId: 12 }],
    ["remote:0", null],
    ["remote:-1", null],
    ["remote:abc", null],
    ["ssh:host", null],
  ])("parses %s", (value, expected) => {
    expect(parseBackendKey(value)).toEqual(expected)
  })
})

describe("getBackendClient", () => {
  it("sends local calls straight to the shell transport", async () => {
    shellCall.mockResolvedValue("ok")
    await getBackendClient("local").call("list_folders", { a: 1 })
    expect(shellCall).toHaveBeenCalledWith("list_folders", { a: 1 }, undefined)
  })

  it("routes remote calls through the desktop proxy by connection id", async () => {
    shellCall.mockResolvedValue([])
    await getBackendClient("remote:7").call(
      "git_list_remotes",
      { path: "/x" },
      { timeoutMs: 5000 }
    )
    expect(shellCall).toHaveBeenCalledWith("remote_http_call", {
      connectionId: 7,
      command: "git_list_remotes",
      args: { path: "/x" },
      timeoutMs: 5000,
    })
  })

  it("refuses remote backends outside the desktop app", () => {
    desktop = false
    expect(() => getBackendClient("remote:7")).toThrow(/desktop/)
  })
})

describe("normalizeBaseUrl", () => {
  it("matches the proxy's trimming", () => {
    expect(normalizeBaseUrl("  http://nas:3080/// ")).toBe("http://nas:3080")
  })
})

describe("pinBackendClient", () => {
  it("is the plain client for this machine", () => {
    expect(pinBackendClient("local", "ignored")).toBe(getBackendClient("local"))
  })

  it("sends while the connection still points at the pinned address", async () => {
    getConnection.mockResolvedValue({ base_url: "http://nas:3080/" })
    shellCall.mockResolvedValue("ok")

    const client = pinBackendClient("remote:4", "http://nas:3080")
    await expect(client.call("open_folder", { path: "/srv" })).resolves.toBe(
      "ok"
    )
    expect(getConnection).toHaveBeenCalledWith(4)
    expect(shellCall).toHaveBeenCalledWith("remote_http_call", {
      connectionId: 4,
      command: "open_folder",
      args: { path: "/srv" },
      timeoutMs: undefined,
    })
  })

  it("refuses once the connection points at another server", async () => {
    getConnection.mockResolvedValue({ base_url: "http://other:3080" })
    const client = pinBackendClient("remote:4", "http://nas:3080")

    await expect(client.call("open_folder")).rejects.toBeInstanceOf(
      BackendBindingChangedError
    )
    expect(shellCall).not.toHaveBeenCalled()
  })

  it("refuses once the connection is deleted", async () => {
    getConnection.mockRejectedValue({
      code: "not_found",
      message: "Remote connection 4 not found",
    })
    const client = pinBackendClient("remote:4", "http://nas:3080")

    await expect(client.call("open_folder")).rejects.toBeInstanceOf(
      BackendBindingChangedError
    )
    expect(shellCall).not.toHaveBeenCalled()
  })

  it("passes other lookup failures through unchanged", async () => {
    const failure = new Error("database is locked")
    getConnection.mockRejectedValue(failure)
    const client = pinBackendClient("remote:4", "http://nas:3080")

    await expect(client.call("open_folder")).rejects.toBe(failure)
    expect(shellCall).not.toHaveBeenCalled()
  })
})
