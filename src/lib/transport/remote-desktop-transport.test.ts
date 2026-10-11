import { beforeEach, describe, expect, it, vi } from "vitest"
import { RemoteDesktopTransport } from "./remote-desktop-transport"

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  callbacks: new Map<string, (event: { payload: unknown }) => void>(),
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }))

beforeEach(() => {
  mocks.callbacks.clear()
  mocks.invoke.mockReset()
  mocks.listen.mockReset()
  mocks.listen.mockImplementation(async (channel, callback) => {
    mocks.callbacks.set(channel, callback)
    return () => mocks.callbacks.delete(channel)
  })
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "remote_ws_subscribe") {
      mocks.callbacks.get(`remote-ws-event-${args.connectionId}`)?.({
        payload: {
          configRevision: args.configRevision,
          channel: "__ready__",
          payload: null,
        },
      })
    }
    return { id: 1 }
  })
})

function transport(id: number, configRevision = `revision-${id}`) {
  const onUnauthorized = vi.fn()
  const onDisconnected = vi.fn()
  const onConfigurationChanged = vi.fn()
  const client = new RemoteDesktopTransport({
    id,
    name: `Machine ${id}`,
    baseUrl: `http://machine-${id}`,
    token: "private",
    windowInstanceId: "window-instance",
    configRevision,
    onUnauthorized,
    onDisconnected,
    onConfigurationChanged,
  })
  return { client, onUnauthorized, onDisconnected, onConfigurationChanged }
}

