import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { useEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RemoteTransportConfig, Transport } from "@/lib/transport"
import type { RemoteWorkspaceConnection } from "@/lib/types"

const mocks = vi.hoisted(() => ({
  params: new URLSearchParams(),
  getConnection: vi.fn(),
  configure: vi.fn(),
  invoke: vi.fn(),
  listen: vi.fn(),
  callbacks: new Map<string, (event: { payload: unknown }) => void>(),
  remote: null as RemoteTransportConfig | null,
  transport: null as Transport | null,
  invalidated: false,
  mounted: vi.fn(),
  forwarded: vi.fn(),
  currentRevision: "revision-a",
}))

vi.mock("next/navigation", () => ({ useSearchParams: () => mocks.params }))
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: { message?: string }) =>
    params?.message ?? key,
}))
vi.mock("@/lib/remote-workspace", () => ({
  getRemoteWorkspaceConnection: mocks.getConnection,
}))
vi.mock("@/stores/backend-scoped-store-reset", () => ({
  resetBackendScopedStores: vi.fn(),
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }))
vi.mock("@/lib/transport", async () => {
  const { RemoteDesktopTransport } =
    await import("@/lib/transport/remote-desktop-transport")
  const { REMOTE_CONFIGURATION_CHANGED_MESSAGE } =
    await import("@/lib/transport/remote-errors")
  return {
    configureRemoteDesktopTransport: (config: RemoteTransportConfig) => {
      mocks.configure(config)
      mocks.transport?.destroy?.()
      mocks.remote = { ...config }
      mocks.transport = new RemoteDesktopTransport(config)
      mocks.invalidated = false
    },
    clearRemoteDesktopTransport: () => {
      mocks.transport?.destroy?.()
      mocks.remote = null
      mocks.transport = null
      mocks.invalidated = false
    },
    invalidateRemoteDesktopTransport: () => {
      mocks.transport?.destroy?.()
      mocks.invalidated = true
    },
    getActiveRemoteConnectionId: () => mocks.remote?.id ?? null,
    getActiveRemoteTransportConfig: () => mocks.remote,
    getServerBaseUrl: () => mocks.remote?.baseUrl ?? window.location.origin,
    getShellTransport: () => ({ call: mocks.invoke }),
    getTransport: () => {
      if (mocks.invalidated) {
        throw new Error(REMOTE_CONFIGURATION_CHANGED_MESSAGE)
      }
      return mocks.transport ?? { call: mocks.invoke }
    },
    isDesktop: () => true,
  }
})

import { RemoteConnectionGate } from "./remote-connection-context"
import {
  getFolder,
  gitCommit,
  gitMerge,
  gitPush,
  gitStashPush,
  gitStashPop,
} from "@/lib/api"

const connection: RemoteWorkspaceConnection = {
  id: 1,
  name: "A",
  base_url: "http://a.test",
  token: "token-a",
  headers: [],
  sort_order: 0,
  created_at: "",
  updated_at: "",
  config_revision: "revision-a",
}

function Form() {
  useEffect(() => {
    mocks.mounted()
  }, [])
  return <div>Dirty commit form for A</div>
}

function popup() {
  return (
    <RemoteConnectionGate>
      <Form />
    </RemoteConnectionGate>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.params = new URLSearchParams({
    remoteConnectionId: "1",
    remoteWindowId: "popup-a",
    remoteConfigRevision: "revision-a",
  })
  mocks.remote = null
  mocks.transport = null
  mocks.invalidated = false
  mocks.currentRevision = "revision-a"
  mocks.callbacks.clear()
  mocks.getConnection.mockResolvedValue(connection)
  mocks.listen.mockImplementation(async (channel, callback) => {
    mocks.callbacks.set(channel, callback)
    return () => mocks.callbacks.delete(channel)
  })
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "remote_ws_subscribe") {
      if (args.configRevision !== mocks.currentRevision) {
        throw {
          code: "configuration_invalid",
          message: "Remote connection configuration changed; reopen",
        }
      }
      mocks.callbacks.get("remote-ws-event-1")?.({
        payload: {
          configRevision: args.configRevision,
          channel: "__ready__",
          payload: null,
        },
      })
    }
    if (command === "remote_http_call") {
      if (args.configRevision !== mocks.currentRevision) {
        throw {
          code: "configuration_invalid",
          message: "Remote connection configuration changed; reopen",
        }
      }
      mocks.forwarded(args)
      return { id: 1 }
    }
  })
})

afterEach(() => {
  cleanup()
  mocks.transport?.destroy?.()
})

