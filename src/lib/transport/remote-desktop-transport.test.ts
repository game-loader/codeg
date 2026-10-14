import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AttachHandlers, RemoteTransportConfig } from "./types"
import { RemoteDesktopTransport } from "./remote-desktop-transport"

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  callbacks: new Map<string, (event: { payload: unknown }) => void>(),
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }))

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
  transports.push(client)
  return { client, onUnauthorized, onDisconnected, onConfigurationChanged }
}

describe("remote transport in a multi-machine window", () => {
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
  it("keeps a refused authentication recovery unauthorized without marking either runtime offline", async () => {
    const a = transport(1)
    const b = transport(2)
    await a.client.subscribe("folder://changed", vi.fn())
    await b.client.subscribe("folder://changed", vi.fn())
    mocks.callbacks.get("remote-ws-event-1")!({
      payload: {
        configRevision: "revision-1",
        channel: "__unauthorized__",
        payload: null,
      },
    })
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "remote_ws_subscribe") {
        throw { code: "authentication_failed", message: "Token refused" }
      }
      return { id: 1 }
    })
    await a.client.call("get_folder", { id: 1 })
    await vi.waitFor(() => expect(a.onUnauthorized).toHaveBeenCalledTimes(2))
    expect(a.client.getConnectionSnapshot()).toBe("disconnected")
    expect(a.onDisconnected).not.toHaveBeenCalled()
    expect(b.onUnauthorized).not.toHaveBeenCalled()
    expect(b.onDisconnected).not.toHaveBeenCalled()
    expect(b.client.getConnectionSnapshot()).toBe("connected")
  })
})

const config: RemoteTransportConfig = {
  id: 7,
  name: "Remote",
  baseUrl: "http://remote.example:3080",
  token: "test-token",
  windowInstanceId: "rw-test",
}
const transports: RemoteDesktopTransport[] = []

function recoveryTransport(overrides: Partial<RemoteTransportConfig> = {}) {
  const t = new RemoteDesktopTransport({ ...config, ...overrides })
  transports.push(t)
  return t
}

function emit(payload: unknown, id = config.id) {
  const event = `remote-ws-event-${id}`
  mocks.callbacks.get(event)?.({ payload })
}

function ready(id = config.id) {
  emit({ channel: "__ready__", payload: null }, id)
}

function drop(id = config.id) {
  emit({ channel: "__disconnected__", payload: null }, id)
}

function sentFrames() {
  return mocks.invoke.mock.calls
    .filter(([command]) => command === "remote_ws_send_text")
    .map(([, args]) => JSON.parse(args.text))
}

function latestSentFrame() {
  const frames = sentFrames()
  return frames[frames.length - 1]
}

function handlers(): AttachHandlers {
  return {
    onSnapshot: vi.fn(),
    onReplay: vi.fn(),
    onEvent: vi.fn(),
    onDetached: vi.fn(),
  }
}

// Drain the two async IPC registration steps without advancing the readiness
// timeout: resolving only after 5s would hide a stranded readiness promise.
async function flush() {
  await vi.advanceTimersByTimeAsync(0)
}

afterEach(() => {
  for (const t of transports.splice(0)) t.destroy()
  vi.useRealTimers()
})