describe("remote transport in a multi-machine window", () => {
  it("routes HTTP and subscriptions to their fixed machine and config revision", async () => {
    const a = transport(1)
    const b = transport(2)
    await a.client.call("get_folder", { id: 1 })
    await b.client.call("get_folder", { id: 1 })
    expect(mocks.invoke).toHaveBeenCalledWith(
      "remote_http_call",
      expect.objectContaining({ connectionId: 1, configRevision: "revision-1" })
    )
    expect(mocks.invoke).toHaveBeenCalledWith(
      "remote_http_call",
      expect.objectContaining({ connectionId: 2, configRevision: "revision-2" })
    )
    const onA = vi.fn()
    const onB = vi.fn()
    await a.client.subscribe("folder://changed", onA)
    await b.client.subscribe("folder://changed", onB)
    mocks.callbacks.get("remote-ws-event-1")!({
      payload: {
        configRevision: "revision-1",
        channel: "folder://changed",
        payload: { id: 1 },
      },
    })
    expect(onA).toHaveBeenCalledWith({ id: 1 })
    expect(onB).not.toHaveBeenCalled()
    expect(mocks.invoke).toHaveBeenCalledWith(
      "remote_ws_subscribe",
      expect.objectContaining({ connectionId: 1, configRevision: "revision-1" })
    )
    a.client.destroy()
    b.client.destroy()
  })

  it("keeps offline, rejected authentication and changed configuration distinct", async () => {
    const a = transport(1)
    const b = transport(2)
    await a.client.subscribe("folder://changed", vi.fn())
    await b.client.subscribe("folder://changed", vi.fn())
    const emit = mocks.callbacks.get("remote-ws-event-1")!
    emit({
      payload: {
        configRevision: "revision-1",
        channel: "__disconnected__",
        payload: null,
      },
    })
    expect(a.onDisconnected).toHaveBeenCalledOnce()
    expect(a.onUnauthorized).not.toHaveBeenCalled()
    emit({
      payload: {
        configRevision: "revision-1",
        channel: "__unauthorized__",
        payload: null,
      },
    })
    expect(a.onUnauthorized).toHaveBeenCalledOnce()
    emit({
      payload: {
        configRevision: "revision-1",
        channel: "__configuration_changed__",
        payload: null,
      },
    })
    expect(a.onConfigurationChanged).toHaveBeenCalledOnce()
    expect(b.onUnauthorized).not.toHaveBeenCalled()
    expect(b.onDisconnected).not.toHaveBeenCalled()
    a.client.destroy()
    b.client.destroy()
  })

  it("retires HTTP calls and events instead of following a changed destination", async () => {
    const a = transport(1)
    const receive = vi.fn()
    await a.client.subscribe("folder://changed", receive)
    const emit = mocks.callbacks.get("remote-ws-event-1")!
    const callsBefore = mocks.invoke.mock.calls.filter(
      ([command]) => command === "remote_http_call"
    ).length
    emit({
      payload: {
        configRevision: "revision-1",
        channel: "__configuration_changed__",
        payload: null,
      },
    })
    emit({
      payload: {
        configRevision: "revision-1",
        channel: "folder://changed",
        payload: { id: 1 },
      },
    })
    await expect(
      a.client.call("git_commit", { path: "/repo" })
    ).rejects.toThrow(/close and reopen/)
    expect(receive).not.toHaveBeenCalled()
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "remote_http_call"
      )
    ).toHaveLength(callsBefore)
    expect(a.onConfigurationChanged).toHaveBeenCalledOnce()
  })

  it("rejects a late HTTP completion after configuration retirement", async () => {
    const a = transport(1)
    await a.client.subscribe("folder://changed", vi.fn())
    let finish!: (value: unknown) => void
    mocks.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = a.client.call("get_folder", { id: 1 })
    mocks.callbacks.get("remote-ws-event-1")!({
      payload: {
        configRevision: "revision-1",
        channel: "__configuration_changed__",
        payload: null,
      },
    })
    finish({ id: 1 })
    await expect(pending).rejects.toThrow(/close and reopen/)
  })
  it("rejects queued old-revision payload, attach, and lifecycle frames on a replacement transport", async () => {
    const replacement = transport(1, "new-revision")
    const receive = vi.fn()
    await replacement.client.subscribe("folder://changed", receive)
    const emit = mocks.callbacks.get("remote-ws-event-1")!
    const stream = replacement.client.eventStream() as unknown as {
      handleServerFrame(frame: unknown): void
    }
    const attach = vi
      .spyOn(stream, "handleServerFrame")
      .mockImplementation(() => {})
    for (const channel of [
      "folder://changed",
      "__ready__",
      "__disconnected__",
      "__unauthorized__",
      "__configuration_changed__",
    ]) {
      emit({
        payload: {
          configRevision: "old-revision",
          channel,
          payload: { id: 1 },
        },
      })
    }
    emit({ payload: { channel: "folder://changed", payload: { id: 1 } } })
    emit({ payload: { configRevision: "old-revision", type: "event" } })
    expect(receive).not.toHaveBeenCalled()
    expect(attach).not.toHaveBeenCalled()
    expect(replacement.onDisconnected).not.toHaveBeenCalled()
    expect(replacement.onUnauthorized).not.toHaveBeenCalled()
    expect(replacement.onConfigurationChanged).not.toHaveBeenCalled()
    emit({
      payload: {
        configRevision: "new-revision",
        channel: "folder://changed",
        payload: { id: 1 },
      },
    })
    emit({ payload: { configRevision: "new-revision", type: "event" } })
    expect(receive).toHaveBeenCalledWith({ id: 1 })
    expect(attach).toHaveBeenCalledOnce()
    await expect(
      replacement.client.call("get_folder", { id: 1 })
    ).resolves.toEqual({ id: 1 })
    replacement.client.destroy()
  })
  it("revives only A's rejected stream after authentication recovers, retaining subscribers and B", async () => {
    const a = transport(1)
    const b = transport(2)
    const receiveA = vi.fn()
    await a.client.subscribe("folder://changed", receiveA)
    await b.client.subscribe("folder://changed", vi.fn())
    const bListener = mocks.callbacks.get("remote-ws-event-2")
    const onReconnectA = vi.fn()
    a.client.onReconnect(onReconnectA)
    mocks.callbacks.get("remote-ws-event-1")!({
      payload: {
        configRevision: "revision-1",
        channel: "__unauthorized__",
        payload: null,
      },
    })
    expect(a.onUnauthorized).toHaveBeenCalledOnce()
    await Promise.all([
      a.client.call("get_folder", { id: 1 }),
      a.client.call("get_folder", { id: 1 }),
    ])
    await vi.waitFor(() => expect(onReconnectA).toHaveBeenCalledOnce())
    expect(
      mocks.invoke.mock.calls.filter(
        ([command, args]) =>
          command === "remote_ws_subscribe" && args.connectionId === 1
      )
    ).toHaveLength(2)
    expect(
      mocks.invoke.mock.calls.filter(
        ([command, args]) =>
          command === "remote_ws_subscribe" && args.connectionId === 2
      )
    ).toHaveLength(1)
    expect(mocks.callbacks.get("remote-ws-event-2")).toBe(bListener)
    mocks.callbacks.get("remote-ws-event-1")!({
      payload: {
        configRevision: "revision-1",
        channel: "folder://changed",
        payload: { id: 1 },
      },
    })
    expect(receiveA).toHaveBeenCalledWith({ id: 1 })
    expect(b.onUnauthorized).not.toHaveBeenCalled()
    a.client.destroy()
    b.client.destroy()
  })
})