describe("operation popup destination fencing", () => {
  it("checks the initiating revision before configuring and mounting", async () => {
    render(popup())
    expect(mocks.mounted).not.toHaveBeenCalled()
    await screen.findByText("Dirty commit form for A")
    expect(mocks.configure).toHaveBeenCalledWith(
      expect.objectContaining({
        configRevision: "revision-a",
        windowInstanceId: "popup-a",
      })
    )
    await getFolder(1)
    expect(mocks.forwarded).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 1, configRevision: "revision-a" })
    )
  })

  it("rejects a replacement that wins the race before the first lookup", async () => {
    let resolve!: (value: RemoteWorkspaceConnection) => void
    mocks.getConnection.mockReturnValue(
      new Promise<RemoteWorkspaceConnection>((done) => {
        resolve = done
      })
    )
    render(popup())
    await act(async () => {
      resolve({
        ...connection,
        name: "B",
        base_url: "http://b.test",
        config_revision: "revision-b",
      })
    })
    expect(screen.getByText(/close and reopen/)).toBeInTheDocument()
    expect(mocks.configure).not.toHaveBeenCalled()
    expect(mocks.mounted).not.toHaveBeenCalled()
    expect(() => getFolder(1)).toThrow(/close and reopen/)
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it("retires a dirty popup on a configuration event without a local fallback", async () => {
    const view = render(popup())
    await screen.findByText("Dirty commit form for A")
    await waitFor(() =>
      expect(mocks.callbacks.has("remote-ws-event-1")).toBe(true)
    )
    const captured = mocks.transport!
    act(() => {
      mocks.currentRevision = "revision-b"
      mocks.callbacks.get("remote-ws-event-1")!({
        payload: {
          configRevision: "revision-a",
          channel: "__configuration_changed__",
          payload: null,
        },
      })
    })
    expect(
      screen.queryByText("Dirty commit form for A")
    ).not.toBeInTheDocument()
    expect(screen.getByText(/close and reopen/)).toBeInTheDocument()
    expect(() => gitStashPop("/repo")).toThrow(/close and reopen/)
    await expect(
      captured.call("git_commit", { path: "/repo" })
    ).rejects.toThrow(/close and reopen/)
    view.rerender(popup())
    expect(mocks.configure).toHaveBeenCalledOnce()
    expect(mocks.remote?.configRevision).toBe("revision-a")
    expect(mocks.forwarded).not.toHaveBeenCalled()
  })

  it("cannot retarget a mounted popup by changing its URL revision", async () => {
    const view = render(popup())
    await screen.findByText("Dirty commit form for A")
    mocks.params.set("remoteConfigRevision", "revision-b")
    view.rerender(popup())
    expect(screen.getByText(/close and reopen/)).toBeInTheDocument()
    expect(mocks.configure).toHaveBeenCalledOnce()
    expect(mocks.getConnection).toHaveBeenCalledOnce()
    expect(mocks.remote?.configRevision).toBe("revision-a")
    expect(() => getFolder(1)).toThrow(/close and reopen/)
    expect(mocks.forwarded).not.toHaveBeenCalled()
    mocks.params.set("remoteConfigRevision", "revision-a")
    view.rerender(popup())
    expect(screen.getByText(/close and reopen/)).toBeInTheDocument()
    expect(mocks.configure).toHaveBeenCalledOnce()
  })

  it.each([
    ["commit", () => gitCommit("/repo", "A draft", ["a.txt"], 1)],
    ["merge", () => gitMerge("/repo", "feature")],
    ["stash", () => gitStashPush("/repo", "A draft")],
    ["unstash", () => gitStashPop("/repo")],
    ["push", () => gitPush("/repo")],
  ] as const)(
    "does not forward an old %s operation to B",
    async (_name, mutate) => {
      render(popup())
      await screen.findByText("Dirty commit form for A")
      await waitFor(() =>
        expect(mocks.invoke).toHaveBeenCalledWith(
          "remote_ws_subscribe",
          expect.objectContaining({ configRevision: "revision-a" })
        )
      )
      mocks.currentRevision = "revision-b"
      await act(async () => {
        await expect(mutate()).rejects.toMatchObject({
          code: "configuration_invalid",
        })
      })
      expect(mocks.forwarded).not.toHaveBeenCalled()
      expect(mocks.remote?.configRevision).toBe("revision-a")
      expect(screen.getByText(/close and reopen/)).toBeInTheDocument()
    }
  )

  it("binds old URLs once and rejects an unstash after replacement without forwarding to B", async () => {
    mocks.params.delete("remoteConfigRevision")
    render(popup())
    await screen.findByText("Dirty commit form for A")
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "remote_ws_subscribe",
        expect.objectContaining({ configRevision: "revision-a" })
      )
    )
    mocks.currentRevision = "revision-b"
    await act(async () => {
      await expect(gitStashPop("/repo")).rejects.toMatchObject({
        code: "configuration_invalid",
      })
    })
    expect(mocks.invoke).toHaveBeenCalledWith(
      "remote_http_call",
      expect.objectContaining({
        command: "git_stash_pop",
        configRevision: "revision-a",
      })
    )
    expect(screen.getByText(/close and reopen/)).toBeInTheDocument()
    expect(mocks.forwarded).not.toHaveBeenCalled()
    expect(mocks.configure).toHaveBeenCalledOnce()
  })

  it("handles replacement between lookup and subscription without reopening on B", async () => {
    mocks.currentRevision = "revision-b"
    render(popup())
    await screen.findByText(/configuration changed/)
    expect(mocks.configure).toHaveBeenCalledOnce()
    expect(mocks.remote?.configRevision).toBe("revision-a")
    expect(mocks.forwarded).not.toHaveBeenCalled()
    expect(() => getFolder(1)).toThrow(/close and reopen/)
  })

  it.each(["", "bogus", "0"])("rejects invalid remote ID %j", async (id) => {
    mocks.params.set("remoteConnectionId", id)
    render(popup())
    await screen.findByText("Invalid remote connection ID")
    expect(mocks.mounted).not.toHaveBeenCalled()
    expect(mocks.configure).not.toHaveBeenCalled()
    expect(mocks.getConnection).not.toHaveBeenCalled()
  })
})