describe("remote desktop event recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.invoke.mockReset().mockResolvedValue(undefined)
    mocks.listen.mockReset().mockImplementation(async (event, callback) => {
      mocks.callbacks.set(event, callback)
      return () => mocks.callbacks.delete(event)
    })
    mocks.callbacks.clear()
  })

  it("reattaches with its cursor, delivers missed events, then continues the session", async () => {
    const t = recoveryTransport()
    const stream = t.eventStream()
    const h = handlers()
    const sub = stream.attach("session-1", {}, h)
    const resync = vi.fn()
    t.onReconnect(resync)
    await flush()
    ready()
    emit({
      type: "snapshot",
      subscription_id: sub.subscriptionId,
      connection_id: "session-1",
      snapshot: { live_message: { content: "before the drop" } },
      event_seq: 10,
    })
    expect(h.onSnapshot).toHaveBeenCalledTimes(1)
    expect(resync).not.toHaveBeenCalled()

    drop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sentFrames()).toHaveLength(1)
    ready()
    expect(latestSentFrame()).toEqual({
      action: "attach",
      subscription_id: sub.subscriptionId,
      connection_id: "session-1",
      since_seq: 10,
    })
    const missed = { seq: 11, event: { content: "during the drop" } }
    emit({
      type: "replay",
      subscription_id: sub.subscriptionId,
      connection_id: "session-1",
      events: [missed],
      high_water_seq: 11,
    })
    const next = { seq: 12, event: { content: "after recovery" } }
    emit({ type: "event", subscription_id: sub.subscriptionId, envelope: next })
    expect(h.onReplay).toHaveBeenCalledWith([missed], 11)
    expect(h.onEvent).toHaveBeenCalledWith(next)
    expect(resync).toHaveBeenCalledTimes(1)

    // A later reconnect must start after the newly delivered conversation.
    drop()
    ready()
    expect(latestSentFrame().since_seq).toBe(12)
    expect(resync).toHaveBeenCalledTimes(2)
  })

  it("ignores duplicate ready signals within the same connection", async () => {
    const t = recoveryTransport()
    t.eventStream().attach("session-1", {}, handlers())
    const resync = vi.fn()
    t.onReconnect(resync)
    await flush()
    ready()
    ready()
    expect(sentFrames()).toHaveLength(1)
    expect(resync).not.toHaveBeenCalled()
    drop()
    ready()
    ready()
    expect(sentFrames()).toHaveLength(2)
    expect(resync).toHaveBeenCalledTimes(1)
  })

  it("resyncs state when a window was first opened while the server was offline", async () => {
    const t = recoveryTransport()
    const resync = vi.fn()
    t.onReconnect(resync)
    const settled = vi.fn()
    const subscription = t.subscribe("folders://changed", vi.fn()).then(settled)
    await flush()
    drop()
    drop()
    await flush()
    expect(settled).not.toHaveBeenCalled()
    ready()
    await flush()
    expect(settled).toHaveBeenCalledTimes(1)
    expect(resync).toHaveBeenCalledTimes(1)
    await subscription
  })

  it("keeps readiness waiters together across repeated disconnect signals", async () => {
    const t = recoveryTransport()
    t.eventStream()
    await flush()
    ready()
    drop()
    const settled = vi.fn()
    const subscription = t.subscribe("folders://changed", vi.fn()).then(settled)
    await flush()
    // The socket is down, so the subscriber waits for the next ready.
    expect(settled).not.toHaveBeenCalled()
    drop()
    await flush()
    expect(settled).not.toHaveBeenCalled()
    ready()
    await flush()
    expect(settled).toHaveBeenCalledTimes(1)
    await subscription
  })

  it("refetches after a first ready that arrives beyond the readiness timeout", async () => {
    const t = recoveryTransport()
    const resync = vi.fn()
    t.onReconnect(resync)
    const subscription = t.subscribe("folders://changed", vi.fn())
    await flush()
    await vi.advanceTimersByTimeAsync(5_000)
    await subscription
    expect(resync).not.toHaveBeenCalled()
    ready()
    expect(resync).toHaveBeenCalledTimes(1)
  })

  it("accepts a snapshot when the server cannot replay the gap", async () => {
    const t = recoveryTransport()
    const h = handlers()
    const sub = t.eventStream().attach("session-1", { sinceSeq: 300 }, h)
    await flush()
    ready()
    drop()
    ready()
    const snapshot = { live_message: { content: "recovered persisted turn" } }
    emit({
      type: "snapshot",
      subscription_id: sub.subscriptionId,
      connection_id: "session-1",
      snapshot,
      event_seq: 2,
    })
    expect(h.onSnapshot).toHaveBeenCalledWith(snapshot, 2)
    drop()
    ready()
    expect(latestSentFrame().since_seq).toBe(2)
  })

  it("does not resurrect detached conversations on reconnect", async () => {
    const t = recoveryTransport()
    const h = handlers()
    const sub = t.eventStream().attach("session-1", {}, h)
    await flush()
    ready()
    drop()
    sub.detach()
    ready()
    expect(sentFrames()).toHaveLength(1)
    emit({ type: "event", subscription_id: sub.subscriptionId, envelope: {} })
    expect(h.onEvent).not.toHaveBeenCalled()
  })

  it("keeps windows of different remote connections isolated", async () => {
    const a = recoveryTransport()
    const b = recoveryTransport({ id: 8, windowInstanceId: "rw-other" })
    const updateA = vi.fn()
    const updateB = vi.fn()
    const subA = a.subscribe("folders://changed", updateA)
    const subB = b.subscribe("folders://changed", updateB)
    await flush()
    ready()
    ready(8)
    await Promise.all([subA, subB])
    drop()
    emit({ channel: "folders://changed", payload: "B" }, 8)
    ready()
    emit({ channel: "folders://changed", payload: "A" })
    expect(updateA.mock.calls).toEqual([["A"]])
    expect(updateB.mock.calls).toEqual([["B"]])
  })

  it("coalesces failed attach sends and cancels retry after destroy", async () => {
    const t = recoveryTransport()
    const stream = t.eventStream()
    stream.attach("session-1", {}, handlers())
    stream.attach("session-2", {}, handlers())
    await flush()
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "remote_ws_send_text") throw { code: "network_error" }
    })
    ready()
    await flush()
    expect(sentFrames()).toHaveLength(2)
    // Both failures share one retry: a single reattach of both sessions.
    await vi.advanceTimersByTimeAsync(200)
    expect(sentFrames()).toHaveLength(4)
    t.destroy()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sentFrames()).toHaveLength(4)
  })

  it("releases an IPC listener that arrives after its window was destroyed", async () => {
    let finishListen!: (unlisten: () => void) => void
    mocks.listen.mockImplementation(
      () => new Promise((resolve) => (finishListen = resolve))
    )
    const t = recoveryTransport()
    const settled = vi.fn()
    const subscription = t.subscribe("folders://changed", vi.fn()).then(settled)
    t.destroy()
    const unlisten = vi.fn()
    finishListen(unlisten)
    await flush()
    expect(unlisten).toHaveBeenCalledTimes(1)
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "remote_ws_subscribe",
      expect.anything()
    )
    expect(settled).toHaveBeenCalledTimes(1)
    await subscription
  })
})
